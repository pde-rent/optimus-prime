import type { ToolAliasResolution, ToolAliasResolver } from "@earendil-works/pi-agent-core";
import { resolveApplyPatchCall } from "./tools/apply-patch.js";

/**
 * Tool-call compatibility layer for models trained on other harnesses' conventions.
 *
 * Different lineages emit different intuitive names and parameter shapes when they
 * answer from instinct instead of the advertised schema: OpenAI-style shells
 * (`shell`, `python`), Claude Code-style editors (`read`/`edit` with
 * `old_string`), Hermes/Qwen templates, and plain Unix verbs (`cat`, `ls`).
 * This table maps those onto our canonical built-in tools at resolution time.
 *
 * Canonical names are authoritative: the loop consults this table only when a call
 * names no registered tool, so aliases never shadow a real or custom tool, and an
 * alias whose canonical tool was excluded stays unavailable.
 *
 * Every entry maps one trained instinct onto one canonical tool. Names match
 * case-insensitively; parameter renames are unambiguous one-to-one mappings.
 * Unrecognized parameters are dropped and reported in the result note instead of
 * failing the call.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
	// File reads: OpenAI/Anthropic editor instincts plus Unix cat
	read: "read_file",
	view: "read_file",
	cat: "read_file",
	cat_file: "read_file",
	open_file: "read_file",
	get_file: "read_file",

	// File writes
	write: "write_file",
	create_file: "write_file",
	save_file: "write_file",

	// Editing: Claude Code / Anthropic text-editor tool names
	edit_file: "edit",
	str_replace_editor: "edit",
	str_replace_based_edit_tool: "edit",
	multiedit: "edit",

	// Content search: ripgrep and generic-search instincts
	search: "grep",
	search_files: "grep",
	regex_search: "grep",
	ripgrep: "grep",
	rg: "grep",

	// File discovery: Unix ls/dir/glob instincts
	ls: "find",
	dir: "find",
	list_dir: "find",
	list_files: "find",
	list_directory: "find",
	glob: "find",
	glob_files: "find",
	find_file: "find",

	// Shell execution: OpenAI shell and generic runner instincts
	shell: "bash",
	cmd: "bash",
	terminal: "bash",
	command: "bash",
	run_command: "bash",
	execute: "bash",
	execute_command: "bash",
	run_terminal_cmd: "bash",

	// Task tracking: Claude Code / Cursor todo tools
	todos: "todo",
	todowrite: "todo",
	todoread: "todo",
	todo_write: "todo",
	todo_read: "todo",
	update_todos: "todo",

	// Gemini CLI instincts
	run_shell_command: "bash",
	read_many_files: "read_file",
	web_search: "skill",
	websearch: "skill",
	search_web: "skill",
	google_web_search: "skill",

	// Cline / Roo Code editor instincts
	write_to_file: "write_file",
	replace_in_file: "edit",
	search_and_replace: "edit",
	list_files_top_level: "find",
	list_files_recursive: "find",
	list_files_by_extension: "find",

	// Cursor instincts
	codebase_search: "grep",
	file_search: "find",
	grep_search: "grep",

	// Claude Code web tools resolve to the websearch skill
	webfetch: "skill",

	// PowerShell instincts: the bash tool runs a Unix shell; cmdlets need translation
	powershell: "bash",
	powershell_tool: "bash",
	run_powershell: "bash",

	// Generic multi-read and shell runner instincts
	read_files: "read_file",
	read_multiple_files: "read_file",
	batch_read: "read_file",
	shell_command: "bash",
	bash_command: "bash",
	bashi: "bash",
	run_cmd: "bash",

	// Skill loader instincts resolve onto the skill tool
	load_skill: "skill",
	use_skill: "skill",
	invoke_skill: "skill",
	loadskill: "skill",

	// git_* verb instincts map onto the single git tool via dialect normalizer
	git_status: "git",
	git_add: "git",
	git_commit: "git",
	git_diff: "git",
	git_log: "git",
	git_push: "git",
	git_pull: "git",

	// Python-cell instinct: resolves to the JavaScript/TypeScript REPL kernel
	python: "repl",
	python3: "repl",
	code_interpreter: "repl",
};

/** Aliases whose canonical bash target runs a Unix shell, not the caller's assumed one. */
const NON_UNIX_SHELL_ALIASES = new Set(["powershell", "powershell_tool", "run_powershell"]);

/** Web-search argument keys, most-specific first; first present value becomes the query. */
const SEARCH_PARAM_KEYS: readonly string[] = [
	"query",
	"search_query",
	"search",
	"q",
	"query_string",
	"text",
	"input",
	"prompt",
	"url",
];

/** git_* alias suffix -> git tool op. */
const GIT_ALIAS_OPS: Readonly<Record<string, string>> = {
	status: "status",
	add: "add",
	commit: "commit",
	diff: "diff",
	log: "log",
	push: "push",
	pull: "pull",
};

/** Unambiguous parameter renames applied after the tool name resolves. Keys are lowercase aliases. */
const PARAM_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	read_file: {
		file_path: "path",
		filepath: "path",
		filename: "path",
		pathname: "path",
		start_line: "offset",
		from_line: "offset",
		begin_line: "offset",
		line_start: "offset",
		uri: "path",
	},
	write_file: {
		file_path: "path",
		filepath: "path",
		filename: "path",
		contents: "content",
		text: "content",
		data: "content",
		file_text: "content",
	},
	edit: {
		file_path: "path",
		filepath: "path",
	},
	grep: {
		query: "pattern",
		regex: "pattern",
		search_pattern: "pattern",
	},
	find: {
		directory: "path",
		dir: "path",
		root: "path",
	},
	sed: {
		exp: "expression",
		rule: "expression",
		substitution: "expression",
	},
	bash: {
		cmd: "command",
		commandline: "command",
		command_line: "command",
		shell_command: "command",
		script: "command",
	},
	repl: {
		snippet: "code",
		script: "code",
		source: "code",
	},
	skill: {
		skill_name: "name",
	},
	git: {
		files: "paths",
		file_paths: "paths",
		commit_message: "message",
		max_count: "maxCount",
		context_lines: "contextLines",
	},
};

/** Canonical parameter names per normalized tool; used to separate unknown arguments from known ones. */
const CANONICAL_PARAMS: Readonly<Record<string, readonly string[]>> = {
	read_file: ["path", "paths", "limitBytes", "offset", "limit", "lineNumbers"],
	write_file: ["path", "content", "createDirs"],
	edit: ["path", "edits"],
	grep: ["pattern", "path", "include", "exclude", "ignoreCase", "context"],
	find: ["path", "name", "type", "minSize", "maxSize", "mtimeAfter", "mtimeBefore", "caseInsensitive"],
	sed: ["path", "expression", "apply"],
	bash: ["command", "timeout"],
	repl: ["code"],
	skill: ["name"],
	// Union of every op's parameters in the git discriminated union; the op itself is derived below.
	git: [
		"op",
		"paths",
		"message",
		"all",
		"maxCount",
		"from",
		"oneline",
		"staged",
		"contextLines",
		"target",
		"mode",
		"path",
		"commit",
		"action",
		"name",
		"startPoint",
		"tags",
		"nth",
		"url",
		"destDir",
		"depth",
		"branch",
		"remote",
		"refspecs",
		"force",
		"dir",
		"bare",
		"defaultBranch",
		"allowUnrelatedHistories",
		"conclude",
		"abort",
		"upstream",
	],
};

/** Lowercase alias -> canonical parameter, merged for quick lookup. */
function renamesFor(canonicalName: string): Record<string, string> {
	return { ...(PARAM_ALIASES[canonicalName] ?? {}) };
}

/** The read({from,to}) line-window dialect: from -> offset, to -> offset/limit arithmetic. */
function applyReadFileWindow(args: Record<string, unknown>, notes: string[]): void {
	const rawFrom = args.from ?? args.offset;
	const rawTo = args.to;
	if (rawFrom === undefined && rawTo === undefined) {
		return;
	}
	const from = Number(rawFrom);
	if (Number.isFinite(from)) {
		args.offset = Math.max(1, Math.trunc(from));
	}
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	if (Number.isFinite(Number(rawTo))) {
		const to = Math.trunc(Number(rawTo));
		args.limit = offset !== undefined ? Math.max(1, to - offset + 1) : Math.max(1, to);
		notes.push(`mapped from/to lines (${rawFrom}, ${rawTo}) to offset=${offset}, limit=${args.limit}`);
	} else if (rawFrom !== undefined && rawFrom !== offset) {
		notes.push(`mapped from=${rawFrom} to offset=${offset}`);
	}
}

/** Claude text-editor view_range: [start, end] -> offset/limit arithmetic on 1-based lines. */
function applyViewRange(args: Record<string, unknown>, notes: string[]): void {
	const raw = args.view_range;
	if (!Array.isArray(raw) || raw.length !== 2) {
		return;
	}
	const start = Number(raw[0]);
	const end = Number(raw[1]);
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		return;
	}
	const offset = Math.max(1, Math.trunc(start));
	args.offset = offset;
	args.limit = Math.max(1, Math.trunc(end) - offset + 1);
	delete args.view_range;
	notes.push(`mapped view_range [${raw[0]}, ${raw[1]}] to offset=${offset}, limit=${args.limit}`);
}

/** Web-search-style arguments collapse to the websearch skill invocation; extras report as ignored. */
function applyWebSearchDialect(args: Record<string, unknown>, notes: string[]): void {
	for (const key of SEARCH_PARAM_KEYS) {
		const value = args[key];
		if (value === undefined) {
			continue;
		}
		for (const k of Object.keys(args)) {
			delete args[k];
		}
		args.name = "websearch";
		notes.push(
			`mapped search argument "${key}" to the websearch skill; the websearch skill runs searches via the repl websearch.run(query) API; call it there with the original query (${String(value)})`,
		);
		return;
	}
}

/** git_status-style aliases derive their op from the requested name when none was supplied. */
function applyGitDialect(requestedName: string, args: Record<string, unknown>, notes: string[]): void {
	if (typeof args.op === "string") {
		return;
	}
	const suffix = requestedName.toLowerCase().replace(/^git[_-]/, "");
	const op = GIT_ALIAS_OPS[suffix];
	if (op === undefined) {
		return;
	}
	args.op = op;
	notes.push(`mapped "${requestedName}" to git op "${op}"`);
}

/** Top-level old_string/new_string dialects become a one-entry edits array; edits items get renamed in place. */
function normalizeEditEdits(args: Record<string, unknown>, notes: string[]): void {
	const itemRenames: Record<string, string> = {
		old_string: "oldText",
		old_str: "oldText",
		new_string: "newText",
		new_str: "newText",
	};
	const topLevelOld = args.old_string ?? args.old_str;
	const topLevelNew = args.new_string ?? args.new_str;
	if (typeof topLevelOld === "string" && typeof topLevelNew === "string" && !Array.isArray(args.edits)) {
		args.edits = [{ oldText: topLevelOld, newText: topLevelNew }];
		notes.push("wrapped old/new strings into edits[]");
	}
	for (const [key, value] of Object.entries(args)) {
		const mapped = itemRenames[key];
		if (mapped && !(mapped in args)) {
			args[mapped] = value;
			delete args[key];
		}
	}
}

export interface NormalizedAliasArgs {
	args: Record<string, unknown>;
	ignoredArgs: string[];
	notes: string[];
}

/**
 * Rewrite alias call arguments into the canonical tool's shape. Canonical parameter
 * names pass through untouched; recognized aliases are renamed; everything else is
 * reported as ignored rather than passed to schema validation.
 */
export function normalizeAliasedToolArgs(
	requestedName: string,
	canonicalName: string,
	input: unknown,
): NormalizedAliasArgs {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return normalizeAliasedToolArgs(requestedName, canonicalName, {});
	}
	const notes: string[] = [`"${requestedName}" resolved via alias to "${canonicalName}"`];
	const workingArgs: Record<string, unknown> = { ...input };
	const canonicalParams = CANONICAL_PARAMS[canonicalName];
	if (!canonicalParams) {
		// No normalization table for this target; hand the arguments over untouched.
		return { args: workingArgs, ignoredArgs: [], notes };
	}
	if (canonicalName === "edit") {
		normalizeEditEdits(workingArgs, notes);
	}
	if (canonicalName === "skill") {
		applyWebSearchDialect(workingArgs, notes);
	}
	if (canonicalName === "git") {
		applyGitDialect(requestedName, workingArgs, notes);
	}
	const renamed = renamesFor(canonicalName);
	const canonicalSet = new Set(canonicalParams);
	const result: Record<string, unknown> = {};
	const ignoredArgs: string[] = [];
	for (const [key, value] of Object.entries(workingArgs)) {
		if (canonicalName === "read_file" && (key === "from" || key === "to" || key === "view_range")) {
			result[key] = value;
			continue;
		}
		if (canonicalSet.has(key)) {
			result[key] = value;
			continue;
		}
		const mapped = renamed[key.toLowerCase()];
		if (mapped && !(mapped in result)) {
			result[mapped] = value;
			continue;
		}
		ignoredArgs.push(key);
	}
	if (canonicalName === "read_file") {
		applyReadFileWindow(result, notes);
		applyViewRange(result, notes);
		delete result.from;
		delete result.to;
	}
	if (canonicalName === "bash" && NON_UNIX_SHELL_ALIASES.has(requestedName.toLowerCase())) {
		notes.push("the bash tool runs a Unix (POSIX) shell, not PowerShell; translate cmdlets manually");
	}
	if (canonicalName === "repl") {
		notes.push("the repl kernel executes JavaScript/TypeScript cells, not Python");
	}
	return { args: result, ignoredArgs, notes };
}

/** Resolve one requested tool-call name through the alias table. */
export function resolveToolAliasCall(requestedName: string, args?: unknown): ToolAliasResolution | undefined {
	// The Codex apply_patch dialect has its own transpiler (multi-file patches
	// route to bash; single-file updates map onto the edit tool directly).
	const patchResolution = resolveApplyPatchCall(requestedName, args);
	if (patchResolution) return patchResolution;
	const canonicalName = TOOL_ALIASES[requestedName.toLowerCase()];
	if (!canonicalName) {
		return undefined;
	}
	const { args: normalized, ignoredArgs, notes } = normalizeAliasedToolArgs(requestedName, canonicalName, args);
	let note = notes.join("; ");
	if (ignoredArgs.length > 0) {
		note += `; ignored unrecognized parameters: ${ignoredArgs.join(", ")}`;
	}
	return { name: canonicalName, args: normalized, ignoredArgs, note };
}

/** Resolver wired into the agent loop; consulted only when no registered tool matches the call name. */
export function createToolAliasResolver(): ToolAliasResolver {
	return {
		resolve(toolCallName: string) {
			return resolveToolAliasCall(toolCallName);
		},
	};
}
