import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { KernelAttachment, KernelDiffDisplay, KernelSentAgentMessage } from "../tools/repl-types.js";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.js";
import { BunReplProvisioner } from "./provisioner.js";

const bunReplSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript/TypeScript code to execute in the persistent REPL. Variables and imports persist across calls. Use %%bash for shell commands.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Cell timeout in seconds. Use for cells that legitimately run long (large downloads, batch jobs); the default is the configured repl timeout (120s unless overridden in settings).",
		}),
	),
});

/** Told to the model when the REPL child was replaced mid-session. */
const REPL_RESTART_NOTICE = [
	"<repl_kernel_reset>",
	"The REPL was restarted after a cell could not be stopped any other way. Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
	"</repl_kernel_reset>",
].join("\n");

export interface BunReplToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	/** Error constructor name, read by the TUI for the collapsed error summary. */
	errorEname?: string;
	/** True when this result came after the REPL child was hard-killed and respawned. */
	kernelRestarted?: boolean;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Media attachments emitted via `display()`, loaded into context (surfaced as images). */
	attachments?: KernelAttachment[];
	/** File edits streamed from the `edit` skill, rendered inline by the REPL cell. */
	diffs?: KernelDiffDisplay[];
	/** Agent-family messages sent from within this cell, surfaced on the host tool result. */
	sentAgentMessages?: KernelSentAgentMessage[];
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
	/** Default cell timeout in ms when the call does not pass one (settings: toolTimeouts.replMs). */
	defaultTimeoutMs?: number;
	env?: Record<string, string>;
	hostHandlers?: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>>;
	snapshotDir?: string;
	/** Custom shell binary for bare %%bash cells (defaults to "bash"). */
	shellPath?: string;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	provisioner?: BunReplProvisioner;
	/** Called when a cell's agent message arrives after that cell's result. */
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
}

export function createBunReplToolDefinition(
	_options: BunReplToolOptions,
): ToolDefinition<typeof bunReplSchema, BunReplToolDetails> {
	const provisioner =
		_options.provisioner ??
		new BunReplProvisioner({
			cwd: _options.cwd,
			defaultTimeoutMs: _options.defaultTimeoutMs,
			env: _options.env,
			hostHandlers: _options.hostHandlers,
			snapshotDir: _options.snapshotDir,
			shellPath: _options.shellPath,
			commandPrefix: _options.commandPrefix,
			onLateSentAgentMessage: _options.onLateSentAgentMessage,
		});

	return {
		name: "repl",
		label: "repl",
		description:
			"Execute JavaScript/TypeScript code in a persistent Bun REPL. Variables and imports persist across calls, and are revived on a best-effort basis when a session is resumed. Use %%bash cells for shell commands. Kernel globals need no import: read(path), write(path, text), ls(dir?), search(pattern, opts?), cd(dir), pwd(), and $ for shell commands in %%bash cells.",
		promptSnippet:
			"repl - persistent Bun JavaScript/TypeScript REPL for scratchpad code and %%bash orchestration; preloaded globals: read, write, ls, search, cd, pwd",
		kind: "execute",
		read_only: false,
		executionMode: "sequential",
		parameters: bunReplSchema,
		execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
			try {
				const manager = await provisioner.ensure(signal);

				const code = params.code;
				const result = await manager.execute(code, {
					signal,
					correlationId: toolCallId,
					timeout: params.timeout !== undefined && params.timeout > 0 ? params.timeout * 1000 : undefined,
					// Stream output as it arrives so a long cell is not a blank wait.
					onStream: (chunk) => onUpdate?.({ content: [{ type: "text", text: chunk }], details: { status: "ok" } }),
				});

				let text = result.stdout;
				if (result.stderr) text += (text ? "\n" : "") + result.stderr;
				if (result.result) text += (text ? "\n" : "") + result.result;
				if (result.status === "error" && result.error) {
					// The traceback repeats the message on its first line, so fall back to the
					// message only when there is no stack to show.
					const trace =
						result.error.traceback.length > 0 ? result.error.traceback.join("\n") : result.error.evalue;
					text += (text ? "\n" : "") + trace;
				}
				// Prepended, so the model reads that its state is gone before reading the output.
				if (result.kernelRestarted) {
					text = text ? `${REPL_RESTART_NOTICE}\n\n${text}` : REPL_RESTART_NOTICE;
				}

				const imageBlocks = imageBlocksFromAttachments(result.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: result.durationMs,
						status: result.status,
						errorEname: result.error?.ename,
						kernelRestarted: result.kernelRestarted,
						stdout: result.stdout,
						stderr: result.stderr,
						result: result.result,
						attachments: result.attachments,
						diffs: result.diffs,
						sentAgentMessages: result.sentAgentMessages,
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

export function createBunReplTool(options?: BunReplToolOptions) {
	return wrapToolDefinition(createBunReplToolDefinition(options ?? {}));
}
