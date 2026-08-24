#!/usr/bin/env bun
/**
 * Startup profiling harness for the interactive coding agent.
 *
 * Modes:
 *   default  - runs `bun src/cli.ts` under a pseudo-tty with PI_TIMING=1
 *              PI_STARTUP_BENCHMARK=1, parses the "--- Startup Timings ---"
 *              block and reports per-phase min/median/max plus estimated
 *              time-to-first-render (cumulative phases up to init.firstRender).
 *   --e2e    - full interactive startup (no benchmark flag); measures wall time
 *              from spawn to the first alt-screen render byte ("chat visible").
 *
 * Usage:
 *   bun scripts/profile-startup.ts [--runs 5] [--cwd <dir>] [--e2e] [--json]
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		runs: { type: "string", default: "5" },
		cwd: { type: "string", default: "packages/coding-agent" },
		e2e: { type: "boolean", default: false },
		"agent-dir": { type: "string" },
		json: { type: "boolean", default: false },
	},
});

const RUNS = Math.max(1, Number(values.runs));
const E2E = values.e2e;
const AGENT_DIR = values["agent-dir"];
const APP_CWD = new URL("../" + values.cwd, import.meta.url).pathname;
const CAPTURE = "/tmp/optimus-profile-capture.txt";
const KILL_PID = "/tmp/optimus-profile-kill.pid";

interface RunResult {
	wallMs: number;
	phases: Array<[string, number]>;
	totalMs: number;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

async function runOnce(): Promise<RunResult> {
	const marker = E2E ? "[?1049h" : "--- Startup Timings ---";
	const envFlags = E2E ? {} : { PI_TIMING: "1", PI_STARTUP_BENCHMARK: "1" };
	rm(CAPTURE);
	rm(KILL_PID);
	// /usr/bin/script needs a tty-ish stdin, hence the sleep-fed pipe. The app's
	// stdout+stderr land in CAPTURE; script's pid lands in KILL_PID for teardown.
	const shell = `sleep 30 | /usr/bin/script -q '${CAPTURE}' bun src/cli.ts & echo $! > '${KILL_PID}'; wait`;
	const proc = Bun.spawn(["/bin/sh", "-c", shell], {
		cwd: APP_CWD,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env, ...envFlags, ...(AGENT_DIR ? { OPTIMUS_CODING_AGENT_DIR: AGENT_DIR } : {}) },
	});
	const t0 = performance.now();
	let text = "";
	let childExited = false;
	void proc.exited.then(() => {
		childExited = true;
	});
	while (!childExited) {
		await Bun.sleep(10);
		text = await Bun.file(CAPTURE).text().catch(() => "");
		if (text.includes(marker)) break;
	}
	const wallMs = performance.now() - t0;
	const pidText = await Bun.file(KILL_PID).text().catch(() => "");
	if (pidText.trim()) await Bun.$`kill ${pidText.trim()}`.quiet().catch(() => {});
	proc.kill();

	if (E2E) return { wallMs, phases: [], totalMs: Math.round(wallMs) };

	const start = text.indexOf("--- Startup Timings ---");
	if (start === -1) throw new Error("no startup timings found in capture");
	const end = text.indexOf("------------------------", start);
	const block = text.slice(start, end);
	const phases: Array<[string, number]> = [];
	let totalMs = 0;
	for (const line of block.split("\n")) {
		const m = line.match(/^\s+(.+?): (\d+)ms\s*$/);
		if (!m) continue;
		if (m[1] === "TOTAL") totalMs = Number(m[2]);
		else phases.push([m[1], Number(m[2])]);
	}
	return { wallMs, phases, totalMs };
}

function rm(path: string): void {
	try {
		require("node:fs").unlinkSync(path);
	} catch {}
}

function timeToFirstRender(phases: Array<[string, number]>): number {
	let sum = 0;
	for (const [label, ms] of phases) {
		sum += ms;
		if (label === "init.firstRender") break;
	}
	return sum;
}

const runs: RunResult[] = [];
for (let i = 0; i < RUNS; i++) {
	const r = await runOnce();
	runs.push(r);
	console.error(
		`run ${i + 1}/${RUNS}: ${
			E2E ? `first-render=${Math.round(r.wallMs)}ms` : `total=${r.totalMs}ms wall=${Math.round(r.wallMs)}ms`
		}`,
	);
}

if (values.json) {
	console.log(JSON.stringify({ runs }, null, 2));
	process.exit(0);
}

if (E2E) {
	const walls = runs.map((r) => Math.round(r.wallMs));
	console.log("");
	console.log(`interactive startup -> chat visible (${RUNS} runs):`);
	console.log(`  min ${Math.min(...walls)}ms   median ${median(walls)}ms   max ${Math.max(...walls)}ms`);
	process.exit(0);
}

const labelSet = new Set<string>();
for (const r of runs) for (const [l] of r.phases) labelSet.add(l);

console.log("");
console.log("phase                              min    med    max   (ms)");
console.log("---------------------------------  -----  -----  -----");
for (const label of labelSet) {
	const vals = runs.map((r) => r.phases.find(([l]) => l === label)?.[1] ?? 0);
	console.log(
		label.padEnd(34) +
			String(Math.min(...vals)).padStart(5) +
			String(median(vals)).padStart(6) +
			String(Math.max(...vals)).padStart(6),
	);
}
const totals = runs.map((r) => r.totalMs);
const ttfrs = runs.map((r) => timeToFirstRender(r.phases));
const walls = runs.map((r) => Math.round(r.wallMs));
console.log("---------------------------------  -----  -----  -----");
console.log(
	"TOTAL (main entry -> benchmark)".padEnd(34) +
		String(Math.min(...totals)).padStart(5) +
		String(median(totals)).padStart(6) +
		String(Math.max(...totals)).padStart(6),
);
console.log(
	"time-to-first-render (est.)".padEnd(34) +
		String(Math.min(...ttfrs)).padStart(5) +
		String(median(ttfrs)).padStart(6) +
		String(Math.max(...ttfrs)).padStart(6),
);
console.log(
	"wall (boot+imports+main)".padEnd(34) +
		String(Math.min(...walls)).padStart(5) +
		String(median(walls)).padStart(6) +
		String(Math.max(...walls)).padStart(6),
);
