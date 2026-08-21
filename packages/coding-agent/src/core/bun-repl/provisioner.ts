import { getLogger } from "@earendil-works/pi-ai";
import { type BunReplHostRequestHandler, BunReplManager, type BunReplManagerOptions } from "./index.js";
import { snapshotExists } from "./state-snapshot.js";

const log = getLogger("coding-agent.bun-repl");

/** How long a kernel may sit idle before it is disposed and its state snapshotted. */
export const DEFAULT_REPL_IDLE_TIMEOUT_MS = 600_000;

/**
 * Time source for idle reaping, injectable so tests can drive the timer deterministically.
 */
export interface IdleReapClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const defaultIdleReapClock: IdleReapClock = {
	now: () => Date.now(),
	setTimeout,
	clearTimeout,
};

/**
 * Arms the idle timer after activity settles and cancels it when activity resumes.
 *
 * Timestamps come from the clock, not from timer identity: arming computes the time
 * still remaining since the last touch, so a timer armed late (event-loop delay, a cell
 * that ended while the arm was queued) never waits longer than the configured timeout.
 */
export class IdleReapScheduler {
	private handle: unknown;
	private lastActivityAt: number;

	constructor(private readonly options: { timeoutMs: number; clock: IdleReapClock; onExpire: () => void }) {
		this.lastActivityAt = options.clock.now();
	}

	get armed(): boolean {
		return this.handle !== undefined;
	}

	/** Activity resumed (a cell is starting): reset the timestamp and cancel any pending reap. */
	touch(): void {
		this.lastActivityAt = this.options.clock.now();
		this.disarm();
	}

	/** Activity settled (a cell ended): schedule the reap, relative to the last touch. */
	arm(): void {
		if (this.options.timeoutMs <= 0 || this.armed) return;
		const elapsed = this.options.clock.now() - this.lastActivityAt;
		const remaining = Math.max(0, this.options.timeoutMs - elapsed);
		this.handle = this.options.clock.setTimeout(() => {
			this.handle = undefined;
			this.options.onExpire();
		}, remaining);
	}

	disarm(): void {
		if (this.handle === undefined) return;
		this.options.clock.clearTimeout(this.handle);
		this.handle = undefined;
	}
}

export interface BunReplProvisionerOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: Record<string, BunReplHostRequestHandler>;
	snapshotDir?: string;
	bunPath?: string;
	/** Custom shell binary for bare %%bash cells (defaults to "bash"). */
	shellPath?: string;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	readyGate?: Promise<void>;
	onRestore?: (restore: { restoredNames: string[]; failed: string[] }) => void;
	/** Called when a cell's agent message arrives after that cell's result. */
	onLateSentAgentMessage?: BunReplManagerOptions["onLateSentAgentMessage"];
	/**
	 * Idle time before the kernel process is disposed (after a final snapshot); the next
	 * use starts a fresh kernel that restores from the snapshot. 0 disables reaping.
	 * Defaults to DEFAULT_REPL_IDLE_TIMEOUT_MS. Reaping requires a snapshotDir: without
	 * one there is nothing to restore from, so disposal would silently destroy state.
	 */
	idleTimeoutMs?: number;
	/** Injectable clock/timers for tests. */
	clock?: IdleReapClock;
}

export class BunReplProvisioner {
	private managerPromise?: Promise<BunReplManager>;
	private startedManager?: BunReplManager;
	private _lastRestore?: { restoredNames: string[]; failed: string[] };
	private readonly disposeController = new AbortController();
	private readonly idleReap: IdleReapScheduler;

	constructor(private readonly options: BunReplProvisionerOptions) {
		const timeoutMs = options.idleTimeoutMs ?? DEFAULT_REPL_IDLE_TIMEOUT_MS;
		// Without a snapshot dir the namespace dies with the process and nothing restores
		// it, so an idle reap would be silent data loss rather than a transparent restart.
		this.idleReap = new IdleReapScheduler({
			timeoutMs: options.snapshotDir ? timeoutMs : 0,
			clock: options.clock ?? defaultIdleReapClock,
			onExpire: () => void this.reapIdleKernel(),
		});
	}

	get manager(): BunReplManager | undefined {
		return this.startedManager;
	}

	get lastRestore(): { restoredNames: string[]; failed: string[] } | undefined {
		return this._lastRestore;
	}

	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	async listNamespaceNames(_signal?: AbortSignal): Promise<string[] | null> {
		this.idleReap.touch();
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames()) ?? null;
	}

	async dispose(): Promise<void> {
		this.idleReap.disarm();
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// failed startup already cleaned up
		}
	}

	async kill(): Promise<void> {
		this.idleReap.disarm();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// failed startup already cleaned up
		}
	}

	async ensure(signal?: AbortSignal): Promise<BunReplManager> {
		if (signal?.aborted) {
			throw new Error("Aborted");
		}

		// A cell is about to run (or the kernel is being asked for): hold off any pending reap.
		// If the kernel was already reaped, the restart below restores from the snapshot.
		this.idleReap.touch();

		if (!this.managerPromise) {
			const startup = this.startRepl(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
						// A fresh kernel is idle from birth; an unused prewarm should still be reaped.
						this.idleReap.touch();
						this.idleReap.arm();
					}
				},
				() => {
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
				},
			);
		}

		return this.managerPromise;
	}

	/**
	 * Dispose the kernel after an idle timeout.
	 *
	 * This must happen at the provisioner level, not by restarting the manager in place:
	 * BunReplManager.start() never restores state, so only a fresh manager (created by the
	 * next ensure()) revives the snapshot. The restart is transparent except for the
	 * snapshot's known lossiness: values the snapshot could not capture are reported in
	 * lastRestore.failed and are simply gone. Safe against a concurrent cell: the timer is
	 * disarmed on every cell start, so it cannot fire while a cell runs.
	 */
	private async reapIdleKernel(): Promise<void> {
		if (!this.managerPromise || !this.startedManager?.isRunning) return;
		log.debug("disposing idle Bun REPL kernel", {
			idleTimeoutMs: this.options.idleTimeoutMs ?? DEFAULT_REPL_IDLE_TIMEOUT_MS,
			snapshotDir: this.options.snapshotDir,
		});
		await this.dispose();
	}

	private async startRepl(signal?: AbortSignal): Promise<BunReplManager> {
		const managerOptions: BunReplManagerOptions = {
			cwd: this.options.cwd,
			env: this.options.env,
			hostHandlers: this.options.hostHandlers,
			snapshotDir: this.options.snapshotDir,
			bunPath: this.options.bunPath,
			shellPath: this.options.shellPath,
			commandPrefix: this.options.commandPrefix,
			onLateSentAgentMessage: this.options.onLateSentAgentMessage,
			onCellStart: () => this.idleReap.touch(),
			onCellEnd: () => this.idleReap.arm(),
		};

		const manager = new BunReplManager(managerOptions);

		try {
			if (this.options.readyGate) {
				await this.options.readyGate.catch(() => {});
			}

			await manager.start(signal);

			if (this.options.snapshotDir) {
				const hasSnapshot = await snapshotExists(this.options.snapshotDir);
				if (hasSnapshot) {
					const restore = await manager.restoreState();
					if (restore) {
						this._lastRestore = restore;
						this.options.onRestore?.(restore);
					}
				}
			}

			return manager;
		} catch (error) {
			void manager.dispose();
			throw error;
		}
	}
}
