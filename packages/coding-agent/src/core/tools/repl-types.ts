/**
 * Shared REPL-facing types. `Kernel*` names the REPL child process — the
 * long-lived Bun process (`src/core/bun-repl/`) that executes cells — and is
 * part of the public `repl` tool-details contract extensions and the TUI read.
 */

/** Display MIME carrying one file edit, emitted by the `edit` skill. */
export const DIFF_DISPLAY_MIME = "application/vnd.optimus-prime.diff+json";

/** Display MIME carrying one agent-message send receipt. */
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.optimus-prime.agent-message+json";

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

/** Input accepted by the agent's `repl` tool. */
export interface ReplToolInput {
	code: string;
}

/** Tool-result details surfaced to the UI for the `repl` tool. */
export interface ReplToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Diffs streamed from file edits, rendered by the REPL cell. */
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
