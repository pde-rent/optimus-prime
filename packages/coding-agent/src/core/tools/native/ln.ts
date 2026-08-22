import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { link as fsLink, symlink as fsSymlink } from "fs/promises";
import type { ToolDefinition } from "../../extensions/types.js";
import { withFileMutationQueue } from "../file-mutation-queue.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";

const lnSchema = Type.Object(
	{
		target: Type.String({ description: "Existing file the new link points at (relative or absolute)." }),
		linkPath: Type.String({ description: "Path of the link to create. It must not already exist." }),
		linkType: Type.Optional(
			Type.Union([Type.Literal("symbolic"), Type.Literal("hard")], {
				description:
					"symbolic (default) creates a symlink; hard creates a hardlink (same filesystem only, never for directories).",
			}),
		),
	},
	{ additionalProperties: false },
);

export type LnToolInput = Static<typeof lnSchema>;

export interface LnToolDetails {
	linkType: "symbolic" | "hard";
	target: string;
	linkPath: string;
}

/**
 * Create a symbolic or hard link, entirely in-process.
 *
 * Use when two paths must reference the same content without a copy. Do not
 * use it to duplicate content that should evolve independently - write_file
 * makes real copies - and note that symlinks on Windows may require developer
 * or administrator privileges; the OS error is reported verbatim. Failures
 * report the exact problem: "Link target does not exist: <target>.",
 * "Link destination already exists: <linkPath>.",
 * "Could not create link: <reason>."
 */
export function createLnToolDefinition(cwd: string): ToolDefinition<typeof lnSchema, LnToolDetails> {
	const definition: ToolDefinition<typeof lnSchema, LnToolDetails> = {
		name: "ln",
		label: "ln",
		description:
			'Create a symbolic link (default) or hardlink to an existing file, without spawning a shell. Use it when two paths must share one content inode; do not use it for independent copies (write_file) and remember hardlinks cannot cross filesystems or point at directories, while Windows symlinks may need elevated privileges - the OS error is passed through. The destination must not already exist. Failures report the exact problem: "Link target does not exist: <target>.", "Link destination already exists: <linkPath>.", "Could not create link: <reason>."',
		promptSnippet: "Create a symbolic or hard link",
		parameters: lnSchema,
		kind: "edit",
		read_only: false,
		async execute(
			_toolCallId,
			input: LnToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: LnToolDetails }> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const targetAbs = resolveToCwd(input.target, cwd);
			const linkAbs = resolveToCwd(input.linkPath, cwd);
			const linkType = input.linkType ?? "symbolic";

			if (!existsSync(targetAbs)) {
				throw new Error(`Link target does not exist: ${input.target}.`);
			}
			if (existsSync(linkAbs)) {
				throw new Error(`Link destination already exists: ${input.linkPath}.`);
			}

			await withFileMutationQueue(linkAbs, async () => {
				try {
					if (linkType === "hard") {
						await fsLink(targetAbs, linkAbs);
					} else {
						await fsSymlink(targetAbs, linkAbs);
					}
				} catch (error: unknown) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new Error(`Could not create link: ${reason}`);
				}
			});

			return {
				content: [{ type: "text", text: `Created ${linkType} link ${input.linkPath} -> ${input.target}.` }],
				details: { linkType, target: input.target, linkPath: input.linkPath },
			};
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "ln" as const });
}

export function createLnTool(cwd: string): AgentTool<typeof lnSchema> {
	return wrapToolDefinition(createLnToolDefinition(cwd));
}
