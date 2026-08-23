import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";

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

const headSchema = Type.Object(
	{ path: Type.String({ description: "File to read the beginning of." }), ...windowSchema },
	{ additionalProperties: false },
);

const tailSchema = Type.Object(
	{
		path: Type.String({ description: "File to read the end of; reads backwards without loading the whole file." }),
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

async function executeWindow(
	which: "head" | "tail",
	cwd: string,
	input: HeadToolInput | TailToolInput,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WindowToolDetails }> {
	throwIfAborted(signal);
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

	let text: string;
	let readBytes: number;
	let windowClipped = false;

	if (mode === "bytes") {
		const limit = Math.min(count, OUTPUT_MAX_BYTES);
		const endOffset = which === "head" ? Math.min(limit, fileBytes) : fileBytes;
		const { buf } = readByteWindow(absPath, endOffset, limit);
		readBytes = buf.length;
		text = buf.toString("utf-8");
		windowClipped = count > OUTPUT_MAX_BYTES || (which === "tail" && fileBytes > limit);
	} else if (fileBytes <= SMALL_FILE) {
		const { buf } = readByteWindow(absPath, fileBytes, fileBytes);
		readBytes = buf.length;
		text = sliceLines(buf.toString("utf-8"), which, count);
	} else {
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
	return {
		content: [{ type: "text", text: truncation.content }],
		details: { path: absPath, mode, count, readBytes, fileBytes, windowClipped },
	};
}

function makeDefinition<S extends typeof headSchema | typeof tailSchema>(
	which: "head" | "tail",
	cwd: string,
	schema: S,
): ToolDefinition<S, WindowToolDetails> {
	const description =
		which === "head"
			? 'Show the first lines or bytes of a file without loading all of it (head(1)). Default 10 lines; pass bytes to switch to byte mode. Not for reading whole files - use read_file; not for pattern search - use grep. A missing path fails with "Could not search path: <path>. Error code: <code>."'
			: 'Show the last lines or bytes of a file without loading all of it (tail(1)) - reads backwards from EOF, so the last 10 lines of a 10 GB log read a few KB. Default 10 lines; pass bytes to switch to byte mode. Does not follow live streams (-f is unsupported). Not for reading whole files - use read_file. A missing path fails with "Could not search path: <path>. Error code: <code>."';
	return {
		name: which,
		label: which,
		description,
		promptSnippet:
			which === "head"
				? "First lines/bytes of a file; not for whole files - use read_file"
				: "Last lines/bytes of a file via cheap backward reads; not for whole files - use read_file",
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
export function createHeadToolDefinition(cwd: string): ToolDefinition<typeof headSchema, WindowToolDetails> {
	return makeDefinition("head", cwd, headSchema);
}

/** tail(1) as a native tool: backward window reads keep large logs cheap. */
export function createTailToolDefinition(cwd: string): ToolDefinition<typeof tailSchema, WindowToolDetails> {
	return makeDefinition("tail", cwd, tailSchema);
}

export function createHeadTool(cwd: string): AgentTool<typeof headSchema> {
	return wrapToolDefinition(createHeadToolDefinition(cwd));
}

export function createTailTool(cwd: string): AgentTool<typeof tailSchema> {
	return wrapToolDefinition(createTailToolDefinition(cwd));
}
