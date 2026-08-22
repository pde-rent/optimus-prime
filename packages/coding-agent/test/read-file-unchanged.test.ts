import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.js";
import { createReadFileTool } from "../src/core/tools/read-file.js";
import { createWriteFileTool } from "../src/core/tools/write-file.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("read_file unchanged short-circuit", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `read-unchanged-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns a one-line notice when re-reading an unmodified file", async () => {
		const path = join(testDir, "a.txt");
		writeFileSync(path, "line 1\nline 2\nline 3");

		const tool = createReadFileTool(testDir);
		const first = await tool.execute("c1", { path });
		expect(getTextOutput(first)).toBe("line 1\nline 2\nline 3");

		const second = await tool.execute("c2", { path });
		expect(getTextOutput(second)).toBe("[file unchanged since your last read: lines 1-3 of 3]");
		expect(second.details.startLine).toBe(1);
		expect(second.details.endLine).toBe(3);
	});

	it("re-emits content when a different window is requested", async () => {
		const path = join(testDir, "b.txt");
		writeFileSync(path, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));

		const tool = createReadFileTool(testDir);
		await tool.execute("c3", { path });
		const paged = await tool.execute("c4", { path, offset: 4, limit: 3 });
		expect(getTextOutput(paged)).toContain("line 4");
		expect(getTextOutput(paged)).toContain("[Showing lines 4-6 of 10.]");
	});

	it("re-emits content after the file changes on disk", async () => {
		const path = join(testDir, "c.txt");
		writeFileSync(path, "before");
		const tool = createReadFileTool(testDir);
		await tool.execute("c5", { path });

		writeFileSync(path, "after");
		const again = await tool.execute("c6", { path });
		expect(getTextOutput(again)).toBe("after");
	});

	it("invalidates via the file mutation queue even when mtime, size and content are identical", async () => {
		const path = join(testDir, "d.txt");
		writeFileSync(path, "aaaa");
		const tool = createReadFileTool(testDir);
		await tool.execute("c7", { path });

		// Rewrite through the mutation queue with IDENTICAL content, then restore
		// the exact mtime/size the short-circuit recorded. Only queue invalidation
		// explains a full re-emit instead of the unchanged notice.
		const before = statSync(path);
		await withFileMutationQueue(path, async () => {
			writeFileSync(path, "aaaa");
		});
		utimesSync(path, before.atime, new Date(before.mtimeMs));

		const again = await tool.execute("c8", { path });
		expect(getTextOutput(again)).toBe("aaaa");
	});

	it("re-emits content after a write_file mutation, then short-circuits again", async () => {
		const path = join(testDir, "e.txt");
		writeFileSync(path, "v1");
		const reader = createReadFileTool(testDir);
		const writer = createWriteFileTool(testDir);

		await reader.execute("c9", { path });
		await writer.execute("c10", { path, content: "v2" });

		const afterWrite = await reader.execute("c11", { path });
		expect(getTextOutput(afterWrite)).toBe("v2");

		const repeat = await reader.execute("c12", { path });
		expect(getTextOutput(repeat)).toContain("unchanged");
	});
});
