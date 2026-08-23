import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { createHeadTool, createTailTool } from "../src/core/tools/native/head-tail.js";
import { createReadFileTool } from "../src/core/tools/read-file.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("batched reads (paths[])", () => {
	const temps = makeTempDirs("batch-read-test-");
	let testDir: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(testDir, { recursive: true });
	});

	function makeFile(name: string, content: string, mtimeSeconds: number): string {
		const path = join(testDir, name);
		writeFileSync(path, content);
		utimesSync(path, new Date(mtimeSeconds * 1000), new Date(mtimeSeconds * 1000));
		return path;
	}

	it("read_file reads many files in one call under headers, newest-mtime-first", async () => {
		const oldPath = makeFile("old.txt", "old content", 1000);
		const newPath = makeFile("new.txt", "new content\nline two", 2000);

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("c1", { paths: [oldPath, newPath] });

		expect(getTextOutput(result)).toBe(
			[
				`=== new.txt (20 bytes) ===`,
				"new content",
				"line two",
				"",
				`=== old.txt (11 bytes) ===`,
				"old content",
			].join("\n"),
		);
		expect(result.details.mode).toBe("batch");
		expect(result.details.files.map((f) => f.included)).toEqual([true, true]);
		expect(result.details.files.find((f) => f.givenPath === oldPath)?.totalLines).toBe(1);
	});

	it("read_file returns only the size table when nothing fits the budget", async () => {
		const a = makeFile("a.bin", "x".repeat(60 * 1024), 1000);
		const b = makeFile("b.bin", "y".repeat(60 * 1024), 2000);

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("c2", { paths: [a, b], limitBytes: 50 * 1024 });

		const text = getTextOutput(result);
		expect(text).toContain("Raise limitBytes or pass fewer paths.");
		expect(text).toContain(`${a}: ${60 * 1024} bytes, mtime `);
		expect(text).toContain(`${b}: ${60 * 1024} bytes, mtime `);
		expect(text).not.toContain("x".repeat(16));
		expect(result.details.files.every((f) => !f.included)).toBe(true);
	});

	it("read_file skips missing paths with a note and reads the rest", async () => {
		const present = makeFile("present.txt", "here", 1500);
		const missing = join(testDir, "nope.txt");

		const tool = createReadFileTool(testDir);
		const result = await tool.execute("c3", { paths: [missing, present] });

		const text = getTextOutput(result);
		expect(text).toContain(`=== present.txt (4 bytes) ===`);
		expect(text).toContain("[Skipped 1 unreadable path(s):");
		expect(text).toContain(missing);
		expect(result.details.files.map((f) => f.givenPath)).toEqual([present]);
	});

	it("read_file short-circuits per file inside a batch", async () => {
		const a = makeFile("a.txt", "aaa", 1000);
		const b = makeFile("b.txt", "bbb", 2000);

		const tool = createReadFileTool(testDir);
		await tool.execute("c4", { paths: [a, b] });

		const second = await tool.execute("c5", { paths: [a, b] });
		const text = getTextOutput(second);
		expect(text).toContain("=== ");
		expect(text).toContain("[file unchanged since your last read: lines 1-1 of 1]");
		expect(text).not.toContain("aaa");
		expect(text).not.toContain("bbb");

		writeFileSync(b, "changed");
		utimesSync(b, new Date(), new Date());
		const third = await tool.execute("c6", { paths: [a, b] });
		const thirdText = getTextOutput(third);
		expect(thirdText).toContain("changed");
		expect(thirdText).toContain("[file unchanged since your last read: lines 1-1 of 1]");
		expect(thirdText).not.toContain("aaa");
	});

	it("head windows many files in one call and reports the size table on budget overflow", async () => {
		const a = makeFile("a.log", Array.from({ length: 30 }, (_, i) => `a${i + 1}`).join("\n"), 1000);
		const b = makeFile("b.log", Array.from({ length: 30 }, (_, i) => `b${i + 1}`).join("\n"), 2000);

		const head = createHeadTool(testDir);
		const result = await head.execute("c7", { paths: [b, a], lines: 2 });
		expect(getTextOutput(result)).toBe(
			[`=== b.log (110 bytes) ===`, "b1", "b2", "", `=== a.log (110 bytes) ===`, "a1", "a2"].join("\n"),
		);

		const bigA = makeFile("big-a.bin", "x".repeat(70 * 1024), 3000);
		const bigB = makeFile("big-b.bin", "y".repeat(70 * 1024), 4000);
		const overflow = await head.execute("c8", { paths: [bigA, bigB], limitBytes: 50 * 1024 });
		const overflowText = getTextOutput(overflow);
		expect(overflowText).toContain("Raise limitBytes or pass fewer paths.");
		expect(overflowText).toContain(bigA);
		expect(overflowText).toContain(bigB);
	});

	it("tail batches like head", async () => {
		const a = makeFile("a.log", Array.from({ length: 30 }, (_, i) => `a${i + 1}`).join("\n"), 1000);

		const tail = createTailTool(testDir);
		const result = await tail.execute("c9", { paths: [a], lines: 2 });
		expect(getTextOutput(result)).toBe([`=== a.log (110 bytes) ===`, "a29", "a30"].join("\n"));
	});
});
