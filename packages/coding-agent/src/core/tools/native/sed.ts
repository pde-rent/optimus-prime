import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ToolDefinition } from "../../extensions/types.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "../edit-diff.js";
import { withFileMutationQueue } from "../file-mutation-queue.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";

const sedSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to stream-edit (relative or absolute)." }),
		expression: Type.String({
			description:
				'Substitution expression of the form s/pattern/replacement/[flags]. The delimiter after "s" can be any punctuation character; escape it with a backslash to use it literally. Flags: g (all occurrences, default first only), i (case-insensitive). JavaScript replacement syntax applies ($1, $&...).',
		}),
		apply: Type.Optional(
			Type.Boolean({
				description:
					"Default false: dry-run that returns the unified diff without touching the file. Set true only once you have reviewed the dry-run diff and want the change written.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SedToolInput = Static<typeof sedSchema>;

export interface SedToolDetails {
	/** Unified diff of the change (dry-run or applied). Empty when nothing matched. */
	diff: string;
	/** Whether apply was requested. */
	applied: boolean;
}

interface ParsedSubstitution {
	pattern: RegExp;
	replacement: string;
	globalFlag: boolean;
}

/**
 * Parse one s/pattern/replacement/[flags] expression. Delimiter-escapes are
 * resolved; every other backslash sequence is passed through untouched so the
 * regex engine and JS replacement syntax keep their meaning.
 */
export function parseSubstitution(expression: string): ParsedSubstitution | { error: string } {
	if (expression.length < 3 || expression[0] !== "s") {
		return { error: "Expected s/pattern/replacement/[flags]." };
	}
	const delimiter = expression[1];
	if (/[a-zA-Z0-9\\]/.test(delimiter) || /\s/.test(delimiter)) {
		return { error: `Expected a punctuation delimiter right after "s", got "${delimiter}".` };
	}

	const parts: string[] = [];
	let current = "";
	let escaped = false;
	for (let i = 2; i < expression.length; i++) {
		const char = expression[i];
		if (escaped) {
			current += char === delimiter ? char : `\\${char}`;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === delimiter) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (escaped) {
		current += "\\";
	}
	if (parts.length < 2) {
		return { error: "Expected two delimiters separating pattern and replacement." };
	}

	const flags = parts.length > 2 ? parts.slice(2).join("") + current : current;
	const unknownFlags = flags.replace(/[gi]/g, "");
	if (unknownFlags) {
		return { error: `Unsupported flag(s) "${unknownFlags}". Supported flags: g, i.` };
	}

	try {
		return {
			pattern: new RegExp(parts[0], flags.includes("i") ? "i" : ""),
			replacement: parts[1],
			globalFlag: flags.includes("g"),
		};
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message : String(error);
		return { error: reason };
	}
}

/**
 * Stream-edit one file with a single s/pattern/replacement/[flags]
 * substitution, entirely in-process.
 *
 * This is deliberately narrower than GNU sed: one substitution per call, no
 * line addressing, no scripts. Default is a DRY-RUN that reports the unified
 * diff without writing anything; set apply:true only after reviewing that diff
 * to write through the same mutation queue as edit/write_file. Do not use it
 * for multi-line restructuring - read_file plus edit gives tighter control
 * there. A pattern with zero matches answers without a diff and leaves the
 * file untouched; failures report the exact problem:
 * "Invalid sed expression: <expression>. <reason>.",
 * "Could not read file: <path>. Error code: <code>.",
 * "Could not write file: <path>. Error code: <code>."
 */
export function createSedToolDefinition(cwd: string): ToolDefinition<typeof sedSchema, SedToolDetails> {
	const definition: ToolDefinition<typeof sedSchema, SedToolDetails> = {
		name: "sed",
		label: "sed",
		description:
			'Stream-edit a file with one s/pattern/replacement/[flags] substitution. Default (apply:false) is a dry-run returning the unified diff; pass apply:true only after reviewing it to write the change. Deliberately narrower than GNU sed: no line addressing, no scripts, one substitution per call - prefer edit for targeted multi-line changes. Zero matches leave the file untouched and answer without a diff. Failures report the exact problem: "Invalid sed expression: <expression>. <reason>.", "Could not read file: <path>. Error code: <code>.", "Could not write file: <path>. Error code: <code>."',
		promptSnippet:
			"Substitute in a file via s/pattern/replacement; dry-run diff by default; not for multi-file edits - use grep+edit",
		parameters: sedSchema,
		kind: "edit",
		read_only: false,
		async execute(
			_toolCallId,
			input: SedToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: SedToolDetails }> {
			const parsed = parseSubstitution(input.expression);
			if ("error" in parsed) {
				throw new Error(`Invalid sed expression: ${input.expression}. ${parsed.error}`);
			}

			const absolutePath = resolveToCwd(input.path, cwd);

			const run = async (): Promise<{ content: Array<{ type: "text"; text: string }>; details: SedToolDetails }> => {
				let buffer: Buffer;
				try {
					await fsAccess(absolutePath, constants.R_OK);
					buffer = await fsReadFile(absolutePath);
				} catch (error: unknown) {
					const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
					throw new Error(`Could not read file: ${input.path}. Error code: ${code}.`);
				}

				const stripped = stripBom(buffer.toString("utf-8"));
				const originalEnding = detectLineEnding(stripped.text);
				const oldContent = normalizeToLF(stripped.text);
				const newContent = parsed.globalFlag
					? oldContent.replace(new RegExp(parsed.pattern.source, `${parsed.pattern.flags}g`), parsed.replacement)
					: oldContent.replace(parsed.pattern, parsed.replacement);

				if (oldContent === newContent) {
					return {
						content: [
							{
								type: "text",
								text: `No matches for ${input.expression} in ${input.path}; file left unchanged.`,
							},
						],
						details: { diff: "", applied: false },
					};
				}

				const diffResult = generateDiffString(oldContent, newContent);

				if (!input.apply) {
					return {
						content: [
							{
								type: "text",
								text: `Dry run for ${input.path} (nothing written). Re-run with apply:true to write this change.\n\n${diffResult.diff}`,
							},
						],
						details: { diff: diffResult.diff, applied: false },
					};
				}

				try {
					await fsAccess(absolutePath, constants.W_OK);
				} catch (error: unknown) {
					const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
					throw new Error(`Could not write file: ${input.path}. Error code: ${code}.`);
				}

				const finalContent = stripped.bom + restoreLineEndings(newContent, originalEnding);
				await fsWriteFile(absolutePath, finalContent, "utf-8");

				return {
					content: [{ type: "text", text: `Applied ${input.expression} to ${input.path}.` }],
					details: { diff: diffResult.diff, applied: true },
				};
			};

			if (!input.apply) {
				return run();
			}
			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
				return run();
			});
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "sed" as const });
}

export function createSedTool(cwd: string): AgentTool<typeof sedSchema> {
	return wrapToolDefinition(createSedToolDefinition(cwd));
}
