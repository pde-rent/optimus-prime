/**
 * "Faster" metrics: REPL cold start, REPL fan-out, and CLI process start.
 *
 * All offline. The CLI number uses `--version`, which exercises process spawn +
 * module graph load but NOT session/provider setup — it is a floor on cold start,
 * not a full time-to-first-prompt. A scripted mock-provider turn is still missing;
 * see scripts/bench/README.md.
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplManager } from "../../packages/coding-agent/src/core/bun-repl/index.ts";
import { codingAgentDir, type Sample, round, summarize } from "./metrics.ts";

export interface SpeedMetrics {
	replStartMs: Sample;
	replFirstCellMs: Sample;
	replFanOut: { concurrency: number; wallMs: number; failures: number };
	cliVersionMs: Sample | null;
	replRssMb: number | null;
}

const tempDirs: string[] = [];

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bench-"));
	tempDirs.push(dir);
	return dir;
}

function cleanup(): void {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

async function measureRepl(runs: number): Promise<{ start: number[]; firstCell: number[] }> {
	const start: number[] = [];
	const firstCell: number[] = [];
	for (let i = 0; i < runs; i += 1) {
		const manager = new BunReplManager({ cwd: tempCwd() });
		const t0 = performance.now();
		await manager.start();
		start.push(performance.now() - t0);
		const t1 = performance.now();
		await manager.execute("1 + 1");
		firstCell.push(performance.now() - t1);
		await manager.dispose();
	}
	return { start, firstCell };
}

async function measureFanOut(concurrency: number): Promise<{ wallMs: number; failures: number }> {
	const managers = Array.from({ length: concurrency }, () => new BunReplManager({ cwd: tempCwd() }));
	const t0 = performance.now();
	const results = await Promise.allSettled(managers.map((manager) => manager.start()));
	const wallMs = performance.now() - t0;
	await Promise.allSettled(managers.map((manager) => manager.dispose()));
	return { wallMs: round(wallMs), failures: results.filter((r) => r.status === "rejected").length };
}

async function measureCli(runs: number): Promise<Sample | null> {
	const entry = join(codingAgentDir, "dist", "bundle", "cli.js");
	if (!existsSync(entry)) return null;
	const timings: number[] = [];
	for (let i = 0; i < runs; i += 1) {
		const t0 = performance.now();
		const proc = Bun.spawn(["bun", entry, "--version"], { stdout: "pipe", stderr: "pipe" });
		await proc.exited;
		timings.push(performance.now() - t0);
	}
	return summarize(timings);
}

/** Steady-state RSS of one idle REPL child, in MB. */
async function measureReplRss(): Promise<number | null> {
	const manager = new BunReplManager({ cwd: tempCwd() });
	await manager.start();
	await manager.execute("1 + 1");
	try {
		const pid = (manager as unknown as { _child?: { pid?: number } })._child?.pid;
		if (!pid) return null;
		const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe" });
		const out = (await new Response(proc.stdout).text()).trim();
		const kb = Number.parseInt(out, 10);
		return Number.isFinite(kb) ? round(kb / 1024) : null;
	} finally {
		await manager.dispose();
	}
}

export async function measureSpeed(options: { runs?: number; concurrency?: number } = {}): Promise<SpeedMetrics> {
	const runs = options.runs ?? 5;
	const concurrency = options.concurrency ?? 8;
	try {
		const repl = await measureRepl(runs);
		const replRssMb = await measureReplRss();
		const replFanOut = { concurrency, ...(await measureFanOut(concurrency)) };
		const cliVersionMs = await measureCli(Math.min(runs, 3));
		return {
			replStartMs: summarize(repl.start),
			replFirstCellMs: summarize(repl.firstCell),
			replFanOut,
			cliVersionMs,
			replRssMb,
		};
	} finally {
		cleanup();
	}
}

export function formatSpeed(metrics: SpeedMetrics): string[] {
	const sample = (label: string, value: Sample | null) =>
		value ? `${label} p50 ${value.p50}ms · p95 ${value.p95}ms (${value.runs} runs)` : `${label} not measured`;
	return [
		sample("REPL start        ", metrics.replStartMs),
		sample("REPL first cell   ", metrics.replFirstCellMs),
		sample("CLI --version     ", metrics.cliVersionMs),
		`REPL idle RSS      ${metrics.replRssMb === null ? "not measured" : `${metrics.replRssMb} MB`}`,
		`REPL fan-out       ${metrics.replFanOut.concurrency} concurrent in ${metrics.replFanOut.wallMs}ms · ${metrics.replFanOut.failures} failures`,
	];
}
