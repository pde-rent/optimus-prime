/**
 * Unified temp-dir fixture builder. Every suite that made its own mkdtemp +
 * cleanup-list boilerplate uses this instead.
 */
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a fresh mkdtemp directory the caller must remove (for sync test bodies). */
export function tempDir(label = "optimus-test-"): string {
	return mkdtempSync(join(tmpdir(), label));
}

/** Runs fn with a fresh temp dir and removes it afterwards. */
export async function withTempDir<T>(label: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
	const dir = tempDir(label);
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A tracked temp-dir factory wired to afterEach: every dir it creates is removed
 * automatically when the current test finishes. One line replaces the per-suite
 * cleanupPaths array + afterEach rmSync ritual.
 */
export function makeTempDirs(prefix = "optimus-test-"): { create(): string; dirs: string[] } {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) {
			const dir = dirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});
	return {
		dirs,
		create(): string {
			const dir = tempDir(prefix);
			dirs.push(dir);
			return dir;
		},
	};
}
