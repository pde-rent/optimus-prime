import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import type { ToolDefinition } from "../extensions/types.js";
import { getMutationQueueKey, onFileMutation } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

const readFileSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
		offset: Type.Optional(
			Type.Number({
				description:
					"1-based first line to return. Only provide it to page through a file after a truncated read told you where it stopped.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Max lines to return. Only provide it for very large files; output is capped at ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)} regardless.`,
			}),
		),
		lineNumbers: Type.Optional(
			Type.Boolean({
				description:
					'Prefix each returned line as "<lineNumber>\\t<content>". Only set true when you need stable line numbers for a later edit.',
			}),
		),
	},
	{ additionalProperties: false },
);

export type ReadFileToolInput = Static<typeof readFileSchema>;

export interface ReadFileToolDetails {
	/** Total size of the file in bytes */
	totalBytes: number;
	/** Total number of lines in the file */
	totalLines: number;
	/** 1-based line number of the first returned line */
	startLine: number;
	/** 1-based line number of the last returned line */
	endLine: number;
	/** Whether the output was truncated by the line/byte caps */
	truncated: boolean;
}

/**
 * Pluggable operations for the read-file tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadFileOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Stat the file; when absent, the unchanged short-circuit is disabled */
	stat?: (absolutePath: string) => Promise<Stats>;
}

const defaultReadFileOperations: ReadFileOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	stat: (path) => fsStat(path),
};

export interface ReadFileToolOptions {
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadFileOperations;
	/** Maximum lines returned (default: 2000) */
	maxLines?: number;
	/** Maximum bytes returned (default: 50KB) */
	maxBytes?: number;
}

export interface ReadFileToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ReadFileToolDetails;
}

interface UnchangedReadState {
	mtimeMs: number;
	size: number;
	contentHash: string;
	windowKey: string;
	startLine: number;
	endLine: number;
	totalLines: number;
}

function buildWindowKey(input: ReadFileToolInput): string {
	return `${input.offset ?? 1}:${input.limit ?? "all"}:${input.lineNumbers ? 1 : 0}`;
}

export function createReadFileToolDefinition(
	cwd: string,
	options?: ReadFileToolOptions,
): ToolDefinition<typeof readFileSchema, ReadFileToolDetails> {
	const ops = options?.operations ?? defaultReadFileOperations;
	// Per-definition (per session) read-state used by the unchanged short-circuit.
	const lastReads = new Map<string, UnchangedReadState>();
	onFileMutation((key) => lastReads.delete(key));
	const definition: ToolDefinition<typeof readFileSchema, ReadFileToolDetails> = {
		name: "read_file",
		label: "read_file",
		description: `Read a text file, or one line range of one. Use for whole-file and multi-line reads; do not read a whole file just to make a small targeted change — go straight to the edit tool. Binary files are not supported; inspect them with bash. Output is capped at ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}, whichever hits first, and never splits a line; a truncated or paged read appends "[Showing lines X-Y of Z ...]" stating exactly what was returned. Re-reading an unmodified file with the same range returns a one-line unchanged notice instead of the content. Missing or unreadable paths fail with "Could not read file: <path>. Error code: <code>."; an empty file returns "(empty file)".`,
		promptSnippet: "Read a text file or a line range of one, with optional line numbers",
		parameters: readFileSchema,
		async execute(
			_toolCallId,
			input: ReadFileToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		): Promise<ReadFileToolResult> {
			const absolutePath = resolveToCwd(input.path, cwd);

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			try {
				await ops.access(absolutePath);
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
				throw new Error(`Could not read file: ${input.path}. ${errorMessage}.`);
			}

			const [buffer, stats] = await Promise.all([ops.readFile(absolutePath), ops.stat?.(absolutePath)]);
			const rawContent = buffer.toString("utf-8");
			const lines = rawContent.split("\n");
			const totalLines = lines.length;
			const totalBytes = buffer.byteLength;

			const windowKey = buildWindowKey(input);
			const contentHash = createHash("sha256").update(buffer).digest("hex");

			if (stats) {
				const key = getMutationQueueKey(absolutePath);
				const previous = lastReads.get(key);
				if (
					previous &&
					previous.mtimeMs === stats.mtimeMs &&
					previous.size === stats.size &&
					previous.contentHash === contentHash &&
					previous.windowKey === windowKey
				) {
					return {
						content: [
							{
								type: "text",
								text: `[file unchanged since your last read: lines ${previous.startLine}-${previous.endLine} of ${previous.totalLines}]`,
							},
						],
						details: {
							totalBytes,
							totalLines,
							startLine: previous.startLine,
							endLine: previous.endLine,
							truncated: false,
						},
					};
				}
			}

			const startLine = Math.max(1, Math.min(input.offset ?? 1, totalLines + 1));
			const selected = lines.slice(
				startLine - 1,
				input.limit !== undefined ? startLine - 1 + input.limit : undefined,
			);
			const selectedText = selected.join("\n");

			const truncation = truncateHead(selectedText, { maxLines: options?.maxLines, maxBytes: options?.maxBytes });

			let text = truncation.content;
			if (input.lineNumbers) {
				const width = String(startLine + truncation.outputLines - 1).length;
				text = truncation.content
					.split("\n")
					.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`)
					.join("\n");
			}
			if (text.length === 0) {
				text = "(empty file)";
			}

			if (truncation.truncated) {
				const endLine = startLine + truncation.outputLines - 1;
				const reason = truncation.truncatedBy === "lines" ? "line limit" : "byte limit";
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines} (${reason} reached). Re-read with a higher offset to continue.]`;
			} else if (startLine > 1 || (input.limit !== undefined && selected.length < totalLines - (startLine - 1))) {
				const endLine = startLine + selected.length - 1;
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}.]`;
			}

			if (stats) {
				lastReads.set(getMutationQueueKey(absolutePath), {
					mtimeMs: stats.mtimeMs,
					size: stats.size,
					contentHash,
					windowKey,
					startLine,
					endLine: startLine + truncation.outputLines - 1,
					totalLines,
				});
			}

			return {
				content: [{ type: "text", text }],
				details: {
					totalBytes,
					totalLines,
					startLine,
					endLine: startLine + truncation.outputLines - 1,
					truncated: truncation.truncated,
				},
			};
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "read_file" as const });
}

export function createReadFileTool(cwd: string, options?: ReadFileToolOptions): AgentTool<typeof readFileSchema> {
	return wrapToolDefinition(createReadFileToolDefinition(cwd, options));
}
