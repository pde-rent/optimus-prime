import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePath, getCwdRelativePath, isLocalPath } from "../src/utils/paths.js";
import { cleanupTempDirs, makeTempDir as createTempDir } from "./test-helpers.js";

afterEach(() => {
	cleanupTempDirs();
});

describe("canonicalizePath", () => {
	it("returns the real path for a regular file", () => {
		const dir = createTempDir();
		const file = join(dir, "file.txt");
		writeFileSync(file, "hello");
		expect(canonicalizePath(file)).toBe(realpathSync(file));
	});

	it("resolves symlinks to their targets", () => {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		writeFileSync(target, "hello");
		symlinkSync(target, link);
		expect(canonicalizePath(link)).toBe(realpathSync(target));
	});

	it("resolves directory symlinks", () => {
		const dir = createTempDir();
		const targetDir = join(dir, "target-dir");
		const linkDir = join(dir, "link-dir");
		mkdirSync(targetDir);
		symlinkSync(targetDir, linkDir, "dir");
		expect(canonicalizePath(linkDir)).toBe(realpathSync(targetDir));
	});

	it("falls back to the raw path when the target does not exist", () => {
		const dir = createTempDir();
		const nonexistent = join(dir, "no-such-file");
		expect(canonicalizePath(nonexistent)).toBe(nonexistent);
	});

	it("falls back to the raw path for a dangling symlink", () => {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		symlinkSync(target, link);
		expect(canonicalizePath(link)).toBe(link);
	});
});

describe("getCwdRelativePath", () => {
	it("keeps cwd-relative names that start with dots", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(getCwdRelativePath(join(cwd, "..config", "AGENTS.md"), cwd)).toBe(join("..config", "AGENTS.md"));
	});

	it("rejects parent-directory traversals", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(getCwdRelativePath(join(cwd, "..", "AGENTS.md"), cwd)).toBeUndefined();
	});
});

describe("isLocalPath", () => {
	it("returns true for bare names", () => {
		expect(isLocalPath("my-package")).toBe(true);
	});

	it("returns true for relative paths", () => {
		expect(isLocalPath("./foo")).toBe(true);
	});

	it("returns false for npm: protocol", () => {
		expect(isLocalPath("npm:package")).toBe(false);
	});

	it("returns false for git: protocol", () => {
		expect(isLocalPath("git://repo")).toBe(false);
	});

	it("returns false for https: protocol", () => {
		expect(isLocalPath("https://example.com")).toBe(false);
	});
});
