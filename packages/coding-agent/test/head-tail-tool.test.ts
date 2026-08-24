import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHeadTool, createTailTool, type WindowToolDetails } from "../src/core/tools/native/head-tail.js";

function getText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((c): c is Extract<(typeof result.content)[number], { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

describe("head/tail tools", () => {
	let dir: string;
	beforeEach(() => {
		dir = join(tmpdir(), `headtail-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("head shows first N lines", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
		const def = createHeadTool(dir);
		const res = await def.execute("t1", { path: p, lines: 3 } as never);
		expect(getText(res)).toBe("line 1\nline 2\nline 3");
	});

	it("head defaults to 10 lines and keeps a trailing newline", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, `${Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n")}\n`);
		const def = createHeadTool(dir);
		const res = await def.execute("t1", { path: p } as never);
		expect(getText(res)).toBe(`${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`);
	});

	it("tail shows last N lines of a small file", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
		const def = createTailTool(dir);
		const res = await def.execute("t1", { path: p, lines: 2 } as never);
		expect(getText(res)).toBe("line 49\nline 50");
	});

	it("tail reads backwards on a large file without loading it all", async () => {
		const p = join(dir, "big.log");
		const lines = Array.from({ length: 200000 }, (_, i) => `entry ${i + 1} padding padding`);
		writeFileSync(p, lines.join("\n")); // ~6MB
		const def = createTailTool(dir);
		const res = await def.execute("t1", { path: p, lines: 5 } as never);
		expect(getText(res)).toBe(lines.slice(-5).join("\n"));
		expect((res.details as WindowToolDetails).readBytes).toBeLessThanOrEqual(1024 * 1024); // windowed, not whole-file
	});

	it("bytes mode matches head/tail -c semantics", async () => {
		const p = join(dir, "b.bin");
		writeFileSync(p, "abcdefghij");
		const head = await createHeadTool(dir).execute("t1", { path: p, bytes: 4 } as never);
		const tail = await createTailTool(dir).execute("t1", { path: p, bytes: 4 } as never);
		expect(getText(head)).toBe("abcd");
		expect(getText(tail)).toBe("ghij");
	});

	it("missing paths fail with the house error shape", async () => {
		const head = createHeadTool(dir);
		await expect(head.execute("t1", { path: "nope.txt" } as never)).rejects.toThrow(
			/Could not search path: nope\.txt\. Error code: /,
		);
	});
});
