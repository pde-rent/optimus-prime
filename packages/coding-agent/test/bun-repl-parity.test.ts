import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	// DEFAULT_RLM_RUNTIME_LABELS tells every agent that Bun and native fetch are
	// available. The vm context starts empty, so those globals only exist if they
	// are injected; when they were not, the documented API threw ReferenceError
	// and agents burned turns rediscovering that the prompt had lied to them.
	it("exposes every global the system prompt advertises", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const r = await manager.execute(
				`JSON.stringify({
					bunFile: typeof Bun?.file,
					bunWrite: typeof Bun?.write,
					bunGlob: typeof Bun?.Glob,
					bunSpawn: typeof Bun?.spawn,
					fetch: typeof fetch,
					randomUUID: typeof crypto?.randomUUID,
					subtle: typeof crypto?.subtle,
					Buffer: typeof Buffer,
					TextEncoder: typeof TextEncoder,
					TextDecoder: typeof TextDecoder,
					URL: typeof URL,
					URLSearchParams: typeof URLSearchParams,
				})`,
			);
			expect(r.status).toBe("ok");
			expect(JSON.parse(JSON.parse(r.result ?? '""'))).toEqual({
				bunFile: "function",
				bunWrite: "function",
				bunGlob: "function",
				bunSpawn: "function",
				fetch: "function",
				randomUUID: "function",
				subtle: "object",
				Buffer: "function",
				TextEncoder: "function",
				TextDecoder: "function",
				URL: "function",
				URLSearchParams: "function",
			});
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("exposes the web and Bun-module surface the runtime labels promise", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const names = [
				"HTMLRewriter",
				"WebSocket",
				"Worker",
				"BroadcastChannel",
				"MessageChannel",
				"CompressionStream",
				"DecompressionStream",
				"TextEncoderStream",
				"TextDecoderStream",
				"URLPattern",
				"Event",
				"EventTarget",
				"CustomEvent",
				"DOMException",
				"navigator",
				"$",
			];
			const missing = await manager.execute(
				`JSON.stringify(${JSON.stringify(names)}.filter((n) => typeof globalThis[n] === "undefined"))`,
			);
			expect(missing.status).toBe("ok");
			expect(JSON.parse(JSON.parse(missing.result ?? '""'))).toEqual([]);

			// Built-in modules must be reachable through dynamic import, not just listed.
			const sqlite = await manager.execute(
				`(async () => { const { Database } = await import("bun:sqlite"); const db = new Database(":memory:"); db.run("create table t(x)"); db.run("insert into t values (42)"); return db.query("select x from t").get().x; })()`,
			);
			expect(sqlite.status).toBe("ok");
			expect(JSON.parse(sqlite.result ?? "null")).toBe(42);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	// `pi` groups the harness helpers the runtime labels advertise. They are promised
	// in the system prompt, so an injected-but-broken binding costs a turn the same way
	// a missing global does.
	it("exposes the `pi` helper namespace the runtime labels promise", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const diff = await manager.execute(
				`JSON.stringify(pi.diff(["a", "b", "c"].join("\\n"), ["a", "B", "c"].join("\\n")))`,
			);
			expect(diff.status).toBe("ok");
			const diffValue = JSON.parse(JSON.parse(diff.result ?? '""')) as { diff: string; firstChangedLine: number };
			expect(diffValue.firstChangedLine).toBe(2);
			expect(diffValue.diff.split("\n")).toEqual([" 1 a", "-2 b", "+2 B", " 3 c"]);

			const head = await manager.execute(
				`JSON.stringify(pi.truncateHead(["l1", "l2", "l3"].join("\\n"), { maxLines: 2 }))`,
			);
			expect(head.status).toBe("ok");
			expect(JSON.parse(JSON.parse(head.result ?? '""'))).toMatchObject({
				content: "l1\nl2",
				truncated: true,
				truncatedBy: "lines",
				totalLines: 3,
			});

			const tail = await manager.execute(
				`JSON.stringify(pi.truncateTail(["l1", "l2", "l3"].join("\\n"), { maxLines: 2 }))`,
			);
			expect(tail.status).toBe("ok");
			expect(JSON.parse(JSON.parse(tail.result ?? '""'))).toMatchObject({
				content: "l2\nl3",
				truncated: true,
				truncatedBy: "lines",
			});

			// The reason this is worth exposing: a byte budget cut by hand splits a
			// multi-byte character and yields replacement chars.
			const bytes = await manager.execute(`pi.truncateTail("é".repeat(10), { maxBytes: 5 }).content`);
			expect(bytes.status).toBe("ok");
			expect(JSON.parse(bytes.result ?? '""')).toBe("éé");
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("withholds the process members that would break the kernel, with an explanation", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			// Absent members would fail as "undefined is not a function"; these must say why.
			for (const member of ["exit", "chdir", "kill"]) {
				const r = await manager.execute(
					`(() => { try { process.${member}(); return "NOT THROWN"; } catch (e) { return e.message; } })()`,
				);
				expect(r.status).toBe("ok");
				const message = JSON.parse(r.result ?? '""');
				expect(message).toContain(`process.${member} is unavailable`);
			}
			const readable = await manager.execute(`JSON.stringify(typeof process.platform === "string")`);
			expect(JSON.parse(JSON.parse(readable.result ?? '""'))).toBe(true);
		} finally {
			await manager.dispose().catch(() => {});
		}
	});

	it("round-trips a real file through the advertised Bun APIs", async () => {
		const manager = new BunReplManager({ bunPath: "bun", cwd: tempDir });
		await manager.start();
		try {
			const target = join(tempDir, "bun-api-probe.txt");
			const r = await manager.execute(
				`(await Bun.write(${JSON.stringify(target)}, "written-by-sandbox"), await Bun.file(${JSON.stringify(target)}).text())`,
			);
			expect(r.status).toBe("ok");
			expect(JSON.parse(r.result ?? '""')).toBe("written-by-sandbox");
			expect(readFileSync(target, "utf8")).toBe("written-by-sandbox");
		} finally {
			await manager.dispose().catch(() => {});
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

	it("carries functions across a restore and reports what it could not", async () => {
		const snapshotDir = join(tempDir, "artifacts");
		const p1 = new BunReplProvisioner({ bunPath: "bun", cwd: tempDir, snapshotDir });
		const m1 = await p1.ensure();
		// `total` is plain data; `helper` is a function, carried as source and re-evaluated.
		// `server` is a live handle, which cannot be serialized at all.
		expect(
			(
				await m1.execute(
					"const total = 12; function helper() { return total; } const server = Bun.serve({ port: 0, fetch: () => new Response('x') });",
				)
			).status,
		).toBe("ok");
		await p1.dispose();

		// The snapshot records both halves: what it carried, and what it had to leave behind.
		const manifest = JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf-8"));
		expect(manifest.names).toContain("helper");
		expect(manifest.droppedNames).toContain("server");

		let restore: { restoredNames: string[]; failed: string[] } | undefined;
		const p2 = new BunReplProvisioner({
			bunPath: "bun",
			cwd: tempDir,
			snapshotDir,
			onRestore: (r) => {
				restore = r;
			},
		});
		const m2 = await p2.ensure();
		try {
			expect(restore?.restoredNames).toContain("total");
			expect(restore?.restoredNames).toContain("helper");
			expect(restore?.failed).toContain("server");
			// The restored function is callable and still closes over the restored data.
			const result = await m2.execute("helper()");
			expect(result.status).toBe("ok");
			expect(String(result.result)).toBe("12");
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
