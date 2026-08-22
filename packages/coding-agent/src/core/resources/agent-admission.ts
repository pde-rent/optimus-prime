/**
 * Resource-aware admission control for concurrently running RLM subagents.
 *
 * A Mac that fans out unbounded child agents boots one REPL kernel and one
 * model session per child, which is how a memory-exhaustion crash happens.
 * The cap is computed from an actual memory sample, not a fixed constant, and
 * spawns over the cap queue FIFO and start as slots free. A fixed number in
 * settings ("maxRunningAgents") is the kill-switch: it bypasses sampling.
 */

import type { MemorySample } from "./memory-sampler.js";

export const DEFAULT_RESERVE_FRACTION = 0.25;
export const DEFAULT_RESERVE_ABSOLUTE_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_PER_AGENT_BUDGET_BYTES = 150 * 1024 * 1024;
export const DEFAULT_MAX_RUNNING_AGENTS_HARD_CAP = 10;

export type MaxRunningAgentsSetting = "auto" | number;

export interface AgentAdmissionConfig {
	/** RAM kept for the OS and the user's apps. Default: max(25% of total, 4GiB). */
	reserveBytes?: number | "auto";
	/** Conservative per-child footprint incl. its kernel share. Default: 150MiB. */
	perAgentBudgetBytes?: number;
	/** User-approved ceiling regardless of RAM. Default: 10. */
	hardCap?: number;
}

function clampPositiveInt(value: number, fallback: number, min = 1): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

export function resolveReserveBytes(sample: MemorySample, config: AgentAdmissionConfig = {}): number {
	if (typeof config.reserveBytes === "number" && Number.isFinite(config.reserveBytes)) {
		return Math.max(0, config.reserveBytes);
	}
	return Math.max(Math.ceil(sample.totalBytes * DEFAULT_RESERVE_FRACTION), DEFAULT_RESERVE_ABSOLUTE_BYTES);
}

/** maxAgents = clamp(floor((available - reserve) / perAgent), 1, hardCap). */
export function computeMaxRunningAgents(sample: MemorySample, config: AgentAdmissionConfig = {}): number {
	const hardCap = clampPositiveInt(
		config.hardCap ?? DEFAULT_MAX_RUNNING_AGENTS_HARD_CAP,
		DEFAULT_MAX_RUNNING_AGENTS_HARD_CAP,
	);
	const perAgent = clampPositiveInt(
		config.perAgentBudgetBytes ?? DEFAULT_PER_AGENT_BUDGET_BYTES,
		DEFAULT_PER_AGENT_BUDGET_BYTES,
	);
	const budgeted = Math.floor((sample.availableBytes - resolveReserveBytes(sample, config)) / perAgent);
	return Math.min(hardCap, Math.max(1, budgeted));
}

export interface AgentAdmissionPermit {
	/** Release the slot; the next queued spawn (FIFO) starts. */
	release(): void;
}

export interface AgentAdmissionStatus {
	queued: number;
	running: number;
	maxRunning: number;
}

interface QueuedWaiter {
	grant: (permit: AgentAdmissionPermit) => void;
	reject: (error: unknown) => void;
	isCancelled?: () => boolean;
}

export interface AgentAdmissionGateOptions {
	/** Cap provider; re-read at every admission so a settings change or fresh sample applies. */
	maxRunning: () => number | Promise<number>;
}

/**
 * FIFO admission gate. Spawns over the cap wait in queue order; a cancelled
 * waiter is skipped without ever consuming a slot. Running children are never
 * preempted when the cap shrinks — only new spawns are gated.
 */
export class AgentAdmissionGate {
	private running = 0;
	private readonly waiters: QueuedWaiter[] = [];
	private readonly maxRunningProvider: () => number | Promise<number>;

	constructor(options: AgentAdmissionGateOptions) {
		this.maxRunningProvider = options.maxRunning;
	}

	get runningCount(): number {
		return this.running;
	}

	get queueDepth(): number {
		return this.waiters.length;
	}

	async acquire(isCancelled?: () => boolean): Promise<AgentAdmissionPermit> {
		const cap = Math.max(1, await this.maxRunningProvider());
		if (this.running < cap) {
			this.running += 1;
			return this.createPermit();
		}
		return await new Promise<AgentAdmissionPermit>((grant, reject) => {
			this.waiters.push({ grant, reject, isCancelled });
		});
	}

	async status(): Promise<AgentAdmissionStatus> {
		return {
			queued: this.queueDepth,
			running: this.running,
			maxRunning: Math.max(1, await this.maxRunningProvider()),
		};
	}

	private createPermit(): AgentAdmissionPermit {
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.running -= 1;
				this.drain();
			},
		};
	}

	private drain(): void {
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			if (waiter.isCancelled?.()) {
				waiter.reject(new Error("RLM child cancelled while queued for admission"));
				continue;
			}
			this.running += 1;
			waiter.grant(this.createPermit());
			return;
		}
	}
}
