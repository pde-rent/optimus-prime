import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { countChangedLines } from "../../../modes/interactive/components/edit-summary.js";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { EditChangeSummaryComponent } from "../edit.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "../edit-diff.js";
import { withFileMutationQueue } from "../file-mutation-queue.js";
import { resolveToCwd } from "../path-utils.js";
import { errorTextComponent } from "../render-utils.js";
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
			"Substitute s/pattern/replacement/ in one file - the default and fastest way to apply one reviewed regex change; dry-run diff by default, apply:true writes; runs in-process on Windows/macOS/Linux; replaces bash sed -i. Not for multi-line or multi-change work - use edit; several files - grep+edit.",
		promptSnippet: "s/pattern/replacement/ in one file; dry-run diff by default; multi-edit use edit",
		parameters: sedSchema,
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				return errorTextComponent(result, theme);
			}
			const details = result.details as SedToolDetails | undefined;
			const diff = details?.diff;
			// Dry runs and no-match results are reads: show the notice line only.
			if (!details?.applied || !diff) {
				const text = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n")
					.split("\n")[0];
				return new Text(theme.fg("muted", text), 1, 0);
			}
			return new EditChangeSummaryComponent(
				context.args?.path ?? "...",
				context.cwd,
				countChangedLines(diff),
				context.expanded,
				context.expanded ? diff : undefined,
			);
		},
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
				throwIfAborted(signal);
				return run();
			});
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "sed" as const });
}

export function createSedTool(cwd: string): AgentTool<typeof sedSchema> {
	return wrapToolDefinition(createSedToolDefinition(cwd));
}
