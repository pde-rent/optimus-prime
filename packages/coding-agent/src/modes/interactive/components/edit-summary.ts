import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditToolDetails } from "../../../core/tools/edit.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import type { SedToolDetails } from "../../../core/tools/native/sed.js";
import { resolveToCwd } from "../../../core/tools/path-utils.js";
import type { ReplToolDetails } from "../../../core/tools/repl-types.js";
import type { WriteFileToolDetails } from "../../../core/tools/write-file.js";
import { canonicalizePath, formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.js";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";

export interface FileChangeSummary {
	path: string;
	added: number;
	removed: number;
}

export function countChangedLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function mergeFileChange(target: Map<string, FileChangeSummary>, change: FileChangeSummary, cwd: string): void {
	if (change.added === 0 && change.removed === 0) return;
	const key = canonicalizePath(resolveToCwd(change.path, cwd));
	const existing = target.get(key);
	if (existing) {
		existing.added += change.added;
		existing.removed += change.removed;
	} else {
		target.set(key, { ...change });
	}
}

export function getToolFileChanges(
	toolName: string,
	args: unknown,
	result: { details?: unknown; isError: boolean },
	cwd: string,
): FileChangeSummary[] {
	const changes = new Map<string, FileChangeSummary>();
	if (toolName === "repl") {
		for (const display of (result.details as ReplToolDetails | undefined)?.diffs ?? []) {
			const { diff } = generateDiffString(display.oldStr, display.newStr, 4, display.startLine ?? 1);
			mergeFileChange(changes, { path: display.path, ...countChangedLines(diff) }, cwd);
		}
	} else if (toolName === "edit" && !result.isError) {
		const editArgs = args as { path?: unknown; file_path?: unknown } | undefined;
		const path = typeof editArgs?.path === "string" ? editArgs.path : editArgs?.file_path;
		const diff = (result.details as EditToolDetails | undefined)?.diff;
		if (typeof path === "string" && diff) {
			mergeFileChange(changes, { path, ...countChangedLines(diff) }, cwd);
		}
	} else if (toolName === "write_file" && !result.isError) {
		const writeArgs = args as { path?: unknown } | undefined;
		const details = result.details as WriteFileToolDetails | undefined;
		if (typeof writeArgs?.path === "string" && details?.diff) {
			mergeFileChange(changes, { path: writeArgs.path, ...countChangedLines(details.diff) }, cwd);
		}
	} else if (toolName === "sed" && !result.isError) {
		const sedArgs = args as { path?: unknown } | undefined;
		const details = result.details as SedToolDetails | undefined;
		// Dry runs report a diff but write nothing, so they are not changes.
		if (typeof sedArgs?.path === "string" && details?.applied && details.diff) {
			mergeFileChange(changes, { path: sedArgs.path, ...countChangedLines(details.diff) }, cwd);
		}
	}
	return [...changes.values()];
}

export function mergeTurnFileChanges(
	target: Map<string, FileChangeSummary>,
	message: AgentMessage,
	toolResults: readonly ToolResultMessage[],
	cwd: string,
): void {
	if (message.role !== "assistant") return;
	const calls = new Map(
		message.content.filter((content) => content.type === "toolCall").map((content) => [content.id, content] as const),
	);
	for (const result of toolResults) {
		const call = calls.get(result.toolCallId);
		if (!call) continue;
		for (const change of getToolFileChanges(call.name, call.arguments, result, cwd)) {
			mergeFileChange(target, change, cwd);
		}
	}
}

/** Dim gutter that anchors every per-file change summary line. */
export const FILE_CHANGE_SUMMARY_PREFIX = "    ╰─ ";
/** Indent that aligns diff rows with the summary line's text column. */
export const FILE_CHANGE_DIFF_INDENT = " ".repeat(visibleWidth(FILE_CHANGE_SUMMARY_PREFIX));

function formatChangeCounts(change: Pick<FileChangeSummary, "added" | "removed">): string {
	return `${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `-${change.removed}`)}`;
}

function formatFileChangePath(path: string, cwd: string): string {
	const resolvedPath = resolveToCwd(path, cwd);
	const lexicalPath = formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd);
	if (!isAbsolute(lexicalPath)) return lexicalPath;
	return formatPathRelativeToCwdOrAbsolute(canonicalizePath(resolvedPath), canonicalizePath(cwd));
}

/**
 * One `    ╰─ <path> +N -M` row, truncated to width; the path renders relative
 * to cwd where possible and the hint renders only when diffsExpanded is defined.
 */
export function formatFileChangeSummaryLine(
	rawPath: string,
	cwd: string | undefined,
	change: Pick<FileChangeSummary, "added" | "removed">,
	diffsExpanded: boolean | undefined,
	width: number,
): string {
	const prefix = theme.fg("dim", FILE_CHANGE_SUMMARY_PREFIX);
	const hint =
		diffsExpanded === undefined
			? ""
			: `${theme.fg("dim", " · ")}${expandCollapseHint("app.edits.expand", diffsExpanded)}`;
	// Size the path against the wider hint variant ("to collapse") so toggling
	// ctrl+j never re-truncates it — the summary line is a stable anchor.
	const widestHint =
		diffsExpanded === undefined ? "" : `${theme.fg("dim", " · ")}${expandCollapseHint("app.edits.expand", true)}`;
	const counts = `${theme.fg("dim", " ")}${formatChangeCounts(change)}`;
	const suffix = `${counts}${hint}`;
	const safeWidth = Math.max(1, width);
	const available = Math.max(1, safeWidth - visibleWidth(prefix) - visibleWidth(counts) - visibleWidth(widestHint));
	const displayPath = cwd === undefined ? rawPath : formatFileChangePath(rawPath, cwd);
	const path = truncateToWidth(displayPath, available, "…");
	return truncateToWidth(`${prefix}${theme.fg("muted", path)}${suffix}`, safeWidth, "");
}

export function formatTotalChangeSummary(changes: readonly FileChangeSummary[]): string {
	const totals = changes.reduce(
		(sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }),
		{ added: 0, removed: 0 },
	);
	const files = `${changes.length} file${changes.length === 1 ? "" : "s"} changed`;
	return `${theme.fg("muted", files)}${theme.fg("dim", " | ")}${formatChangeCounts(totals)}`;
}

/** One unified diff attached to a tool result, keyed by the file it changes. */
export interface ToolResultDiff {
	path: string;
	diff: string;
}

/**
 * Unified diffs carried by a tool result for the mutating built-ins
 * (edit, write_file, applied sed) and repl cells. Empty for reads, dry runs,
 * errors, and created files without a diff.
 */
export function getToolResultDiffs(
	toolName: string,
	args: unknown,
	result: { details?: unknown; isError: boolean },
): ToolResultDiff[] {
	if (result.isError || !result.details || typeof result.details !== "object") {
		return [];
	}
	const details = result.details as Record<string, unknown>;
	const argPath = (args as { path?: unknown; file_path?: unknown } | undefined)?.path;
	const path = typeof argPath === "string" ? argPath : undefined;
	const asDiff = (rawPath: string | undefined, diff: unknown): ToolResultDiff | undefined =>
		rawPath !== undefined && typeof diff === "string" && diff.length > 0 ? { path: rawPath, diff } : undefined;

	if (toolName === "repl") {
		return ((details as ReplToolDetails).diffs ?? []).map((display) => ({
			path: display.path,
			diff: generateDiffString(display.oldStr, display.newStr, 4, display.startLine ?? 1).diff,
		}));
	}
	if (toolName === "edit" || toolName === "write_file") {
		const diff = asDiff(path, details.diff);
		return diff ? [diff] : [];
	}
	if (toolName === "sed" && details.applied === true) {
		const diff = asDiff(path, details.diff);
		return diff ? [diff] : [];
	}
	return [];
}

/**
 * One-line outcome label for a mutating tool result in compact views:
 * `Edited <path> +N -M`, or `Created <path>` for newly written files.
 * Undefined when the result is not a file change.
 */
export function formatToolResultChangeLabel(
	toolName: string,
	args: unknown,
	result: { details?: unknown; isError: boolean },
	cwd: string | undefined,
): string | undefined {
	if (result.isError) {
		return undefined;
	}
	const changes = getToolFileChanges(toolName, args, result, cwd ?? process.cwd());
	const counts = changes.reduce(
		(sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }),
		{ added: 0, removed: 0 },
	);
	if (changes.length === 0) {
		const created =
			toolName === "write_file" &&
			(result.details as { created?: unknown } | undefined)?.created === true &&
			typeof (args as { path?: unknown } | undefined)?.path === "string"
				? ((args as { path?: unknown }).path as string)
				: undefined;
		if (!created) {
			return undefined;
		}
		return `${theme.fg("success", "Created ")}${theme.fg("muted", created)}`;
	}
	const target =
		changes.length === 1
			? cwd === undefined
				? changes[0].path
				: formatFileChangePath(changes[0].path, cwd)
			: `${changes.length} files`;
	return `${theme.fg("success", "Edited ")}${theme.fg("muted", target)} ${theme.fg("dim", " ")}${theme.fg("toolDiffAdded", `+${counts.added}`)} ${theme.fg("toolDiffRemoved", `-${counts.removed}`)}`;
}
