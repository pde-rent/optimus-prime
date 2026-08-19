/**
 * Code shared between daemon-mode.ts and daemon-supervisor.ts.
 */

import { DAEMON_COMMAND_COMPATIBILITY } from "./daemon-protocol.js";
import type { SessionSummary } from "./daemon-session-list.js";

/**
 * Every command the daemon will route, derived from the protocol's compatibility map rather than
 * hand-listed.
 *
 * This used to be spelled out three times -- here, in the supervisor and in daemon-mode -- and a
 * command added to only one of them was accepted by the worker and rejected by the supervisor.
 * Deriving it means a command cannot exist in the protocol without being routable.
 */
export const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set(Object.keys(DAEMON_COMMAND_COMPATIBILITY));

export function promptAdmissionKey(activeSessionId: string, admissionId: string): string {
	return `${activeSessionId}\0${admissionId}`;
}

export function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<SessionSummary>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.lifecycle === "string" &&
		typeof candidate.activity === "string" &&
		typeof candidate.isSessionActive === "boolean" &&
		typeof candidate.isStreaming === "boolean" &&
		typeof candidate.isCompacting === "boolean" &&
		typeof candidate.attachedClients === "number" &&
		typeof candidate.messageCount === "number" &&
		(candidate.unfinishedActionCount === undefined || typeof candidate.unfinishedActionCount === "number") &&
		typeof candidate.sessionActions === "object" &&
		candidate.sessionActions !== null &&
		typeof candidate.sessionActions.queuedCount === "number" &&
		Array.isArray(candidate.sessionActions.steering) &&
		Array.isArray(candidate.sessionActions.followUps)
	);
}
