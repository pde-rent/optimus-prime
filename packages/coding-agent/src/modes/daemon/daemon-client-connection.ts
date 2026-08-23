import type { DaemonSocketClient } from "./active-session-state.js";

/**
 * Pure per-client connection state transitions shared by every daemon-protocol
 * server endpoint (AgentDaemon and DaemonSupervisor): catch-up queueing and
 * snapshot-stream reservation counting. No I/O, no clocks - callers own the
 * socket, the drain loop, and the catch-up drain itself.
 */

export type CatchupPurpose = "replacement" | "resync";

/** Queue one session for a catch-up snapshot; "replacement" outranks "resync". */
export function queueClientCatchup(
	client: DaemonSocketClient,
	activeSessionId: string,
	purpose: CatchupPurpose = "resync",
): void {
	if (!client.catchupActiveSessionIds) {
		client.catchupActiveSessionIds = new Set();
	}
	client.catchupActiveSessionIds.add(activeSessionId);
	client.catchupPurposes ??= new Map();
	if (purpose === "replacement" || !client.catchupPurposes.has(activeSessionId)) {
		client.catchupPurposes.set(activeSessionId, purpose);
	}
}

/** Drain the queue: build the pending list and clear it atomically. */
export function takePendingClientCatchups(client: DaemonSocketClient): Array<{
	activeSessionId: string;
	purpose: CatchupPurpose;
}> {
	const pending = [...(client.catchupActiveSessionIds ?? [])].map((activeSessionId) => ({
		activeSessionId,
		purpose: client.catchupPurposes?.get(activeSessionId) ?? ("resync" as const),
	}));
	client.catchupActiveSessionIds?.clear();
	client.catchupPurposes?.clear();
	return pending;
}

/** A client can receive pushed catch-ups only when the socket is live and idle. */
export function clientCanReceiveCatchup(client: DaemonSocketClient): boolean {
	return !client.socket.destroyed && !client.snapshotStreaming && !client.backpressured;
}

/** Reserve one snapshot stream; returns the transfer's abort signal. */
export function markClientSnapshotStreaming(client: DaemonSocketClient, activeSessionId: string): AbortSignal {
	client.snapshotStreaming = true;
	client.snapshotActiveSessionIds ??= new Set();
	client.snapshotActiveSessionIds.add(activeSessionId);
	client.snapshotActiveSessionCounts ??= new Map();
	client.snapshotActiveSessionCounts.set(
		activeSessionId,
		(client.snapshotActiveSessionCounts.get(activeSessionId) ?? 0) + 1,
	);
	client.snapshotTransferAbortControllers ??= new Map();
	let controller = client.snapshotTransferAbortControllers.get(activeSessionId);
	if (!controller || controller.signal.aborted) {
		controller = new AbortController();
		client.snapshotTransferAbortControllers.set(activeSessionId, controller);
	}
	return controller.signal;
}

/** Release one reservation; the last release clears the streaming flag. */
export function finishClientSnapshotStreaming(client: DaemonSocketClient, activeSessionId: string): void {
	const count = client.snapshotActiveSessionCounts?.get(activeSessionId) ?? 1;
	if (count > 1) {
		client.snapshotActiveSessionCounts?.set(activeSessionId, count - 1);
	} else {
		client.snapshotActiveSessionCounts?.delete(activeSessionId);
		client.snapshotActiveSessionIds?.delete(activeSessionId);
		client.snapshotTransferAbortControllers?.delete(activeSessionId);
	}
	client.snapshotStreaming = (client.snapshotActiveSessionIds?.size ?? 0) > 0;
	if (!client.snapshotStreaming) {
		client.backpressured = false;
	}
}

/** Abort in-flight snapshot transfers for one session or all of them. */
export function abortClientSnapshotStreaming(client: DaemonSocketClient, activeSessionId?: string): void {
	if (activeSessionId) {
		client.snapshotTransferAbortControllers?.get(activeSessionId)?.abort();
		return;
	}
	for (const controller of client.snapshotTransferAbortControllers?.values() ?? []) {
		controller.abort();
	}
}
