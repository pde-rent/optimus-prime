import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { getSessionArtifactPathForFile, type SessionInfo } from "./session-manager.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
export async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	// A degenerate name (".jsonl") would resolve to the artifacts root itself.
	if (!basename(sessionPath).replace(/\.jsonl$/, "")) return;
	await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}

const sessionsLog = getLogger("coding-agent.sessions");

/**
 * True when a saved session is an archived subagent session holding zero
 * messages: a child that was archived or evicted before ever producing a turn.
 * Top-level sessions and any session with at least one message never qualify.
 */
export function isEmptyArchivedChildSession(info: SessionInfo): boolean {
	if (info.state?.status !== "archived") return false;
	if (info.messageCount > 0) return false;
	// Only spawned children carry a parent edge; the user's own top-level
	// sessions never do (rlmDepth alone is unreliable under RLM_DEPTH).
	return info.parentSessionPath !== undefined;
}

/**
 * Delete the session file of every listed empty archived child session, so a
 * backlog of message-less children is cleaned instead of shown. Callers must
 * exclude currently running sessions from the input. Returns the pruned paths;
 * individual failures are logged at debug level and skipped.
 */
export async function pruneEmptyArchivedChildSessions(sessions: readonly SessionInfo[]): Promise<string[]> {
	const pruned: string[] = [];
	for (const info of sessions) {
		if (!isEmptyArchivedChildSession(info)) continue;
		let result: DeleteSessionFileResult;
		try {
			result = await deleteSessionFile(info.path);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!result.ok) {
			sessionsLog.debug("failed to prune empty archived child session", { path: info.path, error: result.error });
			continue;
		}
		sessionsLog.debug("pruned empty archived child session", { path: info.path });
		pruned.push(info.path);
	}
	return pruned;
}
