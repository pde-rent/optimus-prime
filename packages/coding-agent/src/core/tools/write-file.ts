import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import { countChangedLines } from "../../modes/interactive/components/edit-summary.js";
import type { ToolDefinition } from "../extensions/types.js";
import { runWithAbortSignal } from "./abortable.js";
import { EditChangeSummaryComponent } from "./edit.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { formatSize } from "./truncate.js";

const writeFileSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({
			description:
				'The complete new file content; it replaces any existing content wholesale, so the whole file must be sent even to change one line. Output contract on success: a new file answers "Created <path> (<size>, <N> lines).", an overwrite answers "Successfully wrote <path>." and carries its unified diff in details.',
		}),
		createDirs: Type.Optional(
			Type.Boolean({
				description: "Only set true to create missing parent directories; without it a missing parent fails.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type WriteFileToolInput = Static<typeof writeFileSchema>;

export interface WriteFileToolDetails {
	/** Unified diff of the changes made. Undefined for newly created files. */
	diff?: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Whether this call created a new file */
	created?: boolean;
}

/**
 * Pluggable operations for the write-file tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteFileOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Create a directory tree (only called when createDirs is set) */
	mkdir: (absoluteDir: string) => Promise<void>;
}

const defaultWriteFileOperations: WriteFileOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: async (path) => {
		await fsAccess(path, constants.R_OK | constants.W_OK);
	},
	mkdir: async (path) => {
		await fsMkdir(path, { recursive: true });
	},
};

export interface WriteFileToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteFileOperations;
}

export interface WriteFileToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: WriteFileToolDetails;
}

export function createWriteFileToolDefinition(
	cwd: string,
	options?: WriteFileToolOptions,
): ToolDefinition<typeof writeFileSchema, WriteFileToolDetails> {
	const ops = options?.operations ?? defaultWriteFileOperations;
	const definition: ToolDefinition<typeof writeFileSchema, WriteFileToolDetails> = {
		name: "write_file",
		label: "write_file",
		description:
			"Write complete file content - the default and fastest way to create or wholly overwrite a file; runs in-process on Windows/macOS/Linux; replaces bash heredoc/echo redirection. Not for small targeted changes to an existing file - use edit. Failures report 'Could not write file: <path>. Error code: <code>.'",
		kind: "edit",
		read_only: false,
		promptSnippet: "Create or wholly overwrite a file with complete content",
		parameters: writeFileSchema,
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const errorText = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				return new Text(theme.fg("error", errorText), 1, 0);
			}
			const details = result.details as WriteFileToolDetails | undefined;
			const diff = details?.diff;
			// New files carry no diff; their "Created ..." notice is the whole cell.
			if (!diff) {
				const text = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				return new Text(theme.fg("muted", text), 1, 0);
			}
			return new EditChangeSummaryComponent(
				context.args?.path ?? "...",
				context.cwd,
				countChangedLines(diff),
				context.expanded,
				context.expanded ? renderDiff(diff).split("\n") : undefined,
			);
		},
		async execute(
			_toolCallId,
			input: WriteFileToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		): Promise<WriteFileToolResult> {
			const absolutePath = resolveToCwd(input.path, cwd);

			return withFileMutationQueue(absolutePath, () =>
				runWithAbortSignal<WriteFileToolResult>(signal, async (guard) => {
					// Does the target exist? Existing files must be writable; missing
					// files need either no missing parents or createDirs.
					let existed = false;
					try {
						await ops.access(absolutePath);
						existed = true;
					} catch (error: unknown) {
						const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
						if (code !== "ENOENT") {
							throw new Error(`Could not write file: ${input.path}. Error code: ${code ?? String(error)}.`);
						}
						if (input.createDirs) {
							const dir = absolutePath.replace(/[/\\]+[^/\\]+$/, "") || "/";
							try {
								await ops.mkdir(dir);
							} catch (mkdirError: unknown) {
								throw new Error(`Could not create directory for ${input.path}: ${String(mkdirError)}`);
							}
						}
					}

					guard.bail();

					let bom = "";
					let originalEnding: "\r\n" | "\n" = "\n";
					let oldContent = "";
					if (existed) {
						const buffer = await ops.readFile(absolutePath);
						const stripped = stripBom(buffer.toString("utf-8"));
						bom = stripped.bom;
						originalEnding = detectLineEnding(stripped.text);
						oldContent = normalizeToLF(stripped.text);
					}

					// Normalize the new content the same way the old content was, so the
					// diff compares like with like and the file keeps its BOM and CRLF.
					const newStripped = stripBom(input.content);
					const newBom = newStripped.bom || bom;
					const newContent = newStripped.text;
					const finalContent = newBom + restoreLineEndings(normalizeToLF(newContent), originalEnding);

					await ops.writeFile(absolutePath, finalContent);

					guard.bail();

					if (!existed) {
						const lineCount = newContent.length === 0 ? 0 : newContent.split("\n").length;
						return {
							content: [
								{
									type: "text",
									text: `Created ${input.path} (${formatSize(Buffer.byteLength(finalContent, "utf-8"))}, ${lineCount} line${lineCount === 1 ? "" : "s"}).`,
								},
							],
							details: { created: true },
						};
					}

					const diffResult = generateDiffString(oldContent, normalizeToLF(newContent));
					return {
						content: [{ type: "text", text: `Successfully wrote ${input.path}.` }],
						details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
					};
				}),
			);
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "write_file" as const });
}

export function createWriteFileTool(cwd: string, options?: WriteFileToolOptions): AgentTool<typeof writeFileSchema> {
	return wrapToolDefinition(createWriteFileToolDefinition(cwd, options));
}
