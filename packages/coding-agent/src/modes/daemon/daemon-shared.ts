/**
 * Code shared between daemon-mode.ts and daemon-supervisor.ts.
 */

import { DAEMON_COMMAND_COMPATIBILITY } from "./daemon-protocol.js";

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

/**
 * Shared gate for prompt commands carrying an admission id: both fields must be
 * non-empty strings before the caller registers the admission.
 */
export function validatePromptAdmissionFields(fields: { activeSessionId?: unknown; admissionId?: unknown }): {
	activeSessionId: string;
	admissionId: string;
} {
	if (typeof fields.activeSessionId !== "string" || typeof fields.admissionId !== "string") {
		throw new Error("Prompt admission requires string activeSessionId and admissionId");
	}
	if (fields.admissionId === "") throw new Error("admissionId must not be empty");
	return { activeSessionId: fields.activeSessionId, admissionId: fields.admissionId };
}
