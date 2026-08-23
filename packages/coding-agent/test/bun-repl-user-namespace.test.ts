import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";

// These tests spawn a real bun kernel child and exercise the user-facing
// namespace surface behind /js, /vars and /clear-vars.

let tempDir = "";

describe("Bun REPL user namespace", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-bunrepl-ns-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("evaluates a cell, lists names with type badges, then clears them", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r1 = await manager.execute("const answer = 42; let label = 'hi'; const rows = [1, 2, 3];");
			expect(r1.status).toBe("ok");

			const listing = await manager.listNamespace();
			expect(listing).not.toBeNull();
			expect([...(listing?.names ?? [])].sort()).toEqual(["answer", "label", "rows"]);
			expect(listing?.types.answer).toBe("number");
			expect(listing?.types.label).toBe("string");
			expect(listing?.types.rows).toBe("array");

			const cleared = await manager.clearNamespace();
			expect(cleared).toBe(3);

			const after = await manager.listNamespace();
			expect(after?.names).toEqual([]);

			// Cleared top-level names are gone from globalThis, so they now read as undefined.
			const r2 = await manager.execute("typeof answer");
			expect(r2.status).toBe("ok");
			expect(r2.result).toBe('"undefined"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("clears the on-disk snapshot so a restart cannot restore cleared state", async () => {
		const snapshotDir = join(tempDir, "snapshot");
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir, snapshotDir });
		await manager.start();
		try {
			const r1 = await manager.execute("const kept = 'value'");
			expect(r1.status).toBe("ok");
			const snap = await manager.snapshotState();
			expect(snap?.names).toContain("kept");

			expect(await manager.clearNamespace()).toBe(1);
			expect(await manager.listNamespace()).toEqual({ names: [], types: {} });

			// A fresh kernel restores from the (now cleared) snapshot dir.
			await manager.restart();
			const restored = await manager.listNamespace();
			expect(restored?.names).toEqual([]);
			const r2 = await manager.execute("typeof kept");
			expect(r2.result).toBe('"undefined"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});
});
