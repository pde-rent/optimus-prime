import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compact elapsed-time label: s, m, h, d, w, and (when `maxUnit` is "year") y.
 */
export function formatElapsedDuration(seconds: number, maxUnit: "week" | "year" = "week"): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d`;
	}
	const weeks = Math.floor(days / 7);
	if (weeks < 52 || maxUnit === "week") {
		return `${weeks}w`;
	}
	return `${Math.floor(weeks / 52)}y`;
}
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const m = count / 1_000_000;
		return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
	}
	if (count >= 10_000) return `${Math.round(count / 1000)}k`;
	if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`;
	return count.toString();
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

export function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toPosixPath(p: string): string {
	return sep === "/" ? p : p.split(sep).join("/");
}

export function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const above = previous[rightIndex]!;
			previous[rightIndex] = Math.min(
				previous[rightIndex]! + 1,
				previous[rightIndex - 1]! + 1,
				diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[right.length]!;
}

export function writeJsonAtomically(path: string, value: unknown): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

export function formatTable<T extends Record<string, string>>(
	columns: Array<keyof T>,
	rows: T[],
	formatCell?: (row: T, column: keyof T, value: string) => string,
): string {
	const widths = columns.map((column) =>
		Math.max(String(column).length, ...rows.map((row) => String(row[column]).length)),
	);
	const lines = [columns.map((column, index) => String(column).padEnd(widths[index])).join("  ")];
	for (const row of rows) {
		const line = columns
			.map((column, index) => {
				const value = String(row[column]).padEnd(widths[index]);
				return formatCell ? formatCell(row, column, value) : value;
			})
			.join("  ");
		lines.push(line);
	}
	return lines.join("\n");
}

export function readJsonFile<T = unknown>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function safeJsonParse<T = unknown>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function isTruthyEnvVar(value: string | undefined): boolean {
	if (!value) return false;
	return (
		value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes" || value.toLowerCase() === "on"
	);
}

export function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}
