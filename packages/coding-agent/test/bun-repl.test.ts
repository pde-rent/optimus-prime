import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import { BunReplProvisioner } from "../src/core/bun-repl/provisioner.js";

// These tests spawn a real `bun` child process running the REPL script, so they
// exercise the full child-process model (NDJSON over stdio + hard-kill on runaway).

let tempDir = "";

describe("Bun REPL", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-bunrepl-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("persists top-level const/let/function/class across execute calls", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r1 = await manager.execute(
				"const x = 5; let y = 7; function add(a, b) { return a + b; } class Dog { bark() { return 'woof' } }",
			);
			expect(r1.status).toBe("ok");

			const r2 = await manager.execute("x + y + add(1, 2)");
			expect(r2.status).toBe("ok");
			expect(r2.result).toBe("15");

			const r3 = await manager.execute("new Dog().bark()");
			expect(r3.status).toBe("ok");
			expect(r3.result).toBe('"woof"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("supports top-level await of a short promise", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("await new Promise((res) => setTimeout(() => res('done'), 20))");
			expect(r.status).toBe("ok");
			expect(r.result).toBe('"done"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("supports module loading via await import()", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("const p = await import('node:path'); typeof p.join");
			expect(r.status).toBe("ok");
			expect(r.result).toBe('"function"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	// A vm script cannot run a static import, and the engine reports it as
	// "import call expects one or two arguments" — a message that reads like a
	// mis-called function, so agents retried the same shape instead of switching to
	// `await import`. The transformer rewrites the statement instead.
	it('runs the documented `import { $ } from "bun"` idiom', async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute(
				'import { $ } from "bun";\n(await $`echo hi`.quiet()).stdout.toString().trim()',
			);
			expect(r.status).toBe("ok");
			expect(r.result).toBe('"hi"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("keeps statically imported bindings alive in later cells", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r1 = await manager.execute('import { join } from "node:path"\nimport * as os from "node:os"');
			expect(r1.status).toBe("ok");

			const r2 = await manager.execute('join("a", "b")');
			expect(r2.status).toBe("ok");
			expect(r2.result).toBe('"a/b"');

			const r3 = await manager.execute("typeof os.tmpdir");
			expect(r3.status).toBe("ok");
			expect(r3.result).toBe('"function"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("erases type-only imports instead of trying to load them", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute('import type { Stats } from "node:fs"\n"still here"');
			expect(r.status).toBe("ok");
			expect(r.result).toBe('"still here"');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	// The forms the transformer refuses to guess at must still fail legibly.
	it("tells the model to use await import() when an import cannot be rewritten", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("const spec = 'node:path'\nimport { join } from spec");
			expect(r.status).toBe("error");
			expect(r.error?.ename).toBe("SyntaxError");
			expect(r.error?.evalue).toContain('await import("module")');
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("routes %%bash cells to the shell and captures stdout", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("%%bash\necho hi");
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("hi");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("times out a runaway sync loop instead of hanging", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("while (true) {}", { timeout: 500 });
			expect(r.status).toBe("aborted");
			expect(r.error?.ename).toBe("TimeoutError");
			expect(r.durationMs).toBeLessThan(5000);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("interrupts a long-running await (does not hang) and stays usable after a hard kill", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const controller = new AbortController();
			const pending = manager.execute("await new Promise(() => {})", {
				signal: controller.signal,
				timeout: 5000,
			});
			setTimeout(() => controller.abort(), 100);
			const r = await pending;
			expect(r.status).toBe("aborted");
			expect(r.durationMs).toBeLessThan(5000);

			// The REPL child was hard-killed and restarted; a fresh execute must work.
			const after = await manager.execute("const ok = true; ok");
			expect(after.status).toBe("ok");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("round-trips a variable through snapshot and restore via the provisioner", async () => {
		const snapshotDir = join(tempDir, "artifacts");
		const p1 = new BunReplProvisioner({ bunPath: "bun", cwd: tempDir, snapshotDir });
		const m1 = await p1.ensure();
		const r1 = await m1.execute("const x = 5; let y = 7;");
		expect(r1.status).toBe("ok");
		await p1.dispose(); // flushes a snapshot

		const p2 = new BunReplProvisioner({ bunPath: "bun", cwd: tempDir, snapshotDir });
		const m2 = await p2.ensure(); // auto-restores from disk
		const r2 = await m2.execute("x + y");
		expect(r2.status).toBe("ok");
		expect(r2.result).toBe("12");
		await p2.dispose().catch(() => {});
	});
});

describe("snapshot excludes live handles", () => {
	test("a resumed session keeps Bun intact and does not resurrect handles", async () => {
		const dir = mkdtempSync(join(tmpdir(), "repl-handles-"));
		const snapshotDir = join(dir, "snap");
		const first = new BunReplManager({ cwd: dir, snapshotDir });
		await first.start();
		await first.execute(
			`const answer = 42; const cfg = { deep: { ok: true } };` +
				` const server = Bun.serve({ port: 8893, fetch: () => new Response("x") });` +
				` const timer = setInterval(() => {}, 1000);`,
		);
		await first.dispose();

		const second = new BunReplManager({ cwd: dir, snapshotDir });
		await second.start();
		try {
			await second.restoreState();

			// The regression this guards: the Bun namespace was itself snapshotted, serialized to
			// `{}`, and restored over the real global — leaving every later cell without Bun.file,
			// Bun.spawn or Bun.Glob.
			expect((await second.execute("typeof Bun?.serve")).result).toBe('"function"');
			expect((await second.execute("typeof Bun?.file")).result).toBe('"function"');

			// Plain data still survives.
			expect((await second.execute("answer")).result).toBe("42");
			expect((await second.execute("JSON.stringify(cfg)")).result).toBe('"{\\"deep\\":{\\"ok\\":true}}"');

			// Live handles must be absent rather than restored as hollow `{}` objects that still
			// look callable to the model.
			expect((await second.execute("typeof server")).result).toBe('"undefined"');
			expect((await second.execute("typeof timer")).result).toBe('"undefined"');
		} finally {
			await second.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
