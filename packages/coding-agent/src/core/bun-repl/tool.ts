import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
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
	error?: { ename: string; evalue: string; traceback: string[] };
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

				const content: TextContent[] = [{ type: "text", text: text || "" }];

				return {
					content,
					details: {
						durationMs: result.durationMs,
						status: result.status,
						stdout: result.stdout,
						stderr: result.stderr,
						result: result.result,
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
