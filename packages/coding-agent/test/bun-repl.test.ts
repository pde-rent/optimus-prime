import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import { BunReplProvisioner } from "../src/core/bun-repl/provisioner.js";

// These tests spawn a real `bun` child process running the REPL script, so they
// exercise the full child-process model (NDJSON over stdio + hard-kill on runaway).

let tempDir = "";

describe("Bun REPL", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-bunrepl-"));
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
