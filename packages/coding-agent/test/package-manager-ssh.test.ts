import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/** Structural view of the private parseSource helper's result, in the order the tests use it. */
type ParsedSourceShape =
	| { type: "git"; repo: string; host: string; path: string; ref?: string; pinned: boolean }
	| { type: "npm"; spec: string; name: string; pinned: boolean }
	| { type: "local"; path: string };

/**
 * The git-source normalization helpers are private on DefaultPackageManager,
 * but their behavior is the contract under test here.
 */
function callPrivateMethod<T>(instance: object, method: string, ...args: unknown[]): T {
	const fn = Reflect.get(instance, method) as (...callArgs: unknown[]) => unknown;
	return fn.apply(instance, args) as T;
}

describe("Package Manager git source parsing", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("protocol URLs without git: prefix", () => {
		it("should parse https:// URL", () => {
			const parsed = callPrivateMethod<Extract<ParsedSourceShape, { type: "git" }>>(
				packageManager,
				"parseSource",
				"https://github.com/user/repo",
			);
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse ssh:// URL", () => {
			const parsed = callPrivateMethod<Extract<ParsedSourceShape, { type: "git" }>>(
				packageManager,
				"parseSource",
				"ssh://git@github.com/user/repo",
			);
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.repo).toBe("ssh://git@github.com/user/repo");
		});
	});

	describe("shorthand URLs with git: prefix", () => {
		it("should parse git@host:path format", () => {
			const parsed = callPrivateMethod<Extract<ParsedSourceShape, { type: "git" }>>(
				packageManager,
				"parseSource",
				"git:git@github.com:user/repo",
			);
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.repo).toBe("git@github.com:user/repo");
			expect(parsed.pinned).toBe(false);
		});

		it("should parse host/path shorthand", () => {
			const parsed = callPrivateMethod<Extract<ParsedSourceShape, { type: "git" }>>(
				packageManager,
				"parseSource",
				"git:github.com/user/repo",
			);
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse shorthand with ref", () => {
			const parsed = callPrivateMethod<Extract<ParsedSourceShape, { type: "git" }>>(
				packageManager,
				"parseSource",
				"git:git@github.com:user/repo@v1.0.0",
			);
			expect(parsed.type).toBe("git");
			expect(parsed.ref).toBe("v1.0.0");
			expect(parsed.pinned).toBe(true);
		});
	});

	describe("unsupported without git: prefix", () => {
		it("should treat git@host:path as local without git: prefix", () => {
			const parsed = callPrivateMethod<Extract<ParsedSourceShape, { type: "local" }>>(
				packageManager,
				"parseSource",
				"git@github.com:user/repo",
			);
			expect(parsed.type).toBe("local");
		});
	});

	describe("identity normalization", () => {
		it("should normalize protocol and shorthand-prefixed URLs to same identity", () => {
			const prefixed = callPrivateMethod<string>(
				packageManager,
				"getPackageIdentity",
				"git:git@github.com:user/repo",
			);
			const https = callPrivateMethod<string>(packageManager, "getPackageIdentity", "https://github.com/user/repo");
			const ssh = callPrivateMethod<string>(packageManager, "getPackageIdentity", "ssh://git@github.com/user/repo");

			expect(prefixed).toBe("git:github.com/user/repo");
			expect(prefixed).toBe(https);
			expect(prefixed).toBe(ssh);
		});
	});
});
