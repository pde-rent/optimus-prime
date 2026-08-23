import { isAbsolute, relative } from "node:path";
import { formatSize } from "./truncate.js";

/** Maximum number of paths accepted by the batch (paths[]) mode of read/head/tail. */
export const MAX_BATCH_PATHS = 16;
/** Total byte budget across all files in one batch call, unless the caller overrides it. */
export const BATCH_DEFAULT_MAX_BYTES = 100 * 1024;

export interface BatchFileEntry {
	/** Path exactly as the caller passed it, used for error strings and tables. */
	givenPath: string;
	/** Resolved absolute path. */
	absPath: string;
	bytes: number;
	mtimeMs: number;
}

/**
 * Newest-mtime-first greedy whole-file selection under a total byte budget.
 * Files that no longer fit are reported as overflow; nothing is partially read.
 */
export function selectWithinBudget(
	entries: BatchFileEntry[],
	budget: number,
): { fit: BatchFileEntry[]; overflow: BatchFileEntry[] } {
	const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.givenPath.localeCompare(b.givenPath));
	const fit: BatchFileEntry[] = [];
	const overflow: BatchFileEntry[] = [];
	let used = 0;
	for (const entry of sorted) {
		if (used + entry.bytes <= budget) {
			fit.push(entry);
			used += entry.bytes;
		} else {
			overflow.push(entry);
		}
	}
	return { fit, overflow };
}

/** "path: N bytes, mtime <ISO>" rows, one per file. */
export function formatBatchSizeTable(entries: BatchFileEntry[]): string {
	return entries
		.map((entry) => `${entry.givenPath}: ${entry.bytes} bytes, mtime ${new Date(entry.mtimeMs).toISOString()}`)
		.join("\n");
}

/** Exact error shown when the sizing pass leaves nothing to read. */
export function noFilesFitMessage(entries: BatchFileEntry[], budget: number): string {
	const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	return `No file fits within the ${formatSize(budget)} batch budget (${entries.length} files, ${formatSize(total)} total). Raise limitBytes or pass fewer paths.`;
}

/** Path relative to cwd when it lives inside cwd, absolute otherwise. */
export function displayPath(absPath: string, cwd: string): string {
	const rel = relative(cwd, absPath);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
		return rel;
	}
	return absPath;
}

/** "=== <relPath> (N bytes) ===" header rendered above each file in batch output. */
export function batchHeader(absPath: string, cwd: string, bytes: number): string {
	return `=== ${displayPath(absPath, cwd)} (${bytes} bytes) ===`;
}
