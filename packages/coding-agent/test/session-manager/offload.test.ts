import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeOwnAndTotalUsage } from "../../src/core/context-tree.js";
import {
	type CompactionEntry,
	type FileEntry,
	loadEntriesFromFile,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

const BIG_TEXT = "x".repeat(512 * 1024);

function createPersistedSession(cwd: string, sessionDir: string): SessionManager {
	mkdirSync(sessionDir, { recursive: true });
	return SessionManager.create(cwd, sessionDir);
}

describe("SessionManager compaction offload", () => {
	it("keeps assistant usage on stubs so computeOwnAndTotalUsage is unchanged", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-offload-usage-"));
		try {
			const session = createPersistedSession(join(tempDir, "project"), join(tempDir, "sessions"));
			const assistant1 = session.appendMessage(assistantMsg(BIG_TEXT));
			const id2 = session.appendMessage(userMsg("second prompt"));
			session.appendMessage(assistantMsg("kept response"));

			const before = computeOwnAndTotalUsage(session.getBranch(), session.getEntries());

			session.appendCompaction("summary of first turn", id2, 1234);

			// Bulk getters return stubs: content is gone, usage is not.
			const entries = session.getEntries();
			const stubbed = entries.find((e) => e.id === assistant1) as SessionMessageEntry;
			expect(stubbed.type).toBe("message");
			expect(stubbed.message.role).toBe("assistant");
			expect(stubbed.message).not.toHaveProperty("content");
			expect((stubbed.message as { usage?: unknown }).usage).toBeDefined();

			const after = computeOwnAndTotalUsage(session.getBranch(), session.getEntries());
			expect(after.totalUsage).toEqual(before.totalUsage);
			expect(after.ownUsage).toEqual(before.ownUsage);

			// Usage attribution onto an already-stubbed assistant still lands and
			// survives hydration of that stub.
			const baseAssistant = assistantMsg("x");
			if (!("usage" in baseAssistant) || baseAssistant.usage === undefined) {
				throw new Error("fixture assistant message has no usage");
			}
			const baseUsage = baseAssistant.usage;
			session.appendChildUsageAttribution(assistant1, baseUsage, baseUsage);
			const attributedTarget = session.getEntry(assistant1) as SessionMessageEntry;
			expect("usage" in attributedTarget.message ? attributedTarget.message.usage : undefined).toEqual(baseUsage);
			const attributed = computeOwnAndTotalUsage(session.getBranch(), session.getEntries());
			expect(attributed.totalUsage).toEqual(before.totalUsage);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("hydrates stubs lazily with identical entry data", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-offload-hydrate-"));
		try {
			const session = createPersistedSession(join(tempDir, "project"), join(tempDir, "sessions"));
			const id1 = session.appendMessage(userMsg(BIG_TEXT));
			const customId = session.appendCustomMessageEntry("note", "custom detail", true);
			const id2 = session.appendMessage(userMsg("kept"));
			session.appendMessage(assistantMsg("kept response"));

			session.appendCompaction("summary", id2, 10);

			const stubbedMessage = session.getEntries().find((e) => e.id === id1) as SessionMessageEntry;
			expect(stubbedMessage.message).not.toHaveProperty("content");
			const stubbedCustom = session.getEntries().find((e) => e.id === customId);
			expect(stubbedCustom?.type).toBe("custom_message");

			const hydratedMessage = session.getEntry(id1) as SessionMessageEntry;
			expect((hydratedMessage.message as { content?: string }).content).toBe(BIG_TEXT);
			const hydratedCustom = session.getEntry(customId);
			expect(hydratedCustom).toMatchObject({ type: "custom_message", content: "custom detail", display: true });

			// Hydration is persistent: the stub is replaced by the full entry.
			const again = session.getEntries().find((e) => e.id === id1) as SessionMessageEntry;
			expect((again.message as { content?: string }).content).toBe(BIG_TEXT);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps branch, tree, and context rebuild working after offload", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-offload-tree-"));
		try {
			const session = createPersistedSession(join(tempDir, "project"), join(tempDir, "sessions"));
			const id1 = session.appendMessage(userMsg("first prompt"));
			const assistant1 = session.appendMessage(assistantMsg(BIG_TEXT));
			const id2 = session.appendMessage(userMsg("second prompt"));
			const assistant2 = session.appendMessage(assistantMsg("kept response"));
			session.appendLabelChange(id1, "start");

			session.appendCompaction("summary of first turn", id2, 1234);
			const compaction = session.getEntries().find((e) => e.type === "compaction") as CompactionEntry;

			// Post-compaction context: summary + retained window, no stub leakage.
			const postCompaction = session.buildSessionContext();
			expect(postCompaction.messages).toHaveLength(3);
			expect(postCompaction.messages[0]).toMatchObject({
				role: "compactionSummary",
				summary: "summary of first turn",
			});
			expect((postCompaction.messages[1] as { content: string }).content).toBe("second prompt");

			// Branching back across the compaction boundary hydrates the path.
			session.branch(id1);
			const oldBranch = session.buildSessionContext();
			expect(oldBranch.messages).toHaveLength(1);
			expect((oldBranch.messages[0] as { content: string }).content).toBe("first prompt");

			session.branch(assistant1);
			const oldTurn = session.buildSessionContext();
			expect(oldTurn.messages).toHaveLength(2);
			expect(oldTurn.messages[1]).toMatchObject({
				role: "assistant",
				provider: "anthropic",
				model: "test",
			});

			const branchEntries = session.getBranch(assistant1);
			expect(branchEntries.map((e) => e.id)).toEqual([id1, assistant1]);
			expect((branchEntries[1] as SessionMessageEntry).message).toHaveProperty("content");

			const children = session.getChildren(id1);
			expect(children.map((e) => e.id)).toEqual([assistant1]);
			expect((children[0] as SessionMessageEntry).message).toHaveProperty("content");

			const tree = session.getTree();
			const flatIds = new Set<string>();
			const walk = (nodes: typeof tree): void => {
				for (const node of nodes) {
					flatIds.add(node.entry.id);
					walk(node.children);
				}
			};
			walk(tree);
			expect(flatIds.has(id1)).toBe(true);
			expect(flatIds.has(assistant2)).toBe(true);
			expect(session.getLabel(id1)).toBe("start");
			expect(compaction.firstKeptEntryId).toBe(id2);

			session.resetLeaf();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps full entries in the session file and restores them on rewrite", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-offload-file-"));
		try {
			const session = createPersistedSession(join(tempDir, "project"), join(tempDir, "sessions"));
			session.appendMessage(userMsg(BIG_TEXT));
			const id2 = session.appendMessage(userMsg("kept"));
			session.appendMessage(assistantMsg("kept response"));
			session.appendCompaction("summary", id2, 10);

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			// Offload must not touch the file.
			const before = readFileSync(sessionFile!, "utf8");
			expect(before).toContain(BIG_TEXT);
			const _linesBefore = before.trim().split("\n").length;

			// With the file gone the offloaded history is unrecoverable; the rewrite
			// must refuse instead of writing gutted stubs over a fresh file.
			rmSync(sessionFile!);
			expect(() => session.appendMessage(userMsg("after recovery"))).toThrow(/offloaded entries/);
			expect(existsSync(sessionFile!)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("never offloads in-memory sessions", () => {
		const session = SessionManager.inMemory();
		const id1 = session.appendMessage(userMsg(BIG_TEXT));
		const id2 = session.appendMessage(userMsg("kept"));
		session.appendMessage(assistantMsg("kept response"));
		session.appendCompaction("summary", id2, 10);

		const entry = session.getEntries().find((e) => e.id === id1) as SessionMessageEntry;
		expect((entry.message as { content?: string }).content).toBe(BIG_TEXT);
	});

	it("writes large sessions through the streaming rewrite without data loss", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-rewrite-stream-"));
		try {
			const sessionFile = join(tempDir, "legacy.jsonl");
			const header = {
				type: "session",
				version: 3,
				id: "legacy-session",
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			};
			const lines: string[] = [JSON.stringify(header)];
			for (let i = 0; i < 40; i++) {
				lines.push(
					JSON.stringify({
						type: "message",
						id: `msg${i}`,
						parentId: i === 0 ? null : `msg${i - 1}`,
						timestamp: new Date().toISOString(),
						message: userMsg(`payload ${i} ${"y".repeat(200 * 1024)}`),
					}),
				);
			}
			writeFileSync(sessionFile, `${lines.join("\n")}\n`);

			// Missing rlmDepth on a parentSession-less header forces the rewrite path.
			const session = SessionManager.open(sessionFile);
			expect(session.getSessionId()).toBe("legacy-session");

			const reloaded = loadEntriesFromFile(sessionFile) as FileEntry[];
			expect(reloaded).toHaveLength(41);
			const last = reloaded[40] as SessionMessageEntry;
			expect((last.message as { content?: string }).content).toContain("payload 39");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
