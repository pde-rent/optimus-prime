import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { KernelAttachment } from "../tools/kernel-types.js";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.js";
import { BunReplProvisioner } from "./provisioner.js";

const bunReplSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript/TypeScript code to execute in the persistent REPL. Variables and imports persist across calls. Use %%bash for shell commands.",
	}),
});

export interface BunReplToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Media attachments emitted via `display()`, loaded into context (surfaced as images). */
	attachments?: KernelAttachment[];
	error?: { ename: string; evalue: string; traceback: string[] };
}

/** Turn REPL attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

export interface BunReplToolOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>>;
	snapshotDir?: string;
	provisioner?: BunReplProvisioner;
}

export function createBunReplToolDefinition(
	_options: BunReplToolOptions,
): ToolDefinition<typeof bunReplSchema, BunReplToolDetails> {
	const provisioner =
		_options.provisioner ??
		new BunReplProvisioner({
			cwd: _options.cwd,
			env: _options.env,
			hostHandlers: _options.hostHandlers,
			snapshotDir: _options.snapshotDir,
		});

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute JavaScript/TypeScript code in a persistent Bun REPL. Variables and imports persist across calls, and are revived on a best-effort basis when a session is resumed. Use %%bash cells for shell commands.",
		promptSnippet:
			"ipython - persistent agent REPL for JavaScript/TypeScript scratchpad code and %%bash orchestration",
		executionMode: "sequential",
		parameters: bunReplSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
			try {
				const manager = await provisioner.ensure(signal);

				const code = params.code;
				const result = await manager.execute(code, { signal });

				let text = result.stdout;
				if (result.stderr) text += (text ? "\n" : "") + result.stderr;
				if (result.result) text += (text ? "\n" : "") + result.result;
				if (result.status === "error" && result.error) {
					text += (text ? "\n" : "") + result.error.traceback.join("\n");
				}

				const imageBlocks = imageBlocksFromAttachments(result.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: result.durationMs,
						status: result.status,
						stdout: result.stdout,
						stderr: result.stderr,
						result: result.result,
						attachments: result.attachments,
						error: result.error,
					},
					isError: result.status === "error" || result.status === "aborted",
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `REPL error: ${message}` }],
					details: { status: "error" },
					isError: true,
				};
			}
		},
	};
}

export function createBunReplTool(options?: BunReplToolOptions): AgentTool<typeof bunReplSchema> {
	return wrapToolDefinition(createBunReplToolDefinition(options ?? {}));
}
