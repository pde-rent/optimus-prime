import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createGrepTool } from "../src/core/tools/native/grep.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("grep tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `grep-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("finds matches across nested directories with relative paths", async () => {
		mkdirSync(join(testDir, "src", "deep"), { recursive: true });
		writeFileSync(join(testDir, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
		writeFileSync(join(testDir, "src", "deep", "b.ts"), "// alpha again\n");

		const tool = createGrepTool(testDir);
		const result = await tool.execute("call-1", { pattern: "alpha" });

		const text = getTextOutput(result);
		expect(text).toContain("src/a.ts:1:");
		expect(text).toContain("src/deep/b.ts:1:");
		expect(text).not.toContain("beta");
		expect(result.details.matchCount).toBe(2);
		expect(result.details.fileCount).toBe(2);
	});

	it("searches a single file and reports context lines", async () => {
		const path = join(testDir, "one.txt");
		writeFileSync(path, "l1\nl2\ntarget\nl4\nl5");

		const tool = createGrepTool(testDir);
		const result = await tool.execute("call-2", { pattern: "target", path: "one.txt", context: 1 });

		const lines = getTextOutput(result).split("\n");
		expect(lines[0]).toBe("one.txt-2-l2");
		expect(lines[1]).toBe("one.txt:3:target");
		expect(lines[2]).toBe("one.txt-4-l4");
		expect(result.details.matchCount).toBe(1);
	});

	it("respects include/exclude globs", async () => {
		writeFileSync(join(testDir, "keep.ts"), "needle\n");
		writeFileSync(join(testDir, "skip.md"), "needle\n");

		const tool = createGrepTool(testDir);
		const included = await tool.execute("call-3a", { pattern: "needle", include: "*.ts" });
		expect(getTextOutput(included)).toContain("keep.ts");
		expect(getTextOutput(included)).not.toContain("skip.md");

		const excluded = await tool.execute("call-3b", { pattern: "needle", exclude: "*.md" });
		expect(getTextOutput(excluded)).toContain("keep.ts");
		expect(getTextOutput(excluded)).not.toContain("skip.md");
	});

	it("honours ignoreCase and skips node_modules, .git and gitignored files", async () => {
		mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(testDir, ".git"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", "pkg", "index.js"), "HAYSTACK here\n");
		writeFileSync(join(testDir, ".git", "config"), "HAYSTACK here\n");
		writeFileSync(join(testDir, "ignored.log"), "HAYSTACK here\n");
		writeFileSync(join(testDir, ".gitignore"), "*.log\n");
		writeFileSync(join(testDir, "main.ts"), "haystack here\n");

		const tool = createGrepTool(testDir);
		const result = await tool.execute("call-4", { pattern: "haystack" });

		const text = getTextOutput(result);
		expect(text).toContain("main.ts:1:haystack here");
		expect(text).not.toContain("node_modules");
		expect(text).not.toContain(".git/config");
		expect(text).not.toContain("ignored.log");

		const exactCase = await tool.execute("call-4b", { pattern: "haystack", ignoreCase: false });
		expect(getTextOutput(exactCase)).toContain("main.ts");
	});

	it("skips binary files via NUL-byte sniff", async () => {
		writeFileSync(join(testDir, "text.txt"), "findme\n");
		writeFileSync(join(testDir, "blob.bin"), Buffer.from([0x00, 0x01, 0x66, 0x69]));

		const tool = createGrepTool(testDir);
		const result = await tool.execute("call-5", { pattern: "." });

		expect(getTextOutput(result)).toContain("text.txt");
		expect(getTextOutput(result)).not.toContain("blob.bin");
		expect(result.details.binarySkipped).toBe(1);
	});

	it("accepts forward-slash relative paths on every platform", async () => {
		mkdirSync(join(testDir, "nested"), { recursive: true });
		writeFileSync(join(testDir, "nested", "file.txt"), "slash target\n");

		const tool = createGrepTool(testDir);
		const result = await tool.execute("call-6", { pattern: "slash target", path: "nested/file.txt" });

		expect(getTextOutput(result)).toContain("nested/file.txt:1:slash target");
	});

	it("truncates output by line cap", async () => {
		writeFileSync(join(testDir, "big.txt"), Array.from({ length: 50 }, (_, i) => `hit ${i}`).join("\n"));

		const tool = createGrepTool(testDir, { maxLines: 10 });
		const result = await tool.execute("call-7", { pattern: "hit" });

		expect(result.details.truncated).toBe(true);
		expect(result.details.matchCount).toBe(50);
		expect(getTextOutput(result)).toContain("[Truncated at");
	});

	it("fails with exact error strings for bad regex or missing path", async () => {
		const tool = createGrepTool(testDir);

		await expect(tool.execute("call-8a", { pattern: "[" })).rejects.toThrow(/^Invalid grep pattern: \[./);
		await expect(tool.execute("call-8b", { pattern: "x", path: "missing-dir" })).rejects.toThrow(
			"Could not search path: missing-dir. Error code: ENOENT.",
		);
	});
});
