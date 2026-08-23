import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { createFindTool } from "../src/core/tools/native/find.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("find tool", () => {
	const temps = makeTempDirs("find-tool-test-");
	let testDir: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(join(testDir, "src", "nested"), { recursive: true });
		writeFileSync(join(testDir, "README.md"), "readme");
		writeFileSync(join(testDir, "src", "index.ts"), "export {};");
		writeFileSync(join(testDir, "src", "nested", "util.spec.ts"), "test();");
		writeFileSync(join(testDir, "big.dat"), Buffer.alloc(2048, 7));
	});

	it("matches name globs over nested trees", async () => {
		const tool = createFindTool(testDir);
		const result = await tool.execute("call-1", { name: "*.ts" });

		const text = getTextOutput(result);
		expect(text).toContain("src/index.ts");
		expect(text).toContain("src/nested/util.spec.ts");
		expect(text).not.toContain("README.md");
		expect(result.details.count).toBe(2);
	});

	it("filters by type file vs dir", async () => {
		const tool = createFindTool(testDir);

		const dirs = await tool.execute("call-2a", { type: "dir" });
		const dirText = getTextOutput(dirs);
		expect(dirText).toContain("src");
		expect(dirText).toContain("src/nested");
		expect(dirText).not.toContain("index.ts");

		const files = await tool.execute("call-2b", { type: "file", name: "*.dat" });
		expect(getTextOutput(files)).toContain("big.dat");
	});

	it("applies size filters", async () => {
		const tool = createFindTool(testDir);
		const result = await tool.execute("call-3", { minSize: 1024 });

		expect(getTextOutput(result)).toContain("big.dat");
		expect(result.details.count).toBe(1);

		const small = await tool.execute("call-3b", { maxSize: 100 });
		const smallText = getTextOutput(small);
		expect(smallText).not.toContain("big.dat");
		expect(smallText).toContain("README.md");
	});

	it("applies mtime filters with ISO timestamps", async () => {
		const past = new Date(Date.now() - 86_400_000);
		utimesSync(join(testDir, "README.md"), past, past);
		writeFileSync(join(testDir, "fresh.txt"), "fresh");
		utimesSync(join(testDir, "fresh.txt"), new Date(), new Date());

		const tool = createFindTool(testDir);
		const recent = await tool.execute("call-4a", { mtimeAfter: new Date(Date.now() - 3_600_000).toISOString() });
		const recentText = getTextOutput(recent);
		expect(recentText).toContain("fresh.txt");
		expect(recentText).not.toContain("README.md");

		const older = await tool.execute("call-4b", { mtimeBefore: new Date(Date.now() - 43_200_000).toISOString() });
		expect(getTextOutput(older)).toContain("README.md");
	});

	it("supports case-insensitive matching for Windows filesystems", async () => {
		writeFileSync(join(testDir, "MixedCase.TXT"), "x");

		const tool = createFindTool(testDir);
		const sensitive = await tool.execute("call-5a", { name: "*.txt" });
		expect(getTextOutput(sensitive)).not.toContain("MixedCase.TXT");

		const insensitive = await tool.execute("call-5b", { name: "*.txt", caseInsensitive: true });
		expect(getTextOutput(insensitive)).toContain("MixedCase.TXT");
	});

	it("skips node_modules and accepts forward-slash roots", async () => {
		mkdirSync(join(testDir, "node_modules"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", "dep.ts"), "x");

		const tool = createFindTool(testDir);
		const result = await tool.execute("call-6", { path: "./src/", name: "*.ts" });

		const text = getTextOutput(result);
		expect(text).toContain("nested/util.spec.ts");
		expect(text).toContain("index.ts");
		expect(text).not.toContain("node_modules");
	});

	it("reports truncation and exact errors", async () => {
		for (let i = 0; i < 30; i++) {
			writeFileSync(join(testDir, `f${i}.txt`), "x");
		}

		const tool = createFindTool(testDir, { maxLines: 10 });
		const result = await tool.execute("call-7a", { name: "f*.txt" });
		expect(result.details.truncated).toBe(true);
		expect(getTextOutput(result)).toContain("[Truncated at");

		await expect(tool.execute("call-7b", { path: "no-such-dir" })).rejects.toThrow(
			"Could not search path: no-such-dir. Error code: ENOENT.",
		);
		await expect(tool.execute("call-7c", { mtimeAfter: "yesterday-ish" })).rejects.toThrow(
			"Invalid find filter: yesterday-ish. Expected ISO 8601.",
		);
	});
});
