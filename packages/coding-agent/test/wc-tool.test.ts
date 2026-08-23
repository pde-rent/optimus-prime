import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createWcTool } from "../src/core/tools/native/wc.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("wc tool", () => {
	const temps = makeTempDirs("wc-tool-test-");
	let testDir: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(join(testDir, "sub"), { recursive: true });
	});

	it("counts a single file exactly", async () => {
		const path = join(testDir, "one.txt");
		writeFileSync(path, "hello world\nsecond line\n");

		const tool = createWcTool(testDir);
		const result = await tool.execute("call-1", { path });

		expect(result.details.lines).toBe(2);
		expect(result.details.words).toBe(4);
		expect(result.details.bytes).toBe(24);
		expect(result.details.fileCount).toBe(1);
		expect(getTextOutput(result)).not.toContain("TOTAL");
	});

	it("counts a file without a trailing newline", async () => {
		writeFileSync(join(testDir, "partial.txt"), "a\nb");

		const tool = createWcTool(testDir);
		const result = await tool.execute("call-2", { path: "partial.txt" });
		expect(result.details.lines).toBe(2);
	});

	it("totals a directory tree per file plus a TOTAL row", async () => {
		writeFileSync(join(testDir, "sub", "a.txt"), "x y z\n"); // 1 line, 3 words
		writeFileSync(join(testDir, "b.txt"), "w\nw\n"); // 2 lines, 2 words

		const tool = createWcTool(testDir);
		const result = await tool.execute("call-3", {});

		const text = getTextOutput(result);
		expect(text.split("\n").at(-1)).toBe(
			`TOTAL ${result.details.lines} ${result.details.words} ${result.details.bytes} (2 files)`,
		);
		expect(result.details.lines).toBe(3);
		expect(result.details.words).toBe(5);
		expect(result.details.fileCount).toBe(2);
		expect(text).toContain("sub/a.txt");
	});

	it("skips node_modules and honours include globs", async () => {
		mkdirSync(join(testDir, "node_modules"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", "dep.js"), "ignored\n");
		writeFileSync(join(testDir, "keep.ts"), "kept\n");
		writeFileSync(join(testDir, "skip.md"), "nope\n");

		const tool = createWcTool(testDir);
		const result = await tool.execute("call-4", { include: "*.ts" });

		expect(getTextOutput(result)).toContain("keep.ts");
		expect(result.details.fileCount).toBe(1);
	});

	it("accepts forward-slash paths and reports exact errors", async () => {
		mkdirSync(join(testDir, "dir"), { recursive: true });
		writeFileSync(join(testDir, "dir", "f.txt"), "content\n");

		const tool = createWcTool(testDir);
		const result = await tool.execute("call-5a", { path: "dir/f.txt" });
		expect(result.details.lines).toBe(1);

		await expect(tool.execute("call-5b", { path: "missing/thing" })).rejects.toThrow(
			"Could not search path: missing/thing. Error code: ENOENT.",
		);
	});
});
