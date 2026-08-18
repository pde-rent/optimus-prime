import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BunReplManager, DEFAULT_MAX_OUTPUT_CHARS } from "../src/core/bun-repl/index.js";
import { BunReplProvisioner } from "../src/core/bun-repl/provisioner.js";

// Parity coverage against the Python/IPython kernel the Bun REPL replaced: output
// truncation, error shape, restore reporting, host-request attribution, and the
// notices the model depends on to know what it still has.

let tempDir = "";

describe("Bun REPL parity", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-parity-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("formats console output the way a console does, not as a JSON array", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute('console.log("a", "b", 1); console.log(new Map([["k", 2]]));');
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("a b 1");
			expect(r.stdout).toContain("Map(1) { 'k' => 2 }");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("renders structured result values instead of flattening them to {}", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("new Set([1, 2])");
			expect(r.status).toBe("ok");
			expect(r.result).toBe("Set(2) { 1, 2 }");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("truncates captured output at the per-stream cap while streaming everything live", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			let streamed = 0;
			const r = await manager.execute('console.log("x".repeat(200_000));', {
				onStream: (chunk) => {
					streamed += chunk.length;
				},
			});
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain(`[... output truncated at ${DEFAULT_MAX_OUTPUT_CHARS} chars ...]`);
			// Capture is capped; the live callback is not.
			expect(r.stdout.length).toBeLessThan(DEFAULT_MAX_OUTPUT_CHARS + 200);
			expect(streamed).toBeGreaterThan(DEFAULT_MAX_OUTPUT_CHARS);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("truncates an oversized result value", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute('"y".repeat(200_000)');
			expect(r.status).toBe("ok");
			expect(r.result?.endsWith(`[... output truncated at ${DEFAULT_MAX_OUTPUT_CHARS} chars ...]`)).toBe(true);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("reports the error class and a traceback limited to the cell's own frames", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute('function boom() { throw new TypeError("kaboom"); }\nboom();');
			expect(r.status).toBe("error");
			expect(r.error?.ename).toBe("TypeError");
			expect(r.error?.evalue).toContain("kaboom");
			expect(r.error?.traceback.length).toBeGreaterThan(1);
			expect(r.error?.traceback.some((line) => line.includes("boom"))).toBe(true);
			// REPL plumbing frames must not be presented as the agent's stack.
			expect(r.error?.traceback.some((line) => line.includes("repl-script"))).toBe(false);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("runs TypeScript syntax without changing how plain JavaScript evaluates", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const ts = await manager.execute("interface Point { x: number }\nconst pt: Point = { x: 41 };\npt.x + 1");
			expect(ts.status).toBe("ok");
			expect(ts.result).toBe("42");

			// A bare object literal is dead code to a transpiler; the JS path must still win.
			const js = await manager.execute("({ a: 1 })");
			expect(js.status).toBe("ok");
			expect(js.result).toBe("{ a: 1 }");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("surfaces a malformed declaration as an error instead of silently dropping it", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("const = ;");
			expect(r.status).toBe("error");
			expect(r.error?.ename).toBe("SyntaxError");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("attributes host requests to the cell that issued them", async () => {
		const seen: unknown[] = [];
		const manager = new BunReplManager({
			bunPath: "bun",
			cwd: tempDir,
			hostHandlers: {
				"rlm.run": async (payload) => {
					seen.push(payload.cellSourceCode);
					return { ok: true };
				},
			},
		});
		await manager.start();
		try {
			const r = await manager.execute('await rlm("do a thing")');
			expect(r.status).toBe("ok");
			expect(seen).toHaveLength(1);
			expect(String(seen[0])).toContain("do a thing");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("tells the model which names did not survive a restore", async () => {
		const snapshotDir = join(tempDir, "artifacts");
		const p1 = new BunReplProvisioner({ bunPath: "bun", cwd: tempDir, snapshotDir });
		const m1 = await p1.ensure();
		// `total` is plain data and revives; `helper` is a function, which JSON cannot carry.
		expect((await m1.execute("const total = 12; function helper() { return total; }")).status).toBe("ok");
		await p1.dispose();

		// The snapshot itself must record what it could not capture.
		const manifest = JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf-8"));
		expect(manifest.droppedNames).toContain("helper");

		let restore: { restoredNames: string[]; failed: string[] } | undefined;
		const p2 = new BunReplProvisioner({
			bunPath: "bun",
			cwd: tempDir,
			snapshotDir,
			onRestore: (r) => {
				restore = r;
			},
		});
		await p2.ensure();
		try {
			expect(restore?.restoredNames).toContain("total");
			expect(restore?.failed).toContain("helper");
			expect(restore?.restoredNames).not.toContain("helper");
		} finally {
			await p2.dispose().catch(() => {});
		}
	});

	it("flags the result after a runaway forced the REPL to be replaced", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const runaway = await manager.execute("while (true) {}", { timeout: 500 });
			expect(runaway.status).toBe("aborted");

			// The namespace died with the old child; the next result has to say so once.
			const after = await manager.execute("1 + 1");
			expect(after.status).toBe("ok");
			expect(after.kernelRestarted).toBe(true);

			const later = await manager.execute("2 + 2");
			expect(later.kernelRestarted).toBe(false);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("keeps ANSI colour out of shell output", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute("%%bash\nnode -e 'process.stdout.write(process.env.NO_COLOR ?? \"unset\")'");
			// Only assert the variable reached the shell; the node binary may be absent.
			if (r.status === "ok") expect(r.stdout).toContain("1");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});
});
