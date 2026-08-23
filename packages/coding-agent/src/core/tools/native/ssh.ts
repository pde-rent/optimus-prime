import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { NetError } from "../../net/core.js";
import { type SshExecResult, scpGet, scpPut, sshExec } from "../../net/ssh.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";

const sshSchema = Type.Object(
	{
		op: Type.Union([Type.Literal("exec"), Type.Literal("put"), Type.Literal("get")], {
			description:
				"exec = run one remote command; put = copy a local file to the host; get = copy a remote file here.",
		}),
		host: Type.String({ description: "Remote hostname or IP; ~/.ssh/config aliases work." }),
		command: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"exec only: command as an argv array, one element per word - no shell quoting needed and none is interpreted locally.",
			}),
		),
		localPath: Type.Optional(
			Type.String({ description: "put/get only: local file path (relative paths resolve against cwd)." }),
		),
		remotePath: Type.Optional(Type.String({ description: "put/get only: remote file path on the host." })),
		port: Type.Optional(Type.Number({ description: "Remote SSH port (default 22)." })),
		user: Type.Optional(Type.String({ description: "Remote user; omit to let ssh config decide." })),
		identityFile: Type.Optional(
			Type.String({
				description: "Path to a private key. Keys come from your own ssh setup - never paste key material.",
			}),
		),
		sshArgs: Type.Optional(
			Type.Array(Type.String(), {
				description: 'Extra ssh arguments passed through verbatim, e.g. ["-J", "jumphost"].',
			}),
		),
		strictHostKeyChecking: Type.Optional(
			Type.Union([Type.Literal("yes"), Type.Literal("accept-new")], {
				description:
					'Host-key policy: "yes" (default) refuses unknown hosts; "accept-new" trusts first contact, never skips verification.',
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({ description: "Kill the operation after this many milliseconds (default 30000)." }),
		),
	},
	{ additionalProperties: false },
);

export type SshToolInput = Static<typeof sshSchema>;

export interface SshToolDetails {
	op: "exec" | "put" | "get";
	host: string;
	/** exec only. */
	exitCode?: number;
	truncated?: boolean;
	/** put/get only. */
	bytesTransferred?: number;
}

/**
 * Run commands on remote hosts and move files over scp, using the system ssh
 * client (BatchMode: prompts fail fast instead of hanging).
 *
 * Use it for hosts configured in ~/.ssh/config or reachable by key auth -
 * agent forwarding, ProxyJump and known_hosts all behave exactly as they do
 * for your shell. Do NOT use it for bulk directory sync (use rsync via bash),
 * for interactive programs (no TTY, no way to answer prompts), or with literal
 * passwords (unsupported; keys and ssh-agent only). Failures report the exact
 * problem: "Could not find ssh on PATH.", "Command failed on <host>: exit 1 -
 * <stderr tail>.", or a timeout notice naming the killed operation.
 */
export function createSshToolDefinition(cwd: string): ToolDefinition<typeof sshSchema, SshToolDetails> {
	const definition: ToolDefinition<typeof sshSchema, SshToolDetails> = {
		name: "ssh",
		label: "ssh",
		description:
			"Run commands (op=exec) or copy single files (op=put/get) on remote hosts via the system ssh/scp client - the default and fastest way to reach remote machines from here; non-interactive BatchMode with your keys and ~/.ssh/config as-is. Not for bulk sync (rsync via bash), interactive programs or password auth.",
		promptSnippet: "Run commands or copy files on remote hosts via system ssh/scp - BatchMode, key auth",
		parameters: sshSchema,
		executionMode: "sequential",
		kind: "execute",
		read_only: false,
		async execute(
			_toolCallId,
			input: SshToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: SshToolDetails }> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const target = {
				host: input.host,
				port: input.port,
				user: input.user,
				identityFile: input.identityFile,
				strictHostKeyChecking: input.strictHostKeyChecking,
				connectTimeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
			};

			try {
				if (input.op === "exec") {
					if (!input.command?.length) throw new Error("exec requires command (array of argv words).");
					const result = await sshExec(target, input.command, { timeoutMs: input.timeoutMs ?? 30_000, signal });
					return {
						content: [{ type: "text", text: formatExec(input.host, result) }],
						details: toDetails(input, result),
					};
				}
				if (!input.localPath || !input.remotePath)
					throw new Error(`${input.op} requires localPath and remotePath.`);
				const transfer =
					input.op === "put"
						? await scpPut(target, cwd, input.localPath, input.remotePath, {
								timeoutMs: input.timeoutMs ?? 30_000,
								signal,
							})
						: await scpGet(target, cwd, input.remotePath, input.localPath, {
								timeoutMs: input.timeoutMs ?? 30_000,
								signal,
							});
				return {
					content: [
						{
							type: "text",
							text: `copied ${transfer.bytes} bytes ${input.op === "put" ? input.localPath : transfer.remotePath} <-> ${input.op === "put" ? transfer.remotePath : input.localPath} (${transfer.bytes} bytes).`,
						},
					],
					details: toDetails(input, undefined, transfer.bytes),
				};
			} catch (error: unknown) {
				throw normalizeError(error);
			}
		},
	};
	return definition;
}

function formatExec(host: string, result: SshExecResult): string {
	if (result.exitCode === 0) {
		let text = result.stdout.trimEnd();
		if (result.stderr.trim()) text += `${text ? "\n\n" : ""}[stderr]\n${result.stderr.trimEnd()}`;
		if (result.truncated) text += "\n[output truncated]";
		return text || "(no output)";
	}
	const tail = result.stderr.trim().split("\n").slice(-3).join("; ");
	return `Command failed on ${host}: exit ${result.exitCode}${tail ? ` - ${tail}` : ""}`;
}

function toDetails(input: SshToolInput, exec?: SshExecResult, bytes?: number): SshToolDetails {
	return {
		op: input.op,
		host: input.host,
		exitCode: exec?.exitCode,
		truncated: exec?.truncated,
		bytesTransferred: bytes,
	};
}

function normalizeError(error: unknown): unknown {
	if (error instanceof NetError) return error;
	return error;
}

export function createSshTool(cwd: string): AgentTool<typeof sshSchema> {
	return wrapToolDefinition(createSshToolDefinition(cwd));
}
