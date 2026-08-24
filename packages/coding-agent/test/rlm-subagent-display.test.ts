import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RlmSubagentDisplayEntry,
	readRlmSubagentDisplayEntry,
	rlmSubagentDisplayPath,
	writeRlmSubagentDisplayEntry,
} from "../src/modes/daemon/rlm-subagent-display.js";

function makeEntry(sessionDir: string, overrides: Partial<RlmSubagentDisplayEntry> = {}): RlmSubagentDisplayEntry {
	return {
		type: "rlm_subagent",
		childId: "sub-1234abcd",
		sessionName: "worker",
		sessionDir,
		sessionFile: join(sessionDir, "01a0-child.jsonl"),
		rlmMaxDepth: 4,
		rlmParentNodeId: "sub-1234abcd",
		prompt: "do the work",
		spawnCode: "await rlm('do the work')",
		model: { provider: "test", modelId: "model" },
		status: "running",
		createdAt: 1,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("rlm subagent display files", () => {
	it("round-trips an entry and replaces it atomically without temp-file residue", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			writeRlmSubagentDisplayEntry(entry);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);

			const updated = makeEntry(sessionDir, { status: "deleted", updatedAt: "2026-01-01T00:00:01.000Z" });
			writeRlmSubagentDisplayEntry(updated);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(updated);
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reads tolerantly: missing, malformed, and invalid files are undefined", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-tolerant-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(rlmSubagentDisplayPath(sessionDir), "{not json");
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			writeFileSync(rlmSubagentDisplayPath(sessionDir), JSON.stringify({ type: "rlm_subagent", childId: 42 }));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			writeFileSync(
				rlmSubagentDisplayPath(sessionDir),
				JSON.stringify(makeEntry(sessionDir, { status: "exploded" as RlmSubagentDisplayEntry["status"] })),
			);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps declared parent-only edges distinct from undeclared ones across a round trip", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-peers-"));
		try {
			const parentOnlyDir = join(tempDir, "sub-parent-only");
			writeRlmSubagentDisplayEntry(makeEntry(parentOnlyDir, { peers: [] }));
			const parentOnly = await readRlmSubagentDisplayEntry(parentOnlyDir);
			expect(parentOnly?.peers).toEqual([]);

			const connectedDir = join(tempDir, "sub-connected");
			writeRlmSubagentDisplayEntry(makeEntry(connectedDir, { peers: ["reviewer", "tester"] }));
			await expect(readRlmSubagentDisplayEntry(connectedDir)).resolves.toMatchObject({
				peers: ["reviewer", "tester"],
			});

			const undeclaredDir = join(tempDir, "sub-undeclared");
			writeRlmSubagentDisplayEntry(makeEntry(undeclaredDir));
			expect((await readRlmSubagentDisplayEntry(undeclaredDir))?.peers).toBeUndefined();

			mkdirSync(join(tempDir, "sub-bad"), { recursive: true });
			writeFileSync(
				rlmSubagentDisplayPath(join(tempDir, "sub-bad")),
				JSON.stringify(makeEntry(join(tempDir, "sub-bad"), { peers: [7] as unknown as string[] })),
			);
			await expect(readRlmSubagentDisplayEntry(join(tempDir, "sub-bad"))).resolves.toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("round-trips the additive stopped status written when a child is force-killed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-stopped-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir, { status: "stopped" });
			writeRlmSubagentDisplayEntry(entry);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts unknown extra fields from newer writers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-forward-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(rlmSubagentDisplayPath(sessionDir), JSON.stringify({ ...entry, futureField: true }));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({
				childId: entry.childId,
				status: "running",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
