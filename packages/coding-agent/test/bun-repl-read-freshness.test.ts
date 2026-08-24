import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";

// Regression for reports of agents seeing stale file contents between reads.
// Every kernel read path must hit the filesystem on every call: no
// path->content cache may sit in front of read(), %%bash or search().
describe("REPL read freshness across external file mutations", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-repl-fresh-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	const q = (value: string): string => JSON.stringify(value);

	async function withManager(run: (manager: BunReplManager) => Promise<void>): Promise<void> {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			await run(manager);
		} finally {
			await manager.shutdown();
		}
	}

	it("read() sees new bytes after an external rewrite between two calls", async () => {
		await withManager(async (manager) => {
			const path = join(tempDir, "fresh.txt");
			writeFileSync(path, "version-one");

			const first = await manager.execute(`read(${q(path)})`);
			expect(first.status).toBe("ok");
			expect(first.result).toBe(JSON.stringify("version-one"));

			writeFileSync(path, "version-two");

			const second = await manager.execute(`read(${q(path)})`);
			expect(second.status).toBe("ok");
			expect(second.result).toBe(JSON.stringify("version-two"));
		});
	});

	it("in one cell read() matches a fresh Bun.file read of the same path", async () => {
		await withManager(async (manager) => {
			const path = join(tempDir, "same-cell.txt");
			writeFileSync(path, "old-layout");
			writeFileSync(path, "new-layout");

			const r = await manager.execute(`JSON.stringify([read(${q(path)}), await Bun.file(${q(path)}).text()])`);
			expect(r.status).toBe("ok");
			expect(JSON.parse(JSON.parse(r.result ?? '""') as string)).toEqual(["new-layout", "new-layout"]);
		});
	});

	it("%%bash cat sees new bytes after an external rewrite", async () => {
		await withManager(async (manager) => {
			const path = join(tempDir, "cat.txt");
			writeFileSync(path, "cat-old");
			await manager.execute(`read(${q(path)})`);

			writeFileSync(path, "cat-new");

			const r = await manager.execute(`%%bash
cat ${JSON.stringify(path)}`);
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("cat-new");
		});
	});
});
