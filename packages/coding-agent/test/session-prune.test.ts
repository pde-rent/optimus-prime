import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEmptyArchivedChildSession, pruneEmptyArchivedChildSessions } from "../src/core/session-file-actions.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	daemonInternals,
	makeDaemon,
	type PassiveRlmSubagentFixture,
	sessionFixture,
	withTempDir,
} from "./helpers/daemon-harness.js";
import { userMsg } from "./utilities.js";

type PassiveRow = PassiveRlmSubagentFixture & { info: SessionInfo };

type ListPassiveRlmSubagents = (
	savedRoots?: readonly SessionInfo[],
	includeResident?: boolean,
) => Promise<PassiveRow[]>;

function writeLegacyRegistry(parentArtifactDir: string, entries: Array<Record<string, unknown>>): void {
	writeFileSync(
		join(parentArtifactDir, "rlm-subagents.jsonl"),
		`${entries.map((entry) => JSON.stringify({ type: "rlm_subagent", status: "completed", ...entry })).join("\n")}\n`,
	);
}

function legacyEntry(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		rlmMaxDepth: 4,
		createdAt: 1,
		...overrides,
	};
}

function makePruneDaemon(tempDir: string, sessionDir: string) {
	return makeDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir, sessionDir });
}

describe("pruning empty archived child sessions", () => {
	it("never qualifies a top-level or non-empty session", async () => {
		await withTempDir("optimus-prune-predicate-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const root = SessionManager.create(tempDir, sessionDir);
			root.newSession();
			root.appendSessionState({ status: "archived" });
			const rootInfo = (await SessionManager.list(tempDir, sessionDir))[0]!;
			expect(rootInfo.messageCount).toBe(0);
			// Top-level sessions are never prunable, even archived and message-less.
			expect(isEmptyArchivedChildSession(rootInfo)).toBe(false);

			// An archived child that produced at least one message is kept.
			const childDir = join(root.getSessionArtifactDir()!, "sub-aaa11111");
			const child = SessionManager.create(tempDir, childDir);
			child.newSession({ parentSession: root.getSessionFile() });
			child.appendMessage(userMsg("did work"));
			child.appendSessionState({ status: "archived" });
			child.flushNow();
			const childInfo = (await readSessionInfo(child.getSessionFile()!))!;
			expect(childInfo.messageCount).toBe(1);
			expect(isEmptyArchivedChildSession(childInfo)).toBe(false);
			expect(await pruneEmptyArchivedChildSessions([rootInfo, childInfo])).toEqual([]);
			expect(existsSync(child.getSessionFile()!)).toBe(true);
		});
	});

	it("prunes a zero-message archived child on the passive listing and keeps a one-message sibling", async () => {
		await withTempDir("optimus-prune-passive-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			const parentSessionFile = parentManager.getSessionFile()!;
			const parentArtifactDir = parentManager.getSessionArtifactDir()!;

			// Child archived before ever producing a turn.
			const emptyChildDir = join(parentArtifactDir, "sub-aaaaaa01");
			const emptyChild = SessionManager.create(tempDir, emptyChildDir);
			emptyChild.newSession({ parentSession: parentSessionFile });
			emptyChild.appendSessionState({ status: "archived" });
			emptyChild.flushNow();
			const emptyChildFile = emptyChild.getSessionFile()!;
			expect(existsSync(emptyChildFile)).toBe(true);

			// Sibling that produced a message before being archived.
			const doneChildDir = join(parentArtifactDir, "sub-bbbbbbb2");
			const doneChild = SessionManager.create(tempDir, doneChildDir);
			doneChild.newSession({ parentSession: parentSessionFile });
			doneChild.appendMessage(userMsg("finished the task"));
			doneChild.appendSessionState({ status: "archived" });
			doneChild.flushNow();

			writeLegacyRegistry(parentArtifactDir, [
				legacyEntry({
					childId: "empty-child",
					sessionName: "empty-worker",
					sessionDir: emptyChildDir,
					sessionFile: emptyChildFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmParentNodeId: "empty-child",
				}),
				legacyEntry({
					childId: "done-child",
					sessionName: "done-worker",
					sessionDir: doneChildDir,
					sessionFile: doneChild.getSessionFile(),
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmParentNodeId: "done-child",
					createdAt: 2,
				}),
			]);

			const daemon = makePruneDaemon(tempDir, sessionDir);
			try {
				const internals = daemonInternals(daemon);
				internals.sessions.set(
					"parent-active",
					sessionFixture("parent-active", { sessionFile: parentSessionFile }),
				);
				const listPassive = internals.listPassiveRlmSubagents.bind(internals) as ListPassiveRlmSubagents;

				const passive = await listPassive();
				expect(passive.map((row) => row.entry.childId)).toEqual(["done-child"]);
				expect(existsSync(emptyChildFile)).toBe(false);
				expect(existsSync(doneChild.getSessionFile()!)).toBe(true);
			} finally {
			}
		});
	});

	it("never prunes a running (resident) zero-message archived child", async () => {
		await withTempDir("optimus-prune-running-child-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			const parentSessionFile = parentManager.getSessionFile()!;
			const parentArtifactDir = parentManager.getSessionArtifactDir()!;

			const childDir = join(parentArtifactDir, "sub-cccccc03");
			const child = SessionManager.create(tempDir, childDir);
			child.newSession({ parentSession: parentSessionFile });
			// A stale archived marker on disk must not matter while the child runs.
			child.appendSessionState({ status: "archived" });
			child.flushNow();
			const childFile = child.getSessionFile()!;

			writeLegacyRegistry(parentArtifactDir, [
				legacyEntry({
					childId: "running-child",
					sessionName: "busy-worker",
					sessionDir: childDir,
					sessionFile: childFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmParentNodeId: "running-child",
				}),
			]);

			const daemon = makePruneDaemon(tempDir, sessionDir);
			try {
				const internals = daemonInternals(daemon);
				internals.sessions.set(
					"parent-active",
					sessionFixture("parent-active", { sessionFile: parentSessionFile }),
				);
				// The child is resident in daemon memory: running, so never prunable.
				internals.sessions.set(
					"child-active",
					sessionFixture("child-active", { kind: "subagent", sessionFile: childFile }),
				);
				const listPassive = internals.listPassiveRlmSubagents.bind(internals) as ListPassiveRlmSubagents;

				await listPassive([], false);
				expect(existsSync(childFile)).toBe(true);

				const passive = await listPassive([], true);
				expect(passive.map((row) => row.entry.childId)).toContain("running-child");
				expect(existsSync(childFile)).toBe(true);
			} finally {
			}
		});
	});
});
