import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { platform } from "process";
import { createLnTool } from "../src/core/tools/native/ln.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("ln tool", () => {
	const temps = makeTempDirs("ln-tool-test-");
	let testDir: string;
	let targetPath: string;

	beforeEach(() => {
		testDir = temps.create();
		mkdirSync(testDir, { recursive: true });
		targetPath = join(testDir, "target.txt");
		writeFileSync(targetPath, "shared content\n");
	});

	it("creates a symbolic link by default", async () => {
		const linkPath = join(testDir, "sym.txt");

		const tool = createLnTool(testDir);
		const result = await tool.execute("call-1", { target: targetPath, linkPath });

		expect(result.details.linkType).toBe("symbolic");
		expect(readlinkSync(linkPath)).toContain("target.txt");
		expect(readFileSync(linkPath, "utf-8")).toBe("shared content\n");
		expect(getTextOutput(result)).toBe(`Created symbolic link ${linkPath} -> ${targetPath}.`);
	});

	it("creates a hard link sharing content", async () => {
		const linkPath = join(testDir, "hard.txt");

		const tool = createLnTool(testDir);
		const result = await tool.execute("call-2", { target: targetPath, linkPath, linkType: "hard" });

		expect(result.details.linkType).toBe("hard");
		expect(statSync(linkPath).ino).toBe(statSync(targetPath).ino);
		writeFileSync(targetPath, "mutated through the original\n");
		expect(readFileSync(linkPath, "utf-8")).toBe("mutated through the original\n");
	});

	it("refuses an existing destination or missing target with exact errors", async () => {
		const existing = join(testDir, "existing.txt");
		writeFileSync(existing, "occupied\n");

		const tool = createLnTool(testDir);

		await expect(tool.execute("call-3a", { target: targetPath, linkPath: existing })).rejects.toThrow(
			`Link destination already exists: ${existing}.`,
		);
		await expect(
			tool.execute("call-3b", { target: join(testDir, "ghost.txt"), linkPath: join(testDir, "l.txt") }),
		).rejects.toThrow("Link target does not exist:");
		expect(existsSync(join(testDir, "l.txt"))).toBe(false);
	});

	it("resolves forward-slash relative paths against cwd", async () => {
		mkdirSync(join(testDir, "links"), { recursive: true });

		const tool = createLnTool(testDir);
		const result = await tool.execute("call-4", { target: "./target.txt", linkPath: "links/sym.txt" });

		expect(existsSync(join(testDir, "links", "sym.txt"))).toBe(true);
		expect(result.details.linkType).toBe("symbolic");
		if (platform !== "win32") {
			expect(readlinkSync(join(testDir, "links", "sym.txt"))).toContain("target.txt");
		}
	});

	it("surfaces OS errors for impossible links without crashing", async () => {
		if (platform === "win32") return; // symlink privileges vary on Windows CI.

		const dirTarget = join(testDir, "adir");
		mkdirSync(dirTarget, { recursive: true });
		const linkPath = join(testDir, "hard-to-dir.txt");

		const tool = createLnTool(testDir);
		await expect(tool.execute("call-5", { target: dirTarget, linkPath, linkType: "hard" })).rejects.toThrow(
			/^Could not create link:/,
		);
		expect(existsSync(linkPath)).toBe(false);
	});
});
