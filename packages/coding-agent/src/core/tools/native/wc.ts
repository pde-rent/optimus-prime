import { readFileSync } from "node:fs";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { statSearchRoot, walkFiles } from "./walk.js";

const wcSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					'File or directory to count. Defaults to "." (the working directory). Directories are counted per file with a total row.',
			}),
		),
		include: Type.Optional(
			Type.String({ description: 'Only count files whose relative path matches this glob, e.g. "*.ts".' }),
		),
		exclude: Type.Optional(Type.String({ description: "Skip files whose relative path matches this glob." })),
	},
	{ additionalProperties: false },
);

export type WcToolInput = Static<typeof wcSchema>;

export interface WcToolDetails {
	lines: number;
	words: number;
	bytes: number;
	/** Number of files counted (1 for a single-file path). */
	fileCount: number;
	/** Whether the per-file table was truncated by the line/byte caps. */
	truncated: boolean;
}

interface WcCounts {
	lines: number;
	words: number;
	bytes: number;
}

function countText(text: string): Omit<WcCounts, "bytes"> {
	const newlineCount = (text.match(/\n/g) ?? []).length;
	const lines = newlineCount + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
	const words = text.split(/\s+/).filter(Boolean).length;
	return { lines, words };
}

/**
 * Count lines, words and bytes for a file or a whole directory tree,
 * entirely in-process.
 *
 * Use when you need a quick size overview - how big is this tree, which files
 * dominate it - not to inspect contents. node_modules, .git and gitignored
 * paths are skipped by design. Output mirrors wc(1) as "lines words bytes
 * path" rows plus a TOTAL row for directories, capped at 2000 lines / 50KB
 * with a truncation notice. A missing path fails with
 * "Could not search path: <path>. Error code: <code>."
 */
export function createWcToolDefinition(
	cwd: string,
	options?: { maxLines?: number; maxBytes?: number },
): ToolDefinition<typeof wcSchema, WcToolDetails> {
	const definition: ToolDefinition<typeof wcSchema, WcToolDetails> = {
		name: "wc",
		label: "wc",
		description:
			"Count lines, words and bytes per file plus tree totals - the default and fastest way to size up code; runs in-process on Windows/macOS/Linux; replaces bash wc. Skips node_modules, .git and gitignored paths. Not for reading content - use read_file.",
		promptSnippet: "Count lines/words/bytes per file and tree totals; not for reading - use read_file",
		parameters: wcSchema,
		executionMode: "parallel",
		kind: "search",
		read_only: true,
		renderCall(args, theme) {
			const path = args?.path ?? ".";
			return new Text(`${theme.fg("toolTitle", theme.bold("wc"))} ${theme.fg("accent", path)}`, 0, 0);
		},
		async execute(
			_toolCallId,
			input: WcToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: WcToolDetails }> {
			throwIfAborted(signal);

			const rootPath = resolveToCwd(input.path ?? ".", cwd);
			const stats = statSearchRoot(rootPath, input.path ?? ".");

			const targets = stats.isFile()
				? [{ absPath: rootPath, relPath: input.path ?? "." }]
				: walkFiles(rootPath, { include: input.include, exclude: input.exclude });

			const rows: string[] = [];
			let totalLines = 0;
			let totalWords = 0;
			let totalBytes = 0;

			for (const target of targets) {
				throwIfAborted(signal);
				let buffer: Buffer;
				try {
					buffer = readFileSync(target.absPath);
				} catch {
					continue; // Vanished between walk and read: skip.
				}
				const counts = countText(buffer.toString("utf-8"));
				totalLines += counts.lines;
				totalWords += counts.words;
				totalBytes += buffer.length;
				rows.push(`${counts.lines} ${counts.words} ${buffer.length} ${target.relPath}`);
			}

			if (targets.length > 1 || !stats.isFile()) {
				rows.push(`TOTAL ${totalLines} ${totalWords} ${totalBytes} (${rows.length} files)`);
			}

			const truncation = truncateHead(rows.join("\n"), { maxLines: options?.maxLines, maxBytes: options?.maxBytes });
			let text = truncation.content;
			if (truncation.truncated) {
				const reason = truncation.truncatedBy === "lines" ? "line limit" : "byte limit";
				text += `\n\n[Truncated at ${truncation.outputLines} of ${truncation.totalLines} rows (${reason} reached); totals cover ALL ${targets.length} files.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					lines: totalLines,
					words: totalWords,
					bytes: totalBytes,
					fileCount: targets.length,
					truncated: truncation.truncated,
				},
			};
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "wc" as const });
}

export function createWcTool(cwd: string, options?: { maxLines?: number; maxBytes?: number }) {
	return wrapToolDefinition(createWcToolDefinition(cwd, options));
}
