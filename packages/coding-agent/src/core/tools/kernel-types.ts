/**
 * Shared REPL-facing types. The `Kernel*` names are kept because they are part of
 * the public `ipython` tool-details contract that extensions and the TUI read;
 * the implementation behind them is the Bun REPL (`src/core/bun-repl/`).
 */

/** Display MIME carrying one file edit, emitted by the `edit` skill. */
export const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

/** Display MIME carrying one agent-message send receipt. */
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

/** Handler for host requests arriving from the REPL comm bridge. */
export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Typed map of host request handlers. */
export type HostRequestHandlers = Record<string, HostRequestHandler>;

/** One file edit, captured from a display payload. */
export interface KernelDiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` begins in the file, for absolute line numbers. */
	startLine?: number;
}

/** One media attachment, captured from a display payload. */
export interface KernelAttachment {
	mimeType: string;
	/** base64-encoded bytes. */
	data: string;
	/** Source path, surfaced to the TUI renderer. */
	path?: string;
}

export interface KernelSentAgentMessage {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

/** Input accepted by the agent's `ipython` tool (now the Bun REPL backend). */
export interface IpythonToolInput {
	code: string;
}

/** Tool-result details surfaced to the UI for the `ipython` tool. */
export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Diffs streamed from file edits, rendered by the IPython cell. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}
