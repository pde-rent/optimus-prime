import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import type { theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
	BATCH_DEFAULT_MAX_BYTES,
	type BatchFileEntry,
	batchHeader,
	formatBatchSizeTable,
	MAX_BATCH_PATHS,
	noFilesFitMessage,
	selectWithinBudget,
} from "./batch-read.js";
import { getMutationQueueKey, onFileMutation } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { shortenPath } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

/** Window key for batch reads; each batched file is treated as one whole-file window. */
const BATCH_WINDOW_KEY = "batch";

const readFileSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Path to a single file to read. Omit when paths is provided." })),
		paths: Type.Optional(
			Type.Array(Type.String(), {
				description: `Pass paths[] to fetch many files in ONE call; the tool sizes them first (stat), then reads newest-mtime-first up to ${formatSize(BATCH_DEFAULT_MAX_BYTES)} total across ALL files. Max ${MAX_BATCH_PATHS} files. Overrides path/offset/limit/lineNumbers.`,
				maxItems: MAX_BATCH_PATHS,
			}),
		),
		limitBytes: Type.Optional(
			Type.Number({
				description: `Total byte budget across all files when paths is given. Default ${formatSize(BATCH_DEFAULT_MAX_BYTES)}.`,
				minimum: 1,
			}),
		),
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

export interface ReadFileBatchFileDetails {
	path: string;
	givenPath: string;
	bytes: number;
	mtimeMs: number;
	/** False when the file stayed over the byte budget and only appears in the size table. */
	included: boolean;
	totalLines?: number;
	/** True when the unchanged short-circuit replaced the content with a notice. */
	unchanged?: boolean;
}

export interface ReadFileBatchToolDetails {
	mode: "batch";
	budgetBytes: number;
	files: ReadFileBatchFileDetails[];
}

export type ReadFileResultDetails = ReadFileToolDetails | ReadFileBatchToolDetails;

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
	/** Total byte budget across all files in a paths[] batch (default: 100KB) */
	maxBatchBytes?: number;
}

export interface ReadFileToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ReadFileToolDetails;
}

export interface ReadFileBatchResult {
	content: Array<{ type: "text"; text: string }>;
	details: ReadFileBatchToolDetails;
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

function buildWindowKey(input: Pick<ReadFileToolInput, "offset" | "limit" | "lineNumbers">): string {
	return `${input.offset ?? 1}:${input.limit ?? "all"}:${input.lineNumbers ? 1 : 0}`;
}

interface SingleReadParams {
	absolutePath: string;
	/** Path exactly as the caller passed it, used verbatim in error strings. */
	givenPath: string;
	windowKey: string;
	offset?: number;
	limit?: number;
	lineNumbers?: boolean;
}

interface SingleReadResult {
	text: string;
	details: ReadFileToolDetails;
	unchanged: boolean;
}

/** Reads one whole/windowed file with the unchanged short-circuit; shared by single and batch mode. */
async function readSingleFile(
	params: SingleReadParams,
	ops: ReadFileOperations,
	options: ReadFileToolOptions | undefined,
	lastReads: Map<string, UnchangedReadState>,
): Promise<SingleReadResult> {
	const { absolutePath, givenPath } = params;

	try {
		await ops.access(absolutePath);
	} catch (error: unknown) {
		const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
		throw new Error(`Could not read file: ${givenPath}. ${errorMessage}.`);
	}

	const [buffer, stats] = await Promise.all([ops.readFile(absolutePath), ops.stat?.(absolutePath)]);
	const rawContent = buffer.toString("utf-8");
	const lines = rawContent.split("\n");
	const totalLines = lines.length;
	const totalBytes = buffer.byteLength;

	const contentHash = createHash("sha256").update(buffer).digest("hex");

	if (stats) {
		const key = getMutationQueueKey(absolutePath);
		const previous = lastReads.get(key);
		if (
			previous &&
			previous.mtimeMs === stats.mtimeMs &&
			previous.size === stats.size &&
			previous.contentHash === contentHash &&
			previous.windowKey === params.windowKey
		) {
			return {
				text: `[file unchanged since your last read: lines ${previous.startLine}-${previous.endLine} of ${previous.totalLines}]`,
				details: {
					totalBytes,
					totalLines,
					startLine: previous.startLine,
					endLine: previous.endLine,
					truncated: false,
				},
				unchanged: true,
			};
		}
	}

	const startLine = Math.max(1, Math.min(params.offset ?? 1, totalLines + 1));
	const selected = lines.slice(startLine - 1, params.limit !== undefined ? startLine - 1 + params.limit : undefined);
	const selectedText = selected.join("\n");

	const truncation = truncateHead(selectedText, { maxLines: options?.maxLines, maxBytes: options?.maxBytes });

	let text = truncation.content;
	if (params.lineNumbers) {
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
	} else if (startLine > 1 || (params.limit !== undefined && selected.length < totalLines - (startLine - 1))) {
		const endLine = startLine + selected.length - 1;
		text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}.]`;
	}

	if (stats) {
		lastReads.set(getMutationQueueKey(absolutePath), {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			contentHash,
			windowKey: params.windowKey,
			startLine,
			endLine: startLine + truncation.outputLines - 1,
			totalLines,
		});
	}

	return {
		text,
		details: {
			totalBytes,
			totalLines,
			startLine,
			endLine: startLine + truncation.outputLines - 1,
			truncated: truncation.truncated,
		},
		unchanged: false,
	};
}

export function createReadFileToolDefinition(
	cwd: string,
	options?: ReadFileToolOptions,
): ToolDefinition<typeof readFileSchema, ReadFileResultDetails> {
	const ops = options?.operations ?? defaultReadFileOperations;
	// Per-definition (per session) read-state used by the unchanged short-circuit.
	const lastReads = new Map<string, UnchangedReadState>();
	onFileMutation((key) => lastReads.delete(key));

	/**
	 * Sizing pass first: stat every path, then read newest-mtime-first within one
	 * total byte budget. Files that never had a chance are reported, not read.
	 */
	async function executeBatchRead(input: ReadFileToolInput, signal?: AbortSignal): Promise<ReadFileBatchResult> {
		if (input.paths!.length === 0) {
			throw new Error("paths must contain at least one file path.");
		}
		if (input.paths!.length > MAX_BATCH_PATHS) {
			throw new Error(`paths accepts at most ${MAX_BATCH_PATHS} files per call.`);
		}
		if (!ops.stat) {
			throw new Error("paths[] requires stat support from the configured read operations.");
		}
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const budget = input.limitBytes ?? options?.maxBatchBytes ?? BATCH_DEFAULT_MAX_BYTES;

		const sized: BatchFileEntry[] = [];
		const skippedMissing: string[] = [];
		for (const givenPath of input.paths!) {
			const absolutePath = resolveToCwd(givenPath, cwd);
			try {
				const stats = await ops.stat(absolutePath);
				if (!stats.isFile()) {
					skippedMissing.push(givenPath);
					continue;
				}
				sized.push({ givenPath, absPath: absolutePath, bytes: stats.size, mtimeMs: stats.mtimeMs });
			} catch {
				skippedMissing.push(givenPath);
			}
		}

		const notes: string[] = [];
		if (skippedMissing.length > 0) {
			notes.push(`[Skipped ${skippedMissing.length} unreadable path(s): ${skippedMissing.join(", ")}]`);
		}

		const { fit, overflow } = selectWithinBudget(sized, budget);
		if (overflow.length > 0) {
			const listed = overflow.map((entry) => `${entry.givenPath} (${formatSize(entry.bytes)})`).join(", ");
			notes.push(`[Skipped ${overflow.length} file(s) over budget: ${listed}]`);
		}

		const includedPaths = new Set(fit.map((entry) => entry.absPath));
		const fileDetails: ReadFileBatchFileDetails[] = sized.map((entry) => ({
			path: entry.absPath,
			givenPath: entry.givenPath,
			bytes: entry.bytes,
			mtimeMs: entry.mtimeMs,
			included: includedPaths.has(entry.absPath),
		}));

		if (fit.length === 0) {
			const parts = [noFilesFitMessage(sized, budget), "", formatBatchSizeTable(sized)];
			if (notes.length > 0) parts.push("", ...notes);
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { mode: "batch", budgetBytes: budget, files: fileDetails },
			};
		}

		const blocks: string[] = [];
		for (const entry of fit) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			try {
				const read = await readSingleFile(
					{ absolutePath: entry.absPath, givenPath: entry.givenPath, windowKey: BATCH_WINDOW_KEY },
					ops,
					options,
					lastReads,
				);
				blocks.push(`${batchHeader(entry.absPath, cwd, entry.bytes)}\n${read.text}`);
				const detail = fileDetails.find((f) => f.path === entry.absPath);
				if (detail) {
					detail.totalLines = read.details.totalLines;
					detail.unchanged = read.unchanged;
				}
			} catch (error: unknown) {
				notes.push(`[Skipped ${entry.givenPath}: ${error instanceof Error ? error.message : String(error)}]`);
			}
		}

		let text = blocks.join("\n\n");
		if (notes.length > 0) {
			text += `\n\n${notes.join("\n")}`;
		}

		return {
			content: [{ type: "text", text }],
			details: { mode: "batch", budgetBytes: budget, files: fileDetails },
		};
	}

	const definition: ToolDefinition<typeof readFileSchema, ReadFileResultDetails> = {
		name: "read_file",
		label: "read_file",
		kind: "read",
		read_only: true,
		description:
			"Read file contents - the default and fastest way to see whole files, line ranges or many files at once (paths[]); runs in-process on Windows/macOS/Linux; replaces bash cat/head/tail. Not for binary files - inspect those with bash. Caps at ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}.",
		promptSnippet: "Read whole files, line ranges, or many files at once via paths[]",
		parameters: readFileSchema,
		renderCall(args, theme, _context) {
			const path = shortenPath(args?.path);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read_file"))} ${path ? theme.fg("accent", path) : theme.fg("toolOutput", "...")}`,
				0,
				0,
			);
		},
		// Read cell: collapsed shows a lines X-Y-of-Z size label; ctrl+o reveals the body.
		renderResult(result, options, theme, context) {
			if (context.isError) {
				const errorText = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				return new Text(theme.fg("error", errorText), 1, 0);
			}
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text || "")
				.join("\n");
			if (!options.expanded) {
				const details = result.details as ReadFileToolDetails | undefined;
				const label = details
					? `lines ${details.startLine}-${details.endLine} of ${details.totalLines} · ${formatSize(details.totalBytes)}`
					: "read";
				return new Text(theme.fg("muted", `[${label}]`), 1, 0);
			}
			return new Text(theme.fg("toolOutput", output), 1, 0);
		},
		async execute(
			_toolCallId,
			input: ReadFileToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		): Promise<ReadFileToolResult | ReadFileBatchResult> {
			if (input.paths !== undefined) {
				return executeBatchRead(input, signal);
			}
			if (input.limitBytes !== undefined) {
				throw new Error("limitBytes only applies when paths is given.");
			}
			const singlePath = input.path ?? "";
			const absolutePath = resolveToCwd(singlePath, cwd);

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const read = await readSingleFile(
				{
					absolutePath,
					givenPath: input.path as string,
					windowKey: buildWindowKey(input),
					offset: input.offset,
					limit: input.limit,
					lineNumbers: input.lineNumbers,
				},
				ops,
				options,
				lastReads,
			);
			return { content: [{ type: "text", text: read.text }], details: read.details };
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "read_file" as const });
}

export function createReadFileTool(cwd: string, options?: ReadFileToolOptions): AgentTool<typeof readFileSchema> {
	return wrapToolDefinition(createReadFileToolDefinition(cwd, options));
}
