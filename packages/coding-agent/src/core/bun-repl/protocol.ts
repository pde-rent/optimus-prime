export interface BunReplExecuteRequest {
	id: string;
	type: "execute";
	code: string;
	timeout: number;
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
	data: Record<string, unknown>;
}

export interface BunReplListNamesRequest {
	id: string;
	type: "listNames";
}

export type BunReplHostToRepl =
	| BunReplExecuteRequest
	| BunReplInterruptRequest
	| BunReplShutdownRequest
	| BunReplSnapshotRequest
	| BunReplRestoreRequest
	| BunReplListNamesRequest
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
	displayData?: Array<{ mime: string; data: unknown }>;
}

export interface BunReplIdle {
	id: string;
	type: "idle";
}

export interface BunReplSnapshotResult {
	id: string;
	type: "snapshotResult";
	status: "ok" | "error";
	data?: Record<string, unknown>;
	error?: string;
}

export interface BunReplRestoreResult {
	id: string;
	type: "restoreResult";
	status: "ok" | "error";
	restoredNames?: string[];
	error?: string;
}

export interface BunReplListNamesResult {
	id: string;
	type: "listNamesResult";
	names: string[];
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
	| BunReplHostRequest
	| BunReplHostResponse;
