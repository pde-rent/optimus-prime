import { type Stats, statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { walkTree } from "./walk.js";

const findSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					'Directory to search. Defaults to "." (the working directory). Forward slashes are accepted on every platform.',
			}),
		),
		name: Type.Optional(
			Type.String({
				description:
					'Glob the entry name must match, e.g. "*.ts", "README*", "test-?-?.py". "**" crosses directory separators.',
			}),
		),
		type: Type.Optional(
			Type.Union([Type.Literal("file"), Type.Literal("dir")], {
				description: "Only return entries of this type. Default: both.",
			}),
		),
		minSize: Type.Optional(Type.Number({ description: "Only files of at least this many bytes (files only)." })),
		maxSize: Type.Optional(Type.Number({ description: "Only files of at most this many bytes (files only)." })),
		mtimeAfter: Type.Optional(
			Type.String({
				description: 'Only entries modified at or after this ISO 8601 timestamp, e.g. "2026-01-15T00:00:00Z".',
			}),
		),
		mtimeBefore: Type.Optional(Type.String({ description: "Only entries modified before this ISO 8601 timestamp." })),
		caseInsensitive: Type.Optional(
			Type.Boolean({
				description:
					"Match name globs case-insensitively. Useful on Windows filesystems where letter case is unreliable.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
	/** Number of matching entries found (before output truncation). */
	count: number;
	/** Whether the output was truncated by the line/byte caps. */
	truncated: boolean;
}

/** Translate a simple glob ("*.ts", "src/**", "test-?-?.py") into a regular expression over one path segment or a whole relative path. */
function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				source += ".*";
				i++;
				continue;
			}
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
}

/**
 * Find files and directories by name glob, type, size or mtime, entirely
 * in-process (no shell).
 *
 * Use when you know what an entry is called or roughly how big or old it is but
 * not its exact path. Do not use it to inspect file contents - grep/read_file
 * are the tools for that - nor to search node_modules, .git or gitignored
 * paths: they are skipped by design. Output is one forward-slash relative path
 * per line, capped at 2000 lines / 50KB with a truncation notice. A missing
 * root fails with "Could not search path: <path>. Error code: <code>."; an
 * invalid mtime filter fails with "Invalid find filter: <value>. Expected ISO 8601."
 */
export function createFindToolDefinition(
	cwd: string,
	options?: { maxLines?: number; maxBytes?: number },
): ToolDefinition<typeof findSchema, FindToolDetails> {
	const definition: ToolDefinition<typeof findSchema, FindToolDetails> = {
		name: "find",
		label: "find",
		description:
			'Find files and directories by name glob, type, size or modification time, without spawning a shell. Use it to locate entries whose exact path you do not know; do not use it to inspect contents (grep or read_file) or to search node_modules, .git or gitignored paths - they are skipped. Output is one relative forward-slash path per line under the given root, capped at 2000 lines / 50KB with a truncation notice. Failures report the exact problem: "Could not search path: <path>. Error code: <code>." for a missing root, or "Invalid find filter: <value>. Expected ISO 8601." for a bad timestamp.',
		promptSnippet: "Find files and directories by name, type, size or mtime; prefer over bash find",
		parameters: findSchema,
		executionMode: "parallel",
		kind: "search",
		read_only: true,
		async execute(
			_toolCallId,
			input: FindToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: FindToolDetails }> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			let minTime: number | undefined;
			let maxTime: number | undefined;
			if (input.mtimeAfter !== undefined) minTime = Date.parse(input.mtimeAfter);
			if (input.mtimeBefore !== undefined) maxTime = Date.parse(input.mtimeBefore);
			if (Number.isNaN(minTime) || Number.isNaN(maxTime)) {
				const bad = Number.isNaN(minTime) ? input.mtimeAfter : input.mtimeBefore;
				throw new Error(`Invalid find filter: ${bad}. Expected ISO 8601.`);
			}

			const nameRegex =
				input.name !== undefined ? globToRegExp(input.name, input.caseInsensitive === true) : undefined;

			const rootPath = resolveToCwd(input.path ?? ".", cwd);
			let stats: Stats;
			try {
				stats = statSync(rootPath);
			} catch (error: unknown) {
				const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
				throw new Error(`Could not search path: ${input.path ?? "."}. Error code: ${code}.`);
			}

			const matches: string[] = [];
			const hasSizeFilter = input.minSize !== undefined || input.maxSize !== undefined;
			const considerEntry = (entry: { relPath: string; isFile: boolean; stats: Stats }): void => {
				if (input.type && entry.isFile !== (input.type === "file")) return;
				if (nameRegex) {
					const baseName = entry.relPath.split("/").pop() ?? entry.relPath;
					if (!nameRegex.test(baseName)) return;
				}
				if (!entry.isFile && hasSizeFilter) return;
				if (input.minSize !== undefined && entry.stats.size < input.minSize) return;
				if (input.maxSize !== undefined && entry.stats.size > input.maxSize) return;
				if (minTime !== undefined && entry.stats.mtimeMs < minTime) return;
				if (maxTime !== undefined && entry.stats.mtimeMs >= maxTime) return;
				matches.push(entry.relPath);
			};

			if (stats.isDirectory()) {
				const seenDirs = new Set<string>([""]);
				for (const file of walkTree(rootPath)) {
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}
					// Re-derive the ancestor directories of each walked file so type=dir works.
					const segments = file.relPath.split("/");
					segments.pop();
					for (let i = 0; i < segments.length; i++) {
						const dirRel = segments.slice(0, i + 1).join("/");
						if (seenDirs.has(dirRel)) continue;
						seenDirs.add(dirRel);
						try {
							considerEntry({ relPath: dirRel, isFile: false, stats: statSync(resolveToCwd(dirRel, rootPath)) });
						} catch {
							// Vanished between walk and stat: skip.
						}
					}
					considerEntry({ relPath: file.relPath, isFile: true, stats: statSync(file.absPath) });
				}
			} else if (!input.type || input.type === "file") {
				matches.push(input.path ?? ".");
			}

			const truncation = truncateHead(matches.join("\n"), {
				maxLines: options?.maxLines,
				maxBytes: options?.maxBytes,
			});
			let text = truncation.content;
			if (truncation.truncated) {
				const reason = truncation.truncatedBy === "lines" ? "line limit" : "byte limit";
				text += `\n\n[Truncated at ${truncation.outputLines} of ${truncation.totalLines} matches (${reason} reached). Narrow the filters.]`;
			}
			if (text.length === 0) {
				text = "No matching entries.";
			}

			return {
				content: [{ type: "text", text }],
				details: { count: matches.length, truncated: truncation.truncated },
			};
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "find" as const });
}

export function createFindTool(
	cwd: string,
	options?: { maxLines?: number; maxBytes?: number },
): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
