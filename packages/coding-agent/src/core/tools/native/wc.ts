import { readFileSync, type Stats, statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { walkFiles } from "./walk.js";

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

export interface WcCounts {
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
			'Count lines, words and bytes for one file or every regular file under a directory tree, without spawning a shell. Use it for size overviews ("how large is src/", "which files are biggest"); do not use it to inspect content or to count node_modules, .git or gitignored paths - they are skipped. Output is wc-style "lines words bytes path" rows plus a TOTAL row, capped at 2000 lines / 50KB with a truncation notice. A missing path fails with "Could not search path: <path>. Error code: <code>."',
		promptSnippet: "Count lines, words and bytes across a file or tree",
		parameters: wcSchema,
		executionMode: "parallel",
		kind: "search",
		read_only: true,
		async execute(
			_toolCallId,
			input: WcToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: WcToolDetails }> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const rootPath = resolveToCwd(input.path ?? ".", cwd);
			let stats: Stats;
			try {
				stats = statSync(rootPath);
			} catch (error: unknown) {
				const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
				throw new Error(`Could not search path: ${input.path ?? "."}. Error code: ${code}.`);
			}

			const targets = stats.isFile()
				? [{ absPath: rootPath, relPath: input.path ?? "." }]
				: walkFiles(rootPath, { include: input.include, exclude: input.exclude });

			const rows: string[] = [];
			let totalLines = 0;
			let totalWords = 0;
			let totalBytes = 0;

			for (const target of targets) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
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

export function createWcTool(
	cwd: string,
	options?: { maxLines?: number; maxBytes?: number },
): AgentTool<typeof wcSchema> {
	return wrapToolDefinition(createWcToolDefinition(cwd, options));
}
