/**
 * Shared measurement helpers for the bench suite. Everything here is Bun-native
 * and offline: no network, no provider calls, no Node.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..", "..");
export const codingAgentDir = join(repoRoot, "packages", "coding-agent");

export interface Sample {
	p50: number;
	p95: number;
	min: number;
	max: number;
	runs: number;
}

export function summarize(values: number[]): Sample {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
	return {
		p50: round(at(50)),
		p95: round(at(95)),
		min: round(sorted[0] ?? 0),
		max: round(sorted[sorted.length - 1] ?? 0),
		runs: sorted.length,
	};
}

export function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Recursive byte size of a directory, or 0 when it does not exist. */
export async function dirSize(path: string): Promise<number> {
	const glob = new Bun.Glob("**/*");
	let total = 0;
	try {
		for await (const entry of glob.scan({ cwd: path, onlyFiles: true, dot: true })) {
			try {
				total += statSync(join(path, entry)).size;
			} catch {
				// raced away between scan and stat: ignore
			}
		}
	} catch {
		return 0;
	}
	return total;
}

export function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Non-blank, non-comment source lines under a directory, by extension. */
export async function sourceLoc(dir: string, extensions: readonly string[]): Promise<number> {
	const glob = new Bun.Glob(`**/*.{${extensions.join(",")}}`);
	let total = 0;
	for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
		const text = await Bun.file(join(dir, entry)).text();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
			total += 1;
		}
	}
	return total;
}

export function mb(bytes: number): number {
	return round(bytes / 1024 / 1024);
}
