import type { KernelDiffDisplay, KernelSentAgentMessage } from "../tools/repl-types.js";

export interface BunReplExecuteRequest {
	id: string;
	type: "execute";
	code: string;
	timeout: number;
	/** Custom shell binary for bare %%bash cells (defaults to "bash"). */
	shellPath?: string;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
}

export interface BunReplInterruptRequest {
	id: string;
	type: "interrupt";
}

export interface BunReplShutdownRequest {
	id: string;
	type: "shutdown";
	snapshot?: boolean;
}

export interface BunReplSnapshotRequest {
	id: string;
	type: "snapshot";
}

export interface BunReplRestoreRequest {
	id: string;
	type: "restore";
	/** Structured-clone payload, base64 so it survives the newline-JSON transport. */
	dataB64?: string;
	/** Payload of a snapshot written before the structured-clone format. */
	data?: Record<string, unknown>;
}

export interface BunReplClearNamespaceRequest {
	id: string;
	type: "clearNamespace";
}

export interface BunReplListNamesRequest {
	id: string;
	type: "listNames";
}

/** Read rendered namespace values so an assistant message can reference them by name. */
export interface BunReplResolveRefsRequest {
	id: string;
	type: "resolveRefs";
	names: string[];
	/** Per-name ceiling on the rendered string. The host owns the policy, so it travels with the ask. */
	maxChars: number;
}

export type BunReplHostToRepl =
	| BunReplExecuteRequest
	| BunReplInterruptRequest
	| BunReplShutdownRequest
	| BunReplSnapshotRequest
	| BunReplRestoreRequest
	| BunReplClearNamespaceRequest
	| BunReplListNamesRequest
	| BunReplResolveRefsRequest
	| BunReplHostResponse;

export interface BunReplStdoutChunk {
	id: string;
	type: "stdout";
	chunk: string;
}

export interface BunReplStderrChunk {
	id: string;
	type: "stderr";
	chunk: string;
}

export interface BunReplResult {
	id: string;
	type: "result";
	status: "ok" | "error";
	value?: string;
	error?: string;
	/** Constructor name of a thrown error (`TypeError`, …), for the tool's error summary. */
	errorName?: string;
	/** Stack lines of a thrown error, as the traceback shown to the model. */
	traceback?: string[];
	displayData?: Array<{ mime: string; data: unknown }>;
	/** File edits emitted via `display()`, in order, for inline diff rendering. */
	diffs?: KernelDiffDisplay[];
	/** Agent-family messages sent from within this cell, for surfacing on the host tool result. */
	sentAgentMessages?: KernelSentAgentMessage[];
}

export interface BunReplIdle {
	id: string;
	type: "idle";
}

export interface BunReplSnapshotResult {
	id: string;
	type: "snapshotResult";
	status: "ok" | "error";
	/**
	 * Structured-clone payload, base64-encoded. The child serializes, because the host
	 * link is newline-delimited JSON and would flatten Map/Set/Date back to `{}` in transit.
	 */
	dataB64?: string;
	/** Names carried by the payload, so the host can write a manifest without decoding it. */
	names?: string[];
	/**
	 * Names present in the namespace that the snapshot could not carry: live handles,
	 * symbols, and functions whose source cannot be re-evaluated. Recorded here so a later
	 * restore can tell the model exactly what it lost rather than silently omitting it.
	 */
	dropped?: string[];
	error?: string;
}

export interface BunReplRestoreResult {
	id: string;
	type: "restoreResult";
	status: "ok" | "error";
	restoredNames?: string[];
	/** Names the previous session held that did not come back. */
	failed?: string[];
	error?: string;
}

export interface BunReplListNamesResult {
	id: string;
	type: "listNamesResult";
	names: string[];
	/** Per-name type badge (`string`, `map`, …) for user-facing variable listings. */
	types?: Record<string, string>;
}

export interface BunReplClearNamespaceResult {
	id: string;
	type: "clearNamespaceResult";
	status: "ok" | "error";
	/** Number of user-defined names removed from the namespace. */
	cleared?: number;
	error?: string;
}

/**
 * One resolved reference: either the text to splice in, or why there is none.
 * Never both, and never neither -- a reference that resolves to nothing has to
 * name its reason, because a silently dropped table is the failure being fixed.
 */
export interface BunReplResolvedRef {
	name: string;
	text?: string;
	error?: string;
}

export interface BunReplResolveRefsResult {
	id: string;
	type: "resolveRefsResult";
	refs: BunReplResolvedRef[];
}

/** A sent agent message that arrived after its cell's result frame. */
export interface BunReplLateSentAgentMessage {
	/** Execute id of the cell that issued the send. */
	id: string;
	type: "lateSentAgentMessage";
	message: KernelSentAgentMessage;
}

export interface BunReplHostRequest {
	type: "hostRequest";
	requestId: string;
	requestType: string;
	payload: Record<string, unknown>;
}

export interface BunReplHostResponse {
	id: string;
	type: "hostResponse";
	requestId: string;
	status: "ok" | "error";
	data?: unknown;
	error?: string;
}

export type BunReplReplToHost =
	| BunReplStdoutChunk
	| BunReplStderrChunk
	| BunReplResult
	| BunReplIdle
	| BunReplSnapshotResult
	| BunReplRestoreResult
	| BunReplListNamesResult
	| BunReplResolveRefsResult
	| BunReplLateSentAgentMessage
	| BunReplHostRequest
	| BunReplHostResponse
	| BunReplClearNamespaceResult;
