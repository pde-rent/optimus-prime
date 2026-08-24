import { readFileSync } from "node:fs";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead, truncateLine } from "../truncate.js";
import { looksLikeBinary, statSearchRoot, walkFiles } from "./walk.js";

const grepSchema = Type.Object(
	{
		pattern: Type.String({ description: "Regular expression (JavaScript syntax) to search for." }),
		path: Type.Optional(
			Type.String({
				description:
					'File or directory to search. Defaults to "." (the working directory). Forward slashes are accepted on every platform.',
			}),
		),
		include: Type.Optional(
			Type.String({
				description: 'Only search files whose relative path matches this glob, e.g. "*.ts" or "src/**/*.json".',
			}),
		),
		exclude: Type.Optional(
			Type.String({ description: 'Skip files whose relative path matches this glob, e.g. "*.min.js".' }),
		),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Set true for case-insensitive matching." })),
		context: Type.Optional(
			Type.Number({
				description:
					"Lines of context to show around each match (default 0). Output is capped at 2000 lines / 50KB regardless.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	/** Total number of matching lines found (before output truncation). */
	matchCount: number;
	/** Number of text files actually searched. */
	fileCount: number;
	/** Number of binary files skipped by the NUL-byte sniff. */
	binarySkipped: number;
	/** Whether the output was truncated by the line/byte caps. */
	truncated: boolean;
}

/**
 * Search file contents with a regular expression, entirely in-process (no shell).
 *
 * Use when you need to locate text across one file or a directory tree and the
 * REPL is not already open with the content. Do not use it to read a known file
 * - read_file is cheaper there - nor to search inside a gitignored or
 * node_modules tree: those are skipped by design. Output is `path:line:match`
 * per matching line (context lines use `-` separators), capped at 2000 lines /
 * 50KB with a truncation notice. Failures report the exact problem, e.g.
 * "Invalid grep pattern: <pattern>. <reason>." or
 * "Could not search path: <path>. Error code: ENOENT."
 */
export function createGrepToolDefinition(
	cwd: string,
	options?: { maxLines?: number; maxBytes?: number },
): ToolDefinition<typeof grepSchema, GrepToolDetails> {
	const definition: ToolDefinition<typeof grepSchema, GrepToolDetails> = {
		name: "grep",
		label: "grep",
		description:
			"Search file contents with a regex across a file or tree - the default and fastest way to locate text or symbols; runs in-process on Windows/macOS/Linux; replaces bash grep/rg. Gitignore-aware; output path:line:text capped at 2000 lines / 50KB. Not for reading a known file - use read_file.",
		promptSnippet: "Regex-search file contents across a file or tree; prefer over bash grep",
		parameters: grepSchema,
		executionMode: "parallel",
		kind: "search",
		read_only: true,
		renderCall(args, theme) {
			const path = args?.path ?? ".";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args?.pattern ?? "...")} ${theme.fg("dim", path)}`,
				0,
				0,
			);
		},
		async execute(
			_toolCallId,
			input: GrepToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails }> {
			throwIfAborted(signal);

			let regex: RegExp;
			try {
				regex = new RegExp(input.pattern, input.ignoreCase ? "gi" : "g");
			} catch (error: unknown) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`Invalid grep pattern: ${input.pattern}. ${reason}`);
			}

			const rootPath = resolveToCwd(input.path ?? ".", cwd);
			const stats = statSearchRoot(rootPath, input.path ?? ".");

			const targets = stats.isFile()
				? [{ absPath: rootPath, relPath: input.path ?? "." }]
				: walkFiles(rootPath, { include: input.include, exclude: input.exclude });

			const contextLines = Math.max(0, Math.floor(input.context ?? 0));
			const output: string[] = [];
			let matchCount = 0;
			let binarySkipped = 0;

			for (const target of targets) {
				throwIfAborted(signal);

				let buffer: Buffer;
				try {
					buffer = readFileSync(target.absPath);
				} catch {
					continue; // Vanished between walk and read: skip.
				}
				if (looksLikeBinary(buffer)) {
					binarySkipped++;
					continue;
				}

				const lines = buffer.toString("utf-8").split("\n");
				const matchLineNumbers: number[] = [];
				for (let i = 0; i < lines.length; i++) {
					regex.lastIndex = 0;
					if (regex.test(lines[i])) {
						matchLineNumbers.push(i);
					}
				}
				if (matchLineNumbers.length === 0) continue;
				matchCount += matchLineNumbers.length;

				// Merge overlapping context windows into contiguous groups.
				const groups: Array<[number, number]> = [];
				for (const lineIndex of matchLineNumbers) {
					const start = Math.max(0, lineIndex - contextLines);
					const end = Math.min(lines.length - 1, lineIndex + contextLines);
					const last = groups[groups.length - 1];
					if (last && start <= last[1] + 1) {
						last[1] = Math.max(last[1], end);
					} else {
						groups.push([start, end]);
					}
				}

				for (const [start, end] of groups) {
					if (output.length > 0) output.push("--");
					const matches = new Set(matchLineNumbers);
					for (let i = start; i <= end; i++) {
						const lineText = truncateLine(lines[i]).text;
						if (matches.has(i)) {
							output.push(`${target.relPath}:${i + 1}:${lineText}`);
						} else {
							output.push(`${target.relPath}-${i + 1}-${lineText}`);
						}
					}
				}
			}

			const truncation = truncateHead(output.join("\n"), {
				maxLines: options?.maxLines,
				maxBytes: options?.maxBytes,
			});
			let text = truncation.content;
			if (truncation.truncated) {
				const reason = truncation.truncatedBy === "lines" ? "line limit" : "byte limit";
				text += `\n\n[Truncated at ${truncation.outputLines} of ${truncation.totalLines} output lines (${reason} reached). Narrow the search or raise the limit.]`;
			}
			if (text.length === 0) {
				text = "No matches found.";
			}

			return {
				content: [{ type: "text", text }],
				details: { matchCount, fileCount: targets.length, binarySkipped, truncated: truncation.truncated },
			};
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "grep" as const });
}

export function createGrepTool(cwd: string, options?: { maxLines?: number; maxBytes?: number }) {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
