/**
 * "Lighter" metrics: shipped artifact size, dependency surface, source LOC.
 * Pure filesystem inspection — safe to run in CI without a build, though the
 * bundle/binary numbers are 0 until `bun run build` / `build:binary` has run.
 */
import { join } from "node:path";
import { codingAgentDir, dirSize, fileSize, mb, repoRoot, sourceLoc } from "./metrics.ts";

export interface SizeMetrics {
	bundleBytes: number;
	distBytes: number;
	binaryBytes: number;
	nodeModulesBytes: number;
	runtimeDeps: Record<string, number>;
	runtimeDepsTotal: number;
	sourceLoc: Record<string, number>;
	sourceLocTotal: number;
}

const PACKAGES = ["agent", "ai", "coding-agent", "tui"] as const;

async function runtimeDepCount(pkg: string): Promise<number> {
	const manifestPath = join(repoRoot, "packages", pkg, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	// devDependencies are excluded on purpose: they never reach a user's machine.
	return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).length;
}

export async function measureSize(): Promise<SizeMetrics> {
	const runtimeDeps: Record<string, number> = {};
	const loc: Record<string, number> = {};
	for (const pkg of PACKAGES) {
		runtimeDeps[pkg] = await runtimeDepCount(pkg);
		loc[pkg] = await sourceLoc(join(repoRoot, "packages", pkg, "src"), ["ts", "tsx"]);
	}
	loc.skills = await sourceLoc(join(codingAgentDir, "skills"), ["js"]);

	const sum = (record: Record<string, number>) => Object.values(record).reduce((a, b) => a + b, 0);

	return {
		bundleBytes: await dirSize(join(codingAgentDir, "dist", "bundle")),
		distBytes: await dirSize(join(codingAgentDir, "dist")),
		binaryBytes: fileSize(join(codingAgentDir, "dist", "pi")),
		nodeModulesBytes: await dirSize(join(repoRoot, "node_modules")),
		runtimeDeps,
		runtimeDepsTotal: sum(runtimeDeps),
		sourceLoc: loc,
		sourceLocTotal: sum(loc),
	};
}

export function formatSize(metrics: SizeMetrics): string[] {
	return [
		`bundle            ${mb(metrics.bundleBytes)} MB`,
		`dist (unbundled)  ${mb(metrics.distBytes)} MB`,
		`compiled binary   ${metrics.binaryBytes ? `${mb(metrics.binaryBytes)} MB` : "not built"}`,
		`node_modules      ${mb(metrics.nodeModulesBytes)} MB`,
		`runtime deps      ${metrics.runtimeDepsTotal} (${Object.entries(metrics.runtimeDeps)
			.map(([pkg, count]) => `${pkg}:${count}`)
			.join(" ")})`,
		`source LOC        ${metrics.sourceLocTotal} (${Object.entries(metrics.sourceLoc)
			.map(([pkg, count]) => `${pkg}:${count}`)
			.join(" ")})`,
	];
}
