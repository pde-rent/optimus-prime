import { describe, expect, it } from "bun:test";
import {
	MAX_UNIFIED_DIFF_LINES,
	type ParsedUnifiedDiff,
	parseUnifiedDiff,
	type UnifiedDiffFile,
} from "../src/modes/interactive/components/unified-diff.js";

function fileBlocks(parsed: ParsedUnifiedDiff): UnifiedDiffFile[] {
	return parsed.blocks
		.filter((block): block is { kind: "diff"; file: UnifiedDiffFile } => block.kind === "diff")
		.map((block) => block.file);
}

const SINGLE_FILE_DIFF = [
	"diff --git a/src/foo.ts b/src/foo.ts",
	"index 1234567..89abcde 100644",
	"--- a/src/foo.ts",
	"+++ b/src/foo.ts",
	"@@ -1,3 +1,4 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
	" const d = 5;",
].join("\n");

describe("parseUnifiedDiff", () => {
	it("parses a single-file git diff with correct line numbers and counts", () => {
		const parsed = parseUnifiedDiff(SINGLE_FILE_DIFF);
		expect(parsed).toBeDefined();
		expect(parsed?.tooLarge).toBe(false);
		const files = fileBlocks(parsed!);
		expect(files).toHaveLength(1);

		const file = files[0];
		expect(file.path).toBe("src/foo.ts");
		expect(file.added).toBe(2);
		expect(file.removed).toBe(1);
		const lines = file.diffText.split("\n");
		expect(lines[0]).toBe(" 1 const a = 1;");
		expect(lines[1]).toBe("-2 const b = 2;");
		expect(lines[2]).toBe("+2 const b = 3;");
		expect(lines[3]).toBe("+3 const c = 4;");
		expect(lines[4]).toBe(" 3 const d = 5;");
	});

	it("keeps plain-text regions around diffs as text blocks", () => {
		const text = [`prefix line`, ...SINGLE_FILE_DIFF.split("\n"), "", "tip: something"].join("\n");
		const parsed = parseUnifiedDiff(text)!;
		const kinds = parsed.blocks.map((block) => block.kind);
		expect(kinds).toEqual(["text", "diff", "text"]);
		expect(parsed.blocks[0]).toEqual({ kind: "text", text: "prefix line" });
		expect(parsed.blocks[2]).toEqual({ kind: "text", text: "tip: something" });
	});

	it("splits multi-file diffs into one block per file", () => {
		const multi = [
			"diff --git a/a.txt b/a.txt",
			"--- a/a.txt",
			"+++ b/a.txt",
			"@@ -1,1 +1,1 @@",
			"-old a",
			"+new a",
			"diff --git b/b.txt b/b.txt",
			"index 111..222 100644",
			"--- b/b.txt",
			"+++ b/b.txt",
			"@@ -10,2 +10,3 @@",
			" context",
			"+added b",
		].join("\n");
		const parsed = parseUnifiedDiff(multi)!;
		const files = fileBlocks(parsed);
		expect(files).toHaveLength(2);
		expect(files[0].path).toBe("a.txt");
		expect(files[1].path).toBe("b.txt");
		expect(files[1].added).toBe(1);
		expect(files[1].removed).toBe(0);
	});

	it("handles created and deleted files (/dev/null headers)", () => {
		const created = [
			"diff --git a/new.txt b/new.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/new.txt",
			"@@ -0,0 +1,2 @@",
			"+hello",
			"+world",
		].join("\n");
		const parsed = parseUnifiedDiff(created)!;
		const files = fileBlocks(parsed);
		expect(files[0].path).toBe("new.txt");
		expect(files[0].added).toBe(2);

		const deleted = [
			"diff --git a/gone.txt b/gone.txt",
			"deleted file mode 100644",
			"--- a/gone.txt",
			"+++ /dev/null",
			"@@ -1,1 +0,1 @@",
			"-bye",
		].join("\n");
		const filesDeleted = fileBlocks(parseUnifiedDiff(deleted)!);
		expect(filesDeleted[0].path).toBe("gone.txt");
		expect(filesDeleted[0].removed).toBe(1);
	});

	it("strips timestamps after tabs in header paths", () => {
		const withTimestamp = [
			"--- a/old.txt\t2024-01-01 00:00:00",
			"+++ b/old.txt\t2024-01-02 00:00:00",
			"@@ -1 +1 @@",
			"-x",
			"+y",
		].join("\n");
		const files = fileBlocks(parseUnifiedDiff(withTimestamp)!);
		expect(files[0].path).toBe("old.txt");
	});

	it("skips \\ No newline at end of file markers", () => {
		const noNl = "\\ No newline at end of file";
		const withMarker = ["--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-old", noNl, "+new", noNl].join("\n");
		const files = fileBlocks(parseUnifiedDiff(withMarker)!);
		expect(files[0].diffText.split("\n")).toHaveLength(2);
	});

	it("normalizes CRLF input", () => {
		const crlf = SINGLE_FILE_DIFF.split("\n").join("\r\n");
		const files = fileBlocks(parseUnifiedDiff(crlf)!);
		expect(files).toHaveLength(1);
		expect(files[0].added).toBe(2);
	});

	it("returns undefined for output without real diff headers (no false positives)", () => {
		expect(parseUnifiedDiff("++ done\n++ more chatter")).toBeUndefined();
		expect(parseUnifiedDiff("---\ntitle: note\n+++")).toBeUndefined();
		expect(parseUnifiedDiff("@@ -1,3 +1,3 @@\njust a hunk-looking line")).toBeUndefined();
		expect(parseUnifiedDiff("--- a/x\n+++ b/y\nno hunks here")).toBeUndefined();
		expect(parseUnifiedDiff("--- a/x\n+++ b/y\n@@ garbage @@ nonsense\n-not a hunk")).toBeUndefined();
		expect(parseUnifiedDiff("some ordinary shell output\n$ ls -la\nfile1 file2")).toBeUndefined();
		expect(parseUnifiedDiff("")).toBeUndefined();
	});

	it("flags large detected diffs instead of parsing them", () => {
		const big = [
			"--- a/big.txt",
			"+++ b/big.txt",
			`@@ -1,${MAX_UNIFIED_DIFF_LINES} +1,${MAX_UNIFIED_DIFF_LINES} @@`,
			...Array.from({ length: MAX_UNIFIED_DIFF_LINES }, (_, i) => `+line ${i}`),
		].join("\n");
		const parsed = parseUnifiedDiff(big);
		expect(parsed?.tooLarge).toBe(true);
		expect(parsed?.files).toHaveLength(0);

		const bigPlain = Array.from({ length: MAX_UNIFIED_DIFF_LINES + 1 }, (_, i) => `plain output ${i}`).join("\n");
		expect(parseUnifiedDiff(bigPlain)).toBeUndefined();
	});

	it("resumes scanning after an incomplete candidate segment", () => {
		const text = ["--- a/false-positive", "this line breaks the segment", SINGLE_FILE_DIFF].join("\n");
		const parsed = parseUnifiedDiff(text)!;
		const files = fileBlocks(parsed);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("src/foo.ts");
	});
});
