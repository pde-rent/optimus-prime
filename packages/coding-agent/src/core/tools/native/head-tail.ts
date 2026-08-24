import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import {
	BATCH_DEFAULT_MAX_BYTES,
	type BatchFileEntry,
	batchHeader,
	formatBatchSizeTable,
	MAX_BATCH_PATHS,
	noFilesFitMessage,
	selectWithinBudget,
} from "../batch-read.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { formatSize, truncateHead } from "../truncate.js";

const windowSchema = {
	lines: Type.Optional(
		Type.Number({ description: "Number of lines to show. Ignored when bytes is given. Default 10.", minimum: 0 }),
	),
	bytes: Type.Optional(
		Type.Number({
			description: "Show this many bytes instead of lines (like -c). Takes precedence over lines.",
			minimum: 0,
		}),
	),
};

const batchSchema = {
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: `Pass paths[] to window many files in ONE call; the tool sizes them first (stat), then reads newest-mtime-first up to ${formatSize(BATCH_DEFAULT_MAX_BYTES)} total across ALL files. Max ${MAX_BATCH_PATHS} files.`,
			maxItems: MAX_BATCH_PATHS,
		}),
	),
	limitBytes: Type.Optional(
		Type.Number({
			description: `Total byte budget across all files when paths is given. Default ${formatSize(BATCH_DEFAULT_MAX_BYTES)}.`,
			minimum: 1,
		}),
	),
};

const headSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "File to read the beginning of." })),
		...batchSchema,
		...windowSchema,
	},
	{ additionalProperties: false },
);

const tailSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({ description: "File to read the end of; reads backwards without loading the whole file." }),
		),
		...batchSchema,
		...windowSchema,
	},
	{ additionalProperties: false },
);

export type HeadToolInput = Static<typeof headSchema>;
export type TailToolInput = Static<typeof tailSchema>;

export interface WindowToolDetails {
	path: string;
	mode: "lines" | "bytes";
	count: number;
	/** Bytes actually read from disk; for tail on large files this is far less than file size. */
	readBytes: number;
	fileBytes: number;
	/** Output was clipped by the byte-window on a large file, so line counts are within that window. */
	windowClipped: boolean;
}

export interface WindowBatchFileDetails {
	path: string;
	givenPath: string;
	bytes: number;
	mtimeMs: number;
	/** False when the file stayed over the byte budget and only appears in the size table. */
	included: boolean;
	readBytes?: number;
	windowClipped?: boolean;
}

export interface WindowBatchDetails {
	budgetBytes: number;
	files: WindowBatchFileDetails[];
}

export type WindowResultDetails = WindowToolDetails | WindowBatchDetails;

const SMALL_FILE = 512 * 1024;
const MAX_WINDOW = 1024 * 1024;
const OUTPUT_MAX_BYTES = 50 * 1024;

function readByteWindow(absPath: string, endOffset: number, maxCount: number): { buf: Buffer; fileBytes: number } {
	const fd = openSync(absPath, "r");
	try {
		const st = fstatSync(fd);
		const start = Math.max(0, endOffset - maxCount);
		const length = Math.max(0, Math.min(endOffset, st.size) - start);
		const buf = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buf, read, length - read, start + read);
			if (n <= 0) break;
			read += n;
		}
		return { buf: buf.subarray(0, read), fileBytes: st.size };
	} finally {
		closeSync(fd);
	}
}

function fileSize(absPath: string): number {
	const fd = openSync(absPath, "r");
	try {
		return fstatSync(fd).size;
	} finally {
		closeSync(fd);
	}
}

function sliceLines(text: string, which: "head" | "tail", n: number): string {
	if (n === 0) return "";
	const hadFinalNewline = text.endsWith("\n");
	const body = hadFinalNewline ? text.slice(0, -1) : text;
	if (body === "") return text;
	const parts = body.split("\n");
	const picked = which === "head" ? parts.slice(0, n) : parts.slice(Math.max(0, parts.length - n));
	const joined = picked.join("\n");
	return which === "head" && hadFinalNewline ? `${joined}\n` : joined;
}

function windowText(
	which: "head" | "tail",
	absPath: string,
	mode: "lines" | "bytes",
	count: number,
): { text: string; readBytes: number; windowClipped: boolean } {
	let text: string;
	let readBytes: number;
	let windowClipped = false;

	if (mode === "bytes") {
		const limit = Math.min(count, OUTPUT_MAX_BYTES);
		const fileBytes = fileSize(absPath);
		const endOffset = which === "head" ? Math.min(limit, fileBytes) : fileBytes;
		const { buf } = readByteWindow(absPath, endOffset, limit);
		readBytes = buf.length;
		text = buf.toString("utf-8");
		windowClipped = count > OUTPUT_MAX_BYTES || (which === "tail" && fileBytes > limit);
	} else if (fileSize(absPath) <= SMALL_FILE) {
		const size = fileSize(absPath);
		const { buf } = readByteWindow(absPath, size, size);
		readBytes = buf.length;
		text = sliceLines(buf.toString("utf-8"), which, count);
	} else {
		const fileBytes = fileSize(absPath);
		let endOffset = fileBytes;
		if (which === "tail") {
			// Trim one trailing newline so the last N lines end at a complete line.
			const { buf: last } = readByteWindow(absPath, fileBytes, 1);
			if (last.length === 1 && last[0] === 0x0a) endOffset -= 1;
		}
		const startOffsetHint = endOffset - MAX_WINDOW;
		const { buf } = readByteWindow(absPath, endOffset, MAX_WINDOW);
		readBytes = buf.length;
		text = sliceLines(buf.toString("utf-8"), which, count);
		windowClipped = which === "tail" && startOffsetHint > 0;
	}

	const truncation = truncateHead(text, { maxBytes: OUTPUT_MAX_BYTES });
	return { text: truncation.content, readBytes, windowClipped };
}

async function executeWindow(
	which: "head" | "tail",
	cwd: string,
	input: HeadToolInput | TailToolInput,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WindowResultDetails }> {
	throwIfAborted(signal);

	if (input.paths !== undefined) {
		return executeBatchWindow(which, cwd, input, signal);
	}
	if (!input.path) {
		throw new Error("Either path or paths is required.");
	}
	if (input.limitBytes !== undefined) {
		throw new Error("limitBytes only applies when paths is given.");
	}

	const absPath = resolveToCwd(input.path, cwd);
	let fileBytes: number;
	try {
		fileBytes = fileSize(absPath);
	} catch (error: unknown) {
		const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
		throw new Error(`Could not search path: ${input.path}. Error code: ${code}.`);
	}
	const mode = input.bytes !== undefined ? "bytes" : "lines";
	const count = input.bytes !== undefined ? input.bytes : (input.lines ?? 10);

	const result = windowText(which, absPath, mode, count);
	return {
		content: [{ type: "text", text: result.text }],
		details: {
			path: absPath,
			mode,
			count,
			readBytes: result.readBytes,
			fileBytes,
			windowClipped: result.windowClipped,
		},
	};
}

/** Batch mode: sizing pass first, then one window per file newest-mtime-first within a shared byte budget. */
async function executeBatchWindow(
	which: "head" | "tail",
	cwd: string,
	input: HeadToolInput | TailToolInput,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WindowBatchDetails }> {
	throwIfAborted(signal);
	if (input.paths!.length === 0) {
		throw new Error("paths must contain at least one file path.");
	}
	if (input.paths!.length > MAX_BATCH_PATHS) {
		throw new Error(`paths accepts at most ${MAX_BATCH_PATHS} files per call.`);
	}

	const budget = input.limitBytes ?? BATCH_DEFAULT_MAX_BYTES;

	const sized: BatchFileEntry[] = [];
	const skippedMissing: string[] = [];
	for (const givenPath of input.paths!) {
		const absPath = resolveToCwd(givenPath, cwd);
		try {
			const stats = statSync(absPath);
			if (!stats.isFile()) {
				skippedMissing.push(givenPath);
				continue;
			}
			sized.push({ givenPath, absPath, bytes: stats.size, mtimeMs: stats.mtimeMs });
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
	const fileDetails: WindowBatchFileDetails[] = sized.map((entry) => ({
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
			details: { budgetBytes: budget, files: fileDetails },
		};
	}

	const mode = input.bytes !== undefined ? "bytes" : "lines";
	const count = input.bytes !== undefined ? input.bytes : (input.lines ?? 10);

	const blocks: string[] = [];
	for (const entry of fit) {
		throwIfAborted(signal);
		try {
			const result = windowText(which, entry.absPath, mode, count);
			blocks.push(`${batchHeader(entry.absPath, cwd, entry.bytes)}\n${result.text}`);
			const detail = fileDetails.find((f) => f.path === entry.absPath);
			if (detail) {
				detail.readBytes = result.readBytes;
				detail.windowClipped = result.windowClipped;
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
		details: { budgetBytes: budget, files: fileDetails },
	};
}

function makeDefinition<S extends typeof headSchema | typeof tailSchema>(
	which: "head" | "tail",
	cwd: string,
	schema: S,
): ToolDefinition<S, WindowResultDetails> {
	const description =
		which === "head"
			? `Show the first lines or bytes of files. Replaces bash head; runs in-process on Windows/macOS/Linux. Not for whole files (read_file), pattern search (grep) or last lines (tail). Default 10 lines; bytes switches mode; paths[] batches many files within limitBytes.`
			: `Show the last lines or bytes of files, reading backwards so the tail of a huge log costs a few KB. Replaces bash tail; runs in-process on Windows/macOS/Linux. Not for whole files (read_file); no live following (-f). Default 10 lines; bytes switches mode; paths[] batches many files.`;
	return {
		name: which,
		label: which,
		description,
		promptSnippet:
			which === "head"
				? "First lines/bytes of files; not for whole files - use read_file"
				: "Last lines/bytes of files via cheap backward reads; not for whole files - use read_file",
		parameters: schema,
		executionMode: "parallel",
		kind: "read",
		read_only: true,
		async execute(_toolCallId, input, signal) {
			return executeWindow(which, cwd, input as HeadToolInput | TailToolInput, signal);
		},
	};
}

/**
 * head(1) as a native tool: first N lines/bytes of one file, in-process,
 * capped output. Pair of tail for log inspection.
 */
export function createHeadToolDefinition(cwd: string): ToolDefinition<typeof headSchema, WindowResultDetails> {
	return makeDefinition("head", cwd, headSchema);
}

/** tail(1) as a native tool: backward window reads keep large logs cheap. */
export function createTailToolDefinition(cwd: string): ToolDefinition<typeof tailSchema, WindowResultDetails> {
	return makeDefinition("tail", cwd, tailSchema);
}

export function createHeadTool(cwd: string) {
	return wrapToolDefinition(createHeadToolDefinition(cwd));
}

export function createTailTool(cwd: string) {
	return wrapToolDefinition(createTailToolDefinition(cwd));
}
