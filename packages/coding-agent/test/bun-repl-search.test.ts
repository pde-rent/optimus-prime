import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";

// search()/ls() are the kernel's native repo-inspection primitives: they must cover
// grep/find/ls well enough that a cell never needs a shell to look around a repo.
describe("Bun REPL repo inspection globals", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-repl-search-"));
		mkdirSync(join(tempDir, "src"), { recursive: true });
		mkdirSync(join(tempDir, "dist"));
		writeFileSync(join(tempDir, "src", "a.ts"), "const alpha = 1;\nconst beta = alpha + 1;\n");
		writeFileSync(join(tempDir, "src", "b.ts"), "// TODO: fix alpha usage\nexport {};\n");
		writeFileSync(join(tempDir, "README.md"), "# alpha docs\n");
		// Ignored by default: node_modules, .git, dist.
		writeFileSync(join(tempDir, "dist", "bundle.js"), "const alpha = 99;\n");
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	const start = async (): Promise<BunReplManager> => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		return manager;
	};

	it("finds matches across files as { file, line, text }, grouped per file", async () => {
		const manager = await start();
		try {
			const r = await manager.execute("JSON.stringify(search('alpha'))");
			expect(r.status).toBe("ok");
			const matches = JSON.parse(JSON.parse(r.result ?? '""')) as Array<{
				file: string;
				line: number;
				text: string;
			}>;
			expect(matches).toEqual([
				{ file: "README.md", line: 1, text: "# alpha docs" },
				{ file: "src/a.ts", line: 1, text: "const alpha = 1;" },
				{ file: "src/a.ts", line: 2, text: "const beta = alpha + 1;" },
				{ file: "src/b.ts", line: 1, text: "// TODO: fix alpha usage" },
			]);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("scopes files with glob and regex syntax works in the pattern", async () => {
		const manager = await start();
		try {
			const r = await manager.execute("JSON.stringify(search('TODO:.*alpha', { glob: 'src/**' }))");
			expect(r.status).toBe("ok");
			const matches = JSON.parse(JSON.parse(r.result ?? '""')) as Array<{ file: string }>;
			expect(matches).toEqual([{ file: "src/b.ts", line: 1, text: "// TODO: fix alpha usage" }]);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("skips node_modules/.git/dist and binary files by default, but not with an explicit escape hatch absent", async () => {
		const manager = await start();
		try {
			writeFileSync(join(tempDir, "bin.dat"), Buffer.from([0x61, 0x6c, 0x00, 0x70, 0x68, 0x61]));
			const r = await manager.execute("JSON.stringify(search('alpha').map((m) => m.file))");
			expect(r.status).toBe("ok");
			const files = JSON.parse(JSON.parse(r.result ?? '""')) as string[];
			expect(files).not.toContain("dist/bundle.js");
			expect(files).not.toContain("bin.dat");
			expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("caps results at maxResults and truncates lines at maxCharsPerLine", async () => {
		const manager = await start();
		try {
			writeFileSync(join(tempDir, "many.txt"), Array.from({ length: 50 }, (_, i) => `hit ${i}`).join("\n"));
			const capped = await manager.execute("JSON.stringify({ n: search('hit', { maxResults: 10 }).length })");
			expect(capped.status).toBe("ok");
			expect(JSON.parse(JSON.parse(capped.result ?? '""')).n).toBe(10);

			const long = `${"x".repeat(500)} needle`;
			writeFileSync(join(tempDir, "long.txt"), long);
			const truncated = await manager.execute(
				`JSON.stringify(search('needle', { glob: 'long.txt', maxCharsPerLine: 20 }).map((m) => m.text))`,
			);
			expect(truncated.status).toBe("ok");
			expect(JSON.parse(JSON.parse(truncated.result ?? '""'))).toEqual([`${`x`.repeat(20)}…`]);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("rejects an invalid regex with a clear message", async () => {
		const manager = await start();
		try {
			const r = await manager.execute("search('alpha(')");
			expect(r.status).toBe("error");
			expect(r.error?.evalue).toContain("search: invalid regular expression");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("returns an empty array when nothing matches", async () => {
		const manager = await start();
		try {
			const r = await manager.execute("JSON.stringify(search('no-such-token-anywhere'))");
			expect(r.status).toBe("ok");
			expect(JSON.parse(JSON.parse(r.result ?? '""'))).toEqual([]);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("lists files through ls() with glob scoping and skips ignored directories", async () => {
		const manager = await start();
		try {
			const all = await manager.execute("JSON.stringify(ls())");
			expect(all.status).toBe("ok");
			const paths = JSON.parse(JSON.parse(all.result ?? '""')) as string[];
			expect(paths).toContain("src/a.ts");
			expect(paths).toContain("README.md");
			expect(paths).not.toContain("dist/bundle.js");

			const scoped = await manager.execute("JSON.stringify(ls('src/**/*.ts', { limit: 1 }))");
			expect(scoped.status).toBe("ok");
			const scopedPaths = JSON.parse(JSON.parse(scoped.result ?? '""')) as string[];
			expect(scopedPaths).toHaveLength(1);
			expect(scopedPaths[0]).toMatch(/^src\/[ab]\.ts$/);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});
});
