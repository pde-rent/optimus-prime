import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { normalizeAliasedToolArgs, resolveToolAliasCall, TOOL_ALIASES } from "../src/core/tool-aliases.js";
import { BUILTIN_TOOL_NAMES, createAllToolDefinitions } from "../src/core/tools/index.js";

describe("tool aliases", () => {
	it("keeps every alias pointed at a canonical built-in tool", () => {
		for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
			expect(BUILTIN_TOOL_NAMES).toContain(canonical);
			expect(BUILTIN_TOOL_NAMES).not.toContain(alias);
		}
	});

	it("pins BUILTIN_TOOL_NAMES to the registered built-in tools", () => {
		expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(Object.keys(createAllToolDefinitions(".")).sort());
	});

	it("does not resolve canonical names through the alias table", () => {
		for (const name of BUILTIN_TOOL_NAMES) {
			expect(resolveToolAliasCall(name)).toBeUndefined();
		}
		expect(resolveToolAliasCall("totally_unknown")).toBeUndefined();
	});

	it("resolves the poolside read dialect with from/to line windows", () => {
		const resolved = resolveToolAliasCall("read", { path: "/tmp/a.txt", from: 10, to: 14 });
		expect(resolved?.name).toBe("read_file");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt", offset: 10, limit: 5 });
		expect(resolved?.note).toContain('"read"');
		expect(resolved?.note).toContain("offset=10");
	});

	it("resolves the poolside shell dialect with cmd", () => {
		const resolved = resolveToolAliasCall("shell", { cmd: "bun run typecheck" });
		expect(resolved?.name).toBe("bash");
		expect(resolved?.args).toEqual({ command: "bun run typecheck" });
	});

	it("matches alias and parameter names case-insensitively", () => {
		const resolved = resolveToolAliasCall("Read", { FilePath: "/tmp/a.txt" });
		expect(resolved?.name).toBe("read_file");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt" });
	});

	it("wraps Claude-style old_string/new_string into edits[]", () => {
		const resolved = resolveToolAliasCall("str_replace_editor", {
			file_path: "/tmp/a.txt",
			old_string: "before",
			new_string: "after",
		});
		expect(resolved?.name).toBe("edit");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt", edits: [{ oldText: "before", newText: "after" }] });
	});

	it("reports ignored parameters in the note instead of failing", () => {
		const resolved = resolveToolAliasCall("shell", { cmd: "ls", cwd: "/tmp" });
		expect(resolved?.ignoredArgs).toEqual(["cwd"]);
		expect(resolved?.note).toContain("ignored unrecognized parameters: cwd");
	});

	it("hints that python resolves to the JavaScript REPL kernel", () => {
		const resolved = resolveToolAliasCall("python", { code: "print(1)" });
		expect(resolved?.name).toBe("repl");
		expect(resolved?.args).toEqual({ code: "print(1)" });
		expect(resolved?.note).toContain("JavaScript/TypeScript");
	});

	it("normalizes arguments without mutating the caller's object", () => {
		const input = { file_path: "/tmp/a.txt", contents: "hello" };
		const { args } = normalizeAliasedToolArgs("write", "write_file", input);
		expect(args).toEqual({ path: "/tmp/a.txt", content: "hello" });
		expect(input).toEqual({ file_path: "/tmp/a.txt", contents: "hello" });
	});
});

describe("default built-in roster", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-roster-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("activates every registered built-in tool when no allowlist is given", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
		});
		try {
			const active = new Set(session.getActiveToolNames());
			for (const name of BUILTIN_TOOL_NAMES) {
				expect(active.has(name)).toBe(true);
			}
		} finally {
			session.dispose();
		}
	});
});
