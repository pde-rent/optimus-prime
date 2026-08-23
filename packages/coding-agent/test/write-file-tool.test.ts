import { beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createWriteFileTool, type WriteFileOperations } from "../src/core/tools/write-file.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("write_file tool", () => {
	const temps = makeTempDirs("write-file-test-");
	let testDir: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(testDir, { recursive: true });
	});

	it("creates a new file", async () => {
		const path = join(testDir, "new.txt");
		const tool = createWriteFileTool(testDir);

		const result = await tool.execute("call-1", { path, content: "hello\nworld" });

		expect(readFileSync(path, "utf-8")).toBe("hello\nworld");
		expect(getTextOutput(result)).toContain(`Created ${path} (11B, 2 lines).`);
		expect(result.details.created).toBe(true);
	});

	it("creates missing parent directories only when createDirs is set", async () => {
		const path = join(testDir, "deep", "nested", "f.txt");
		const tool = createWriteFileTool(testDir);

		await expect(tool.execute("call-2", { path, content: "x" })).rejects.toThrow(/ENOENT/);
		expect(existsSync(path)).toBe(false);

		await tool.execute("call-3", { path, content: "x", createDirs: true });
		expect(readFileSync(path, "utf-8")).toBe("x");
	});

	it("overwrites an existing file and returns a correct unified diff", async () => {
		const path = join(testDir, "existing.txt");
		writeFileSync(path, "line 1\nline 2\nline 3");
		const tool = createWriteFileTool(testDir);

		const result = await tool.execute("call-4", { path, content: "line 1\nCHANGED\nline 3\nline 4" });

		expect(readFileSync(path, "utf-8")).toBe("line 1\nCHANGED\nline 3\nline 4");
		expect(getTextOutput(result)).toBe(`Successfully wrote ${path}.`);
		expect(result.details.created).toBeUndefined();

		const diff = result.details.diff;
		expect(typeof diff).toBe("string");
		// The repo's diff format numbers every row: " 1 line 1" is context,
		// "-N <old>" a removal, "+N <new>" an addition.
		expect(diff).toContain("-2 line 2");
		expect(diff).toContain("+2 CHANGED");
		expect(diff).toContain("+4 line 4");
		expect(diff).toContain(" 1 line 1");
	});

	it("preserves CRLF line endings and a UTF-8 BOM on overwrite", async () => {
		const path = join(testDir, "crlf.txt");
		writeFileSync(path, "\uFEFFalpha\r\nbeta\r\n");
		const tool = createWriteFileTool(testDir);

		await tool.execute("call-5", { path, content: "gamma\ndelta" });

		const raw = readFileSync(path, "utf-8");
		// The file keeps its BOM and CRLF endings; the written content itself
		// has no trailing newline, so none is added.
		expect(raw.startsWith("\uFEFF")).toBe(true);
		expect(raw).toBe("\uFEFFgamma\r\ndelta");
	});

	it("serializes concurrent writes to the same file through the mutation queue", async () => {
		const path = join(testDir, "queued.txt");
		writeFileSync(path, "start");

		const events: string[] = [];
		let readSeq = 0;
		let active = 0;
		let overlapped = false;
		const slowOps: WriteFileOperations = {
			readFile: async (p) => {
				events.push(`read:${readSeq++}`);
				return await Bun.file(p)
					.arrayBuffer()
					.then((b) => Buffer.from(b));
			},
			writeFile: async (p, content) => {
				active++;
				events.push(`write-start:${active}`);
				await new Promise((r) => setTimeout(r, 20));
				if (active > 1) overlapped = true;
				events.push(`write-end:${active}`);
				active--;
				await writeFile(p, content);
			},
			access: async () => {},
			mkdir: async () => {},
		};

		const tool = createWriteFileTool(testDir, { operations: slowOps });
		await Promise.all([
			tool.execute("call-6a", { path, content: "first" }),
			tool.execute("call-6b", { path, content: "second" }),
		]);

		expect(overlapped).toBe(false);
		// The second write's read must observe the first write's completed state.
		const secondReadIdx = events.indexOf("read:1");
		expect(secondReadIdx).toBeGreaterThan(events.indexOf("write-end:1"));
	});
});
