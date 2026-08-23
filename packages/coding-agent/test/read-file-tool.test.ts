import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createReadFileTool } from "../src/core/tools/read-file.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("read_file tool", () => {
	const temps = makeTempDirs("read-file-test-");
	let testDir: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(testDir, { recursive: true });
	});

	it("reads a whole file", async () => {
		const path = join(testDir, "a.txt");
		writeFileSync(path, "line 1\nline 2\nline 3");

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("call-1", { path });

		expect(getTextOutput(result)).toBe("line 1\nline 2\nline 3");
		expect(result.details.totalLines).toBe(3);
		expect(result.details.startLine).toBe(1);
		expect(result.details.endLine).toBe(3);
		expect(result.details.truncated).toBe(false);
	});

	it("accepts relative paths resolved against cwd", async () => {
		writeFileSync(join(testDir, "rel.txt"), "content");

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("call-1b", { path: "rel.txt" });
		expect(getTextOutput(result)).toBe("content");
	});

	it("returns a line window for offset and limit", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
		const path = join(testDir, "b.txt");
		writeFileSync(path, lines.join("\n"));

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("call-2", { path, offset: 4, limit: 3 });

		const text = getTextOutput(result);
		expect(text.split("\n")[0]).toBe("line 4");
		expect(text.split("\n")[2]).toBe("line 6");
		expect(result.details.startLine).toBe(4);
		expect(result.details.endLine).toBe(6);
		expect(text).toContain("[Showing lines 4-6 of 10.]");
	});

	it("prefixes line numbers when requested", async () => {
		const path = join(testDir, "c.txt");
		writeFileSync(path, "alpha\nbeta");

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("call-3", { path, lineNumbers: true });

		const lines = getTextOutput(result).split("\n");
		expect(lines[0]).toBe("1\talpha");
		expect(lines[1]).toBe("2\tbeta");
	});

	it("truncates by line limit and reports it", async () => {
		const lines = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`);
		const path = join(testDir, "d.txt");
		writeFileSync(path, lines.join("\n"));

		const tool = createReadFileTool(testDir, { maxLines: 10 });
		const result = await tool.execute("call-4", { path });

		const text = getTextOutput(result);
		expect(text.split("\n")[0]).toBe("row 1");
		expect(text).toContain(
			"[Showing lines 1-10 of 50 (line limit reached). Re-read with a higher offset to continue.]",
		);
		expect(result.details.truncated).toBe(true);
		expect(result.details.endLine).toBe(10);
	});

	it("truncates by byte cap without splitting a UTF-8 sequence", async () => {
		// Each line is ~10 bytes; a 25-byte cap fits two whole lines but not three.
		const content = Array.from({ length: 20 }, (_, i) => `012345678${i % 10}`).join("\n");
		const path = join(testDir, "e.txt");
		writeFileSync(path, content);

		const tool = createReadFileTool(testDir, { maxBytes: 30 });
		const result = await tool.execute("call-5", { path });

		const text = getTextOutput(result);
		const bodyLines = text.split("\n[Showing")[0].split("\n");
		expect(bodyLines.length).toBe(3); // 10 bytes per line incl newline -> 3 fit in 30 bytes... capped at whole lines
		expect(text).toContain("(byte limit reached)");
		expect(content.startsWith(bodyLines.join("\n"))).toBe(true);
	});

	it("fails with the exact error string for a missing file", async () => {
		const missing = join(testDir, "missing.txt");
		const tool = createReadFileTool(testDir);

		await expect(tool.execute("call-6", { path: missing })).rejects.toThrow(
			`Could not read file: ${missing}. Error code: ENOENT.`,
		);
	});
});
