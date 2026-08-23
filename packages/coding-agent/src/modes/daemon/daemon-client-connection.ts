import { VERSION } from "../../config.js";
import type { DaemonSocketClient } from "./active-session-state.js";
import {
	DAEMON_DEFAULT_CLIENT_CAPABILITIES,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonClientCapability,
	type DaemonOutbound,
} from "./daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "./daemon-runtime-identity.js";

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

/** Fresh copy of the default client capability set (each connection gets its own). */
export function defaultClientCapabilities(): Set<DaemonClientCapability> {
	return new Set(DAEMON_DEFAULT_CLIENT_CAPABILITIES);
}

/**
 * Build the shared daemon_hello identity block: protocol/schema/version/runtime
 * fields every endpoint must agree on. Endpoint-specific fields (supervisor
 * fencing, worker transport hints) come in via `extras`.
 */
export function makeDaemonHello(options: {
	socketPath: string;
	clientId: string;
	extras?: Record<string, unknown>;
}): DaemonOutbound {
	return {
		type: "daemon_hello",
		socketPath: options.socketPath,
		protocol: DAEMON_PROTOCOL_INFO,
		schemaId: DAEMON_SCHEMA_ID,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		appVersion: VERSION,
		runtime: getDaemonRuntimeIdentity(),
		clientId: options.clientId,
		serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
		...options.extras,
	} as DaemonOutbound;
}

/**
 * Write serialized bytes to a client socket with the shared backpressure
 * contract: destroyed sockets report false without touching the stream, and a
 * rejected write flips `backpressured` until the socket drains. Returns
 * whether the kernel accepted the data.
 */
export function socketWriteWithBackpressure(client: DaemonSocketClient, wireData: string | Uint8Array): boolean {
	if (client.socket.destroyed) {
		return false;
	}
	const accepted = client.socket.write(wireData);
	if (!accepted) {
		client.backpressured = true;
	}
	return accepted;
}
