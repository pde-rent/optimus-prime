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

describe("gemini cli instinct aliases", () => {
	it("maps run_shell_command onto bash", () => {
		const resolved = resolveToolAliasCall("run_shell_command", { command: "bun test" });
		expect(resolved?.name).toBe("bash");
		expect(resolved?.args).toEqual({ command: "bun test" });
	});

	it("maps read_many_files onto read_file keeping paths", () => {
		const resolved = resolveToolAliasCall("read_many_files", { paths: ["a.ts", "b.ts"] });
		expect(resolved?.name).toBe("read_file");
		expect(resolved?.args).toEqual({ paths: ["a.ts", "b.ts"] });
	});

	it("maps the web_search family onto the websearch skill with the query preserved in the note", () => {
		for (const name of ["web_search", "WebSearch", "search_web", "google_web_search"]) {
			const resolved = resolveToolAliasCall(name, { query: "bun vs node benchmarks" });
			expect(resolved?.name).toBe("skill");
			expect(resolved?.args).toEqual({ name: "websearch" });
			expect(resolved?.note).toContain("websearch.run(query)");
			expect(resolved?.note).toContain("bun vs node benchmarks");
		}
	});
});

describe("cline and roo instinct aliases", () => {
	it("maps write_to_file onto write_file", () => {
		const resolved = resolveToolAliasCall("write_to_file", { path: "/tmp/a.txt", content: "hi" });
		expect(resolved?.name).toBe("write_file");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt", content: "hi" });
	});

	it("maps replace_in_file onto edit and reports its diff argument as ignored", () => {
		const resolved = resolveToolAliasCall("replace_in_file", { path: "/tmp/a.txt", diff: "=======" });
		expect(resolved?.name).toBe("edit");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt" });
		expect(resolved?.ignoredArgs).toEqual(["diff"]);
	});

	it("maps search_and_replace onto edit", () => {
		const resolved = resolveToolAliasCall("search_and_replace", {
			path: "/tmp/a.txt",
			old_string: "before",
			new_string: "after",
		});
		expect(resolved?.name).toBe("edit");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt", edits: [{ oldText: "before", newText: "after" }] });
	});

	it("maps list_files variants onto find", () => {
		for (const name of ["list_files_top_level", "list_files_recursive", "list_files_by_extension"]) {
			const resolved = resolveToolAliasCall(name, { path: "/tmp" });
			expect(resolved?.name).toBe("find");
			expect(resolved?.args).toEqual({ path: "/tmp" });
		}
	});
});

describe("cursor instinct aliases", () => {
	it("maps codebase_search and grep_search onto grep", () => {
		const codebase = resolveToolAliasCall("codebase_search", { query: "TODO markers" });
		expect(codebase?.name).toBe("grep");
		expect(codebase?.args).toEqual({ pattern: "TODO markers" });
		const grepSearch = resolveToolAliasCall("grep_search", { pattern: "foo.*bar" });
		expect(grepSearch?.name).toBe("grep");
		expect(grepSearch?.args).toEqual({ pattern: "foo.*bar" });
	});

	it("maps file_search onto find", () => {
		const resolved = resolveToolAliasCall("file_search", {});
		expect(resolved?.name).toBe("find");
	});
});

describe("claude code web instinct aliases", () => {
	it("maps WebFetch onto the websearch skill via the url argument", () => {
		const resolved = resolveToolAliasCall("WebFetch", { url: "https://example.com/docs" });
		expect(resolved?.name).toBe("skill");
		expect(resolved?.args).toEqual({ name: "websearch" });
		expect(resolved?.note).toContain("https://example.com/docs");
	});

	it("passes explicit skill names through untouched", () => {
		const resolved = resolveToolAliasCall("load_skill", { name: "stats" });
		expect(resolved?.name).toBe("skill");
		expect(resolved?.args).toEqual({ name: "stats" });
	});
});

describe("powershell instinct aliases", () => {
	it("maps powershell variants onto bash with a unix-shell note", () => {
		for (const name of ["powershell", "powershell_tool", "run_powershell"]) {
			const resolved = resolveToolAliasCall(name, { command: "Get-ChildItem" });
			expect(resolved?.name).toBe("bash");
			expect(resolved?.args).toEqual({ command: "Get-ChildItem" });
			expect(resolved?.note).toContain("Unix");
		}
	});
});

describe("generic batch read and shell instinct aliases", () => {
	it("maps multi-read aliases onto read_file keeping paths", () => {
		for (const name of ["read_files", "read_multiple_files", "batch_read"]) {
			const resolved = resolveToolAliasCall(name, { paths: ["a.md"] });
			expect(resolved?.name).toBe("read_file");
			expect(resolved?.args).toEqual({ paths: ["a.md"] });
		}
	});

	it("maps generic shell aliases onto bash", () => {
		for (const name of ["shell_command", "bash_command", "bashi", "run_cmd"]) {
			const resolved = resolveToolAliasCall(name, { command: "echo hi" });
			expect(resolved?.name).toBe("bash");
			expect(resolved?.args).toEqual({ command: "echo hi" });
		}
	});

	it("maps use_skill and invoke_skill onto skill with skill_name renamed", () => {
		for (const name of ["use_skill", "invoke_skill", "loadSkill"]) {
			const resolved = resolveToolAliasCall(name, { skill_name: "chart" });
			expect(resolved?.name).toBe("skill");
			expect(resolved?.args).toEqual({ name: "chart" });
		}
	});
});

describe("git verb instinct aliases", () => {
	it("derives the op from the requested name when none was supplied", () => {
		for (const [name, op] of [
			["git_status", "status"],
			["git_diff", "diff"],
			["git_log", "log"],
			["git_push", "push"],
			["git_pull", "pull"],
		] as const) {
			const resolved = resolveToolAliasCall(name);
			expect(resolved?.name).toBe("git");
			expect(resolved?.args).toEqual({ op });
			expect(resolved?.note).toContain(`git op "${op}"`);
		}
	});

	it("renames git_add files onto paths", () => {
		const resolved = resolveToolAliasCall("git_add", { files: ["src/a.ts"] });
		expect(resolved?.name).toBe("git");
		expect(resolved?.args).toEqual({ op: "add", paths: ["src/a.ts"] });
	});

	it("maps git_commit without inventing an automatic stage-all", () => {
		const resolved = resolveToolAliasCall("git_commit", { message: "fix: bug" });
		expect(resolved?.name).toBe("git");
		expect(resolved?.args).toEqual({ op: "commit", message: "fix: bug" });
		expect((resolved?.args as Record<string, unknown>).all).toBeUndefined();
	});

	it("keeps known git params and drops unknown ones with a note", () => {
		const push = resolveToolAliasCall("git_push", { remote: "origin", force: true });
		expect(push?.name).toBe("git");
		expect(push?.args).toEqual({ op: "push", remote: "origin", force: true });
		expect(push?.ignoredArgs).toEqual([]);

		const unknown = resolveToolAliasCall("git_status", { submodules: true });
		expect(unknown?.args).toEqual({ op: "status" });
		expect(unknown?.ignoredArgs).toEqual(["submodules"]);
	});

	it("leaves explicit ops on git verb alias calls untouched", () => {
		const resolved = resolveToolAliasCall("git_status", { op: "branch", action: "list" });
		expect(resolved?.name).toBe("git");
		expect(resolved?.args).toEqual({ op: "branch", action: "list" });
	});
});

describe("text editor parameter dialects", () => {
	it("maps view_range windows onto offset/limit", () => {
		const resolved = resolveToolAliasCall("read", { path: "/tmp/a.txt", view_range: [10, 14] });
		expect(resolved?.name).toBe("read_file");
		expect(resolved?.args).toEqual({ path: "/tmp/a.txt", offset: 10, limit: 5 });
		expect(resolved?.note).toContain("view_range [10, 14]");
	});

	it("renames uri to path for reads", () => {
		const resolved = resolveToolAliasCall("cat_file", { uri: "file:///tmp/a.txt" });
		expect(resolved?.name).toBe("read_file");
		expect(resolved?.args).toEqual({ path: "file:///tmp/a.txt" });
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
