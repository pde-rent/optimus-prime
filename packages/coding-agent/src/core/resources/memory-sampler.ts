/**
 * Cheap system memory sampling for resource-aware subagent admission.
 *
 * The sampler polls the OS at most once per cache TTL (default 10s) and answers
 * repeated admissions from cache, so spawn-time reads stay off the hot path.
 * All I/O is injectable for tests: pass fake command output and file contents.
 */

export interface MemorySample {
	/** Physically installed RAM. */
	totalBytes: number;
	/** Memory usable right now without swapping (free + reclaimable). */
	availableBytes: number;
}

export type CommandRunner = (file: string, args: string[]) => Promise<string>;
export type TextFileReader = (path: string) => Promise<string>;

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

export const DEFAULT_MEMORY_SAMPLE_TTL_MS = 10_000;

const execFile = promisify(execFileCb);

async function defaultRun(file: string, args: string[]): Promise<string> {
	const { stdout } = await execFile(file, args, { encoding: "utf8", timeout: 5_000 });
	return stdout;
}

async function defaultReadFile(path: string): Promise<string> {
	return await Bun.file(path).text();
}

function parseDarwinTotalBytes(output: string): number {
	const value = Number.parseInt(output.trim(), 10);
	if (!Number.isFinite(value) || value <= 0) throw new Error("could not parse sysctl hw.memsize output");
	return value;
}

function readPageCount(output: string, label: string): number {
	// vm_stat prints counts with a trailing period, e.g. "Pages free: 3822.".
	const match = new RegExp(`${label.replace(/ /g, "\\:")}:\\s+([0-9]+)\\.`).exec(output);
	return match ? Number.parseInt(match[1]!, 10) : 0;
}

/** Available ~= (free + speculative + purgeable) pages. Inactive pages are reclaimable file cache but not instantly free, so they are left out of this conservative estimate. */
export function parseDarwinVmStat(output: string): { pageSizeBytes: number; availableBytes: number } {
	const sizeMatch = /page size of ([0-9]+)/.exec(output);
	if (!sizeMatch) throw new Error("vm_stat output missing page size");
	const pageSizeBytes = Number.parseInt(sizeMatch[1]!, 10);
	let availablePages = 0;
	for (const label of ["Pages free", "Pages speculative", "Pages purgeable"]) {
		availablePages += readPageCount(output, label);
	}
	return { pageSizeBytes, availableBytes: availablePages * pageSizeBytes };
}

export function parseLinuxMemInfo(output: string): { totalBytes: number; availableBytes: number } {
	const read = (field: string): number => {
		const match = new RegExp(`${field}:\\s+([0-9]+) kB`).exec(output);
		if (!match) throw new Error(`/proc/meminfo missing ${field}`);
		return Number.parseInt(match[1]!, 10) * 1024;
	};
	return { totalBytes: read("MemTotal"), availableBytes: read("MemAvailable") };
}

export interface SystemMemorySamplerOptions {
	now?: () => number;
	cacheTtlMs?: number;
	run?: CommandRunner;
	readFile?: TextFileReader;
	platform?: NodeJS.Platform;
}

export class SystemMemorySampler {
	private cached: { sample: MemorySample; atMs: number } | undefined;
	private readonly now: () => number;
	private readonly cacheTtlMs: number;
	private readonly run: CommandRunner;
	private readonly readFile: TextFileReader;
	private readonly platform: NodeJS.Platform;

	constructor(options: SystemMemorySamplerOptions = {}) {
		this.now = options.now ?? Date.now;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_MEMORY_SAMPLE_TTL_MS;
		this.run = options.run ?? defaultRun;
		this.readFile = options.readFile ?? defaultReadFile;
		this.platform = options.platform ?? process.platform;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	async sample(): Promise<MemorySample> {
		const nowMs = this.now();
		if (this.cached && nowMs - this.cached.atMs < this.cacheTtlMs) return this.cached.sample;
		const sample = await this.readSample();
		this.cached = { sample, atMs: nowMs };
		return sample;
	}

	private async readSample(): Promise<MemorySample> {
		if (this.platform === "darwin") {
			const [totalOutput, vmStatOutput] = await Promise.all([
				this.run("sysctl", ["-n", "hw.memsize"]),
				this.run("vm_stat", []),
			]);
			const totalBytes = parseDarwinTotalBytes(totalOutput);
			const { availableBytes } = parseDarwinVmStat(vmStatOutput);
			return { totalBytes, availableBytes: Math.min(availableBytes, totalBytes) };
		}
		if (this.platform === "linux") {
			return parseLinuxMemInfo(await this.readFile("/proc/meminfo"));
		}
		throw new Error(`memory sampling unsupported on platform ${this.platform}`);
	}
}
