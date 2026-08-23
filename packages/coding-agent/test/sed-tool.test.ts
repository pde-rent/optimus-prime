import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createSedTool, parseSubstitution } from "../src/core/tools/native/sed.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("sed tool", () => {
	const temps = makeTempDirs("sed-tool-test-");
	let testDir: string;
	let filePath: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(testDir, { recursive: true });
		filePath = join(testDir, "data.txt");
		writeFileSync(filePath, "alpha one\nalpha two\nbeta three\n");
	});

	it("dry-runs by default: returns a diff and leaves the file untouched", async () => {
		const tool = createSedTool(testDir);
		const result = await tool.execute("call-1", { path: filePath, expression: "s/alpha/gamma/" });

		const text = getTextOutput(result);
		expect(text).toContain("Dry run for");
		expect(text).toContain("+1 gamma one");
		expect(text).toContain("-1 alpha one");
		expect(text).toContain("apply:true");
		expect(readFileSync(filePath, "utf-8")).toBe("alpha one\nalpha two\nbeta three\n");
		expect(result.details.applied).toBe(false);
	});

	it("apply:true writes through the mutation queue (round-trip)", async () => {
		const tool = createSedTool(testDir);
		await tool.execute("call-2a", { path: filePath, expression: "s/alpha/gamma/" }); // dry-run
		const applied = await tool.execute("call-2b", { path: filePath, expression: "s/alpha/gamma/", apply: true });

		expect(applied.details.applied).toBe(true);
		expect(applied.details.diff).toBeTruthy();
		expect(readFileSync(filePath, "utf-8")).toBe("gamma one\nalpha two\nbeta three\n");
	});

	it("supports g flag, alternate delimiters and case-insensitive matching", async () => {
		const tool = createSedTool(testDir);

		await tool.execute("call-3a", { path: filePath, expression: "s/o/0/g", apply: true });
		expect(readFileSync(filePath, "utf-8")).toBe("alpha 0ne\nalpha tw0\nbeta three\n");
		writeFileSync(filePath, "alpha one\nalpha two\nbeta three\n");

		await tool.execute("call-3b", { path: filePath, expression: "s|alpha|delta|g", apply: true });
		expect(readFileSync(filePath, "utf-8")).toBe("delta one\ndelta two\nbeta three\n");
		writeFileSync(filePath, "Alpha ONE\nalpha two\n");

		const result = await tool.execute("call-3c", { path: filePath, expression: "s/^alpha/x/i", apply: true });
		expect(readFileSync(filePath, "utf-8").split("\n")[0]).toBe("x ONE");
		expect(result.details.applied).toBe(true);
	});

	it("preserves BOM and CRLF line endings when applying", async () => {
		writeFileSync(filePath, "\uFEFFalpha one\r\nalpha two\r\n");

		const tool = createSedTool(testDir);
		await tool.execute("call-4", { path: filePath, expression: "s/alpha/gamma/g", apply: true });

		const content = readFileSync(filePath, "utf-8");
		expect(content.startsWith("\uFEFF")).toBe(true);
		expect(content).toBe("\uFEFFgamma one\r\ngamma two\r\n");
	});

	it("answers without a diff when nothing matches", async () => {
		const tool = createSedTool(testDir);
		const result = await tool.execute("call-5", { path: filePath, expression: "s/nonexistent/replaced/" });

		expect(getTextOutput(result)).toContain("No matches");
		expect(result.details.diff).toBe("");
		expect(readFileSync(filePath, "utf-8")).toBe("alpha one\nalpha two\nbeta three\n");
	});

	it("rejects invalid expressions and unreadable paths with exact errors", async () => {
		const tool = createSedTool(testDir);

		await expect(tool.execute("call-6a", { path: filePath, expression: "alpha->gamma" })).rejects.toThrow(
			"Invalid sed expression: alpha->gamma.",
		);
		await expect(tool.execute("call-6b", { path: filePath, expression: "s/a/b/q" })).rejects.toThrow(
			'Unsupported flag(s) "q". Supported flags: g, i.',
		);
		await expect(
			tool.execute("call-6c", { path: join(testDir, "missing.txt"), expression: "s/a/b/", apply: true }),
		).rejects.toThrow("Could not read file:");
	});
});

describe("parseSubstitution", () => {
	it("parses pattern, replacement and flags", () => {
		const parsed = parseSubstitution("s/a+b/x/gi");
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.globalFlag).toBe(true);
		expect(parsed.pattern.test("AAB")).toBe(true);
		expect(parsed.replacement).toBe("x");
	});

	it("keeps regex backslashes and resolves escaped delimiters", () => {
		const parsed = parseSubstitution("s/a\\/b/c/");
		if ("error" in parsed) throw new Error(parsed.error);
		expect(new RegExp(parsed.pattern.source).test("a/b")).toBe(true);

		const dot = parseSubstitution("s/\\d+/N/");
		if ("error" in dot) throw new Error(dot.error);
		expect("abc 42".replace(dot.pattern, dot.replacement)).toBe("abc N");
	});

	it("returns an error object for malformed input", () => {
		expect(parseSubstitution("no-delimiters")).toHaveProperty("error");
		expect(parseSubstitution("s/a")).toHaveProperty("error");
	});
});
