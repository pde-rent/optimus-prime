import { describe, expect, it } from "bun:test";
import { BunReplManager } from "../src/core/bun-repl/index.js";

// `node:vm` reports nearly every parse failure as "Unexpected EOF" at a line number into the
// wrapped cell, naming nothing the model can act on. These pin the diagnostics added on top.
describe("Bun REPL syntax diagnostics", () => {
	it("names the real mistake and the fix for a prompt written across lines in quotes", async () => {
		const manager = new BunReplManager({ bunPath: "bun" });
		await manager.start();
		try {
			const r = await manager.execute("await run('line one\nline two\nline three', { name: 'child' });");
			expect(r.status).toBe("error");
			expect(r.error?.ename).toBe("SyntaxError");
			// The host prints the traceback whenever there is one, so the hint has to reach it.
			const shown = r.error?.traceback.join("\n") ?? "";
			expect(shown).toContain("Unterminated string literal");
			expect(shown).toContain("backtick template literal");
		} finally {
			await manager.shutdown();
		}
	});

	it("carries Bun's diagnostic for other syntax errors", async () => {
		const manager = new BunReplManager({ bunPath: "bun" });
		await manager.start();
		try {
			const r = await manager.execute("const x = (1 +;");
			expect(r.status).toBe("error");
			expect(r.error?.traceback.join("\n")).toContain("Unexpected ;");
		} finally {
			await manager.shutdown();
		}
	});

	it("leaves valid cells alone", async () => {
		const manager = new BunReplManager({ bunPath: "bun" });
		await manager.start();
		try {
			const r = await manager.execute("`multi\nline`.length");
			expect(r.status).toBe("ok");
			expect(r.result).toBe("10");
		} finally {
			await manager.shutdown();
		}
	});
});

// Persistence rewrites `const x = ...` to `globalThis.x = ...`, so declaring a runtime name
// replaced the API for the whole session instead of shadowing it for one cell — and no cell
// could get it back. The bindings now refuse the write.
describe("Bun REPL runtime-binding guard", () => {
	it("refuses a declaration that would replace a runtime global, leaving it intact", async () => {
		const manager = new BunReplManager({ bunPath: "bun" });
		await manager.start();
		try {
			const before = await manager.execute("typeof rlm");
			expect(before.result).toBe('"function"');

			const clobber = await manager.execute("const rlm = 'the docs';");
			expect(clobber.status).toBe("error");
			expect(clobber.error?.evalue).toContain("cannot be redeclared");

			const after = await manager.execute("typeof rlm");
			expect(after.result).toBe('"function"');
		} finally {
			await manager.shutdown();
		}
	});

	it("names every clobbered binding in one declaration", async () => {
		const manager = new BunReplManager({ bunPath: "bun" });
		await manager.start();
		try {
			const r = await manager.execute("let display = 1, ok = 2;");
			expect(r.status).toBe("error");
			expect(r.error?.evalue).toContain("`display`");
			expect(r.error?.evalue).not.toContain("`ok`");
		} finally {
			await manager.shutdown();
		}
	});

	it("leaves names that merely resemble a runtime binding alone", async () => {
		const manager = new BunReplManager({ bunPath: "bun" });
		await manager.start();
		try {
			const r = await manager.execute("const rlmDoc = 42; rlmDoc");
			expect(r.status).toBe("ok");
			expect(r.result).toBe("42");
		} finally {
			await manager.shutdown();
		}
	});
});
