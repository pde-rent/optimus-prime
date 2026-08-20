import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";

// `read`/`write` are synchronous so a forgotten `await` still yields the value, and
// protected so a cell's own declaration cannot replace them for the session.
describe("Bun REPL file IO globals", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-repl-io-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	const q = (value: string): string => JSON.stringify(value);

	it("round-trips a file through write and read", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const path = join(tempDir, "hello.txt");
			const r = await manager.execute(`write(${q(path)}, "alpha\\nbeta\\n"); read(${q(path)})`);
			expect(r.status).toBe("ok");
			expect(r.result).toBe(JSON.stringify("alpha\nbeta\n"));
		} finally {
			await manager.shutdown();
		}
	});

	it("slices lines 1-based inclusive, with no line numbers added", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const path = join(tempDir, "lines.txt");
			const r = await manager.execute(
				`write(${q(path)}, "l1\\nl2\\nl3\\nl4\\n"); read(${q(path)}, { from: 2, to: 3 })`,
			);
			expect(r.status).toBe("ok");
			expect(r.result).toBe(JSON.stringify("l2\nl3"));
		} finally {
			await manager.shutdown();
		}
	});

	it("names the missing path rather than surfacing an ENOENT", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const path = join(tempDir, "absent.txt");
			const r = await manager.execute(`read(${q(path)})`);
			expect(r.status).toBe("error");
			expect(r.error?.evalue).toContain(`read: no such file: ${path}`);
		} finally {
			await manager.shutdown();
		}
	});

	it("creates missing parent directories and reports the absolute path and byte count", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const path = join(tempDir, "nested", "deeper", "out.txt");
			const r = await manager.execute(`JSON.stringify(write(${q(path)}, "héllo"))`);
			expect(r.status).toBe("ok");
			const out = JSON.parse(JSON.parse(r.result ?? '""')) as { path: string; bytes: number };
			expect(isAbsolute(out.path)).toBe(true);
			expect(out.path).toBe(path);
			// "héllo" is six UTF-8 bytes, so the count is bytes and not characters.
			expect(out.bytes).toBe(6);
			expect(await Bun.file(path).text()).toBe("héllo");
		} finally {
			await manager.shutdown();
		}
	});

	it("returns the same string with and without await", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const path = join(tempDir, "sync.txt");
			const r = await manager.execute(
				`write(${q(path)}, "payload");
				const bare = read(${q(path)});
				const awaited = await read(${q(path)});
				JSON.stringify({ bare, awaited, sameType: typeof bare })`,
			);
			expect(r.status).toBe("ok");
			const out = JSON.parse(JSON.parse(r.result ?? '""')) as Record<string, string>;
			expect(out).toEqual({ bare: "payload", awaited: "payload", sameType: "string" });
		} finally {
			await manager.shutdown();
		}
	});

	it("refuses a declaration that would replace `read`, leaving it callable", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const clobber = await manager.execute("const read = 1;");
			expect(clobber.status).toBe("error");
			expect(clobber.error?.evalue).toContain("cannot be redeclared");

			const after = await manager.execute("typeof read");
			expect(after.result).toBe('"function"');
		} finally {
			await manager.shutdown();
		}
	});
});
