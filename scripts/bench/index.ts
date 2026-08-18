#!/usr/bin/env bun
/**
 * Bench runner. Offline, Bun-only.
 *
 *   bun run bench                          # print a report
 *   bun run bench --json bench.json        # also write machine-readable output
 *   bun run bench --check baseline.json    # fail on a regression vs a baseline
 *   bun run bench --runs 10 --concurrency 16
 *
 * `--check` is the CI guardrail: it compares the current run against a committed
 * baseline and exits non-zero when a tracked metric regresses beyond its tolerance.
 */
import { formatSize, measureSize, type SizeMetrics } from "./size.ts";
import { formatSpeed, measureSpeed, type SpeedMetrics } from "./speed.ts";

export interface BenchReport {
	size: SizeMetrics;
	speed: SpeedMetrics;
}

/**
 * Tracked regression budget. Sizes and counts are hard ceilings; timings get a
 * wider band because they are machine- and load-dependent — treat a timing
 * failure as "look at it", not as a proof of regression.
 */
const BUDGET: ReadonlyArray<{
	label: string;
	read: (report: BenchReport) => number;
	tolerance: number;
}> = [
	{ label: "bundle bytes", read: (r) => r.size.bundleBytes, tolerance: 0.05 },
	{ label: "runtime deps", read: (r) => r.size.runtimeDepsTotal, tolerance: 0 },
	{ label: "source LOC", read: (r) => r.size.sourceLocTotal, tolerance: 0.02 },
	{ label: "REPL start p95", read: (r) => r.speed.replStartMs.p95, tolerance: 0.5 },
];

function arg(name: string, fallback?: string): string | undefined {
	const index = Bun.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : (Bun.argv[index + 1] ?? fallback);
}

function checkAgainst(baseline: BenchReport, current: BenchReport): string[] {
	const failures: string[] = [];
	for (const metric of BUDGET) {
		const before = metric.read(baseline);
		const after = metric.read(current);
		if (before <= 0) continue;
		const ceiling = before * (1 + metric.tolerance);
		if (after > ceiling) {
			const delta = Math.round(((after - before) / before) * 1000) / 10;
			failures.push(`${metric.label}: ${before} -> ${after} (+${delta}%, budget +${metric.tolerance * 100}%)`);
		}
	}
	return failures;
}

const runs = Number(arg("runs", "5"));
const concurrency = Number(arg("concurrency", "8"));

const report: BenchReport = {
	size: await measureSize(),
	speed: await measureSpeed({ runs, concurrency }),
};

console.log("Lighter");
for (const line of formatSize(report.size)) console.log(`  ${line}`);
console.log("\nFaster");
for (const line of formatSpeed(report.speed)) console.log(`  ${line}`);

const jsonPath = arg("json");
if (jsonPath) {
	await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`\nwrote ${jsonPath}`);
}

const checkPath = arg("check");
if (checkPath) {
	const baseline = (await Bun.file(checkPath).json()) as BenchReport;
	const failures = checkAgainst(baseline, report);
	console.log("");
	if (failures.length === 0) {
		console.log(`no regression vs ${checkPath}`);
	} else {
		console.error(`regression vs ${checkPath}:`);
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
}
