import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspect } from "node:util";
import { deserialize, serialize } from "node:v8";
import { createContext, runInContext } from "node:vm";
import { generateDiffString } from "../tools/edit-diff.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	DIFF_DISPLAY_MIME,
	type KernelDiffDisplay,
	type KernelSentAgentMessage,
} from "../tools/repl-types.js";
import { truncateHead, truncateTail } from "../tools/truncate.js";
import { bashCommand, parseCell } from "./cell.js";
import type {
	BunReplExecuteRequest,
	BunReplHostRequest,
	BunReplHostToRepl,
	BunReplReplToHost,
	BunReplResolvedRef,
} from "./protocol.js";
import { hasStaticImport, transformTopLevel } from "./transform.js";

// ---------------------------------------------------------------------------
// Persistent vm context. Top-level declarations persist by being rewritten to
// assignments against `globalThis` (see transform.ts), and the context object
// itself survives across execute calls, so `const`/`let`/`class`/`function`
// bindings keep their values between separate executes.
// ---------------------------------------------------------------------------
const context: Record<string, unknown> = {};
const vmContext = createContext(context);

const pendingHostRequests = new Map<
	string,
	{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}
>();

function send(msg: BunReplReplToHost): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function serializeValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "symbol") return value.toString();
	if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
	// `inspect` renders Map/Set/Error/class instances faithfully, where JSON.stringify
	// flattens them to `{}`.
	try {
		return inspect(value, INSPECT_OPTIONS);
	} catch {
		return String(value);
	}
}

/** Shared `util.inspect` settings: deep enough to be useful, bounded so one cell cannot flood. */
const INSPECT_OPTIONS = {
	depth: 4,
	maxArrayLength: 200,
	maxStringLength: 10_000,
	breakLength: 120,
	colors: false,
	getters: false,
} as const;

const SENT_AGENT_MESSAGE_ROLES = ["parent", "sibling", "child"] as const;
type SentAgentMessageRole = (typeof SENT_AGENT_MESSAGE_ROLES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert an agent_message.send receipt (AgentSessionMessageReceipt) into a KernelSentAgentMessage. */
function receiptToKernelSentAgentMessage(reply: unknown, receiverRole?: unknown): KernelSentAgentMessage | undefined {
	if (!isRecord(reply)) return undefined;
	const { id, message, deliveryStatus, target } = reply;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		!isRecord(target) ||
		typeof target.activeSessionId !== "string" ||
		typeof target.sessionId !== "string"
	) {
		return undefined;
	}
	return {
		id,
		message,
		deliveryStatus,
		...(SENT_AGENT_MESSAGE_ROLES.includes(receiverRole as SentAgentMessageRole)
			? { receiverRole: receiverRole as SentAgentMessageRole }
			: {}),
		target: {
			activeSessionId: target.activeSessionId,
			sessionId: target.sessionId,
			...(typeof target.sessionName === "string" ? { sessionName: target.sessionName } : {}),
		},
	};
}

const hostBridge = {
	async hostRequest(requestType: string, payload: Record<string, unknown>): Promise<unknown> {
		const requestId = crypto.randomUUID();
		const pending = new Promise((resolve, reject) => {
			pendingHostRequests.set(requestId, { resolve, reject });
			const msg: BunReplHostRequest = {
				type: "hostRequest",
				requestId,
				requestType,
				payload,
			};
			send(msg);
		});
		return pending;
	},
};

const rlm = async (prompt: string, kwargs?: Record<string, unknown>) =>
	hostBridge.hostRequest("rlm.run", { prompt, kwargs: kwargs ?? {} });

type HarnessOptions = Record<string, unknown>;
const harnessRequest = (type: string, options?: HarnessOptions) => hostBridge.hostRequest(type, options ?? {});

/**
 * MCP, as one binding rather than one per server.
 *
 * The protocol client runs host-side, so credentials never enter this sandbox and
 * there is one implementation rather than a copy per server. Naming the server as
 * an argument keeps the prompt cost at zero when no server is configured, and
 * avoids flattening a server's whole tool list into the model's tool surface --
 * which is where other harnesses meet name collisions and length limits.
 */
const mcpObj = {
	/** Configured servers and whether each one currently has credentials. */
	servers: () => hostBridge.hostRequest("mcp.list_servers", {}),
	/** Tools a server offers, following pagination. */
	tools: (server: string) => hostBridge.hostRequest("mcp.list_tools", { server }),
	/**
	 * Call a tool. Pass the tool's `inputSchema` from `tools()` when the server
	 * mirrors parameters into headers; without it such a call is rejected.
	 */
	call: (server: string, tool: string, args?: Record<string, unknown>, inputSchema?: Record<string, unknown>) =>
		hostBridge.hostRequest("mcp.call_tool", { server, tool, arguments: args ?? {}, input_schema: inputSchema }),
	/** Re-read credentials for a server after a login or a token refresh. */
	refresh: (server: string) => hostBridge.hostRequest("mcp.refresh", { server }),
};

/**
 * Continual harness CRUD. Host-owned store; every call is a host request.
 * `harness.delete_subagent` deletes a stored subagent spec and is unrelated to
 * `rlm.delete_subagent`, which terminates a live child agent.
 */
const harnessObj = {
	create_memory: (options?: HarnessOptions) => harnessRequest("harness.create_memory", options),
	update_memory: (options?: HarnessOptions) => harnessRequest("harness.update_memory", options),
	delete_memory: (options?: HarnessOptions) => harnessRequest("harness.delete_memory", options),
	search_memory: (options?: HarnessOptions) => harnessRequest("harness.search_memory", options),
	get_memory: (options?: HarnessOptions) => harnessRequest("harness.get_memory", options),
	create_skill: (options?: HarnessOptions) => harnessRequest("harness.create_skill", options),
	update_skill: (options?: HarnessOptions) => harnessRequest("harness.update_skill", options),
	delete_skill: (options?: HarnessOptions) => harnessRequest("harness.delete_skill", options),
	create_subagent: (options?: HarnessOptions) => harnessRequest("harness.create_subagent", options),
	update_subagent: (options?: HarnessOptions) => harnessRequest("harness.update_subagent", options),
	delete_subagent: (options?: HarnessOptions) => harnessRequest("harness.delete_subagent", options),
	create_prompt_note: (options?: HarnessOptions) => harnessRequest("harness.create_prompt_note", options),
	update_prompt_note: (options?: HarnessOptions) => harnessRequest("harness.update_prompt_note", options),
	delete_prompt_note: (options?: HarnessOptions) => harnessRequest("harness.delete_prompt_note", options),
	record_refinement: (options?: HarnessOptions) => harnessRequest("harness.record_refinement", options),
	consolidate_memories: (options?: HarnessOptions) => harnessRequest("harness.consolidate_memories", options),
	overview: (options?: HarnessOptions) => harnessRequest("harness.overview", options),
};

/**
 * The model-facing spawn form is `spawn`; it is an exact alias of `rlm`, which stays
 * functional. Both are the spawn function with the registry and harness helpers assigned
 * onto them.
 */
const rlmObj = Object.assign(rlm, {
	run: rlm,
	harness: harnessObj,
	get_harness_state: (options?: HarnessOptions) => harnessRequest("harness.get_state", options),
	// Applies to the next turn, never to the cell that calls it.
	set_effort: (level: string) => hostBridge.hostRequest("rlm.set_effort", { level }),
	get_effort: () => hostBridge.hostRequest("rlm.get_effort", {}),
	set_max_depth: (maxDepth: number) => hostBridge.hostRequest("rlm.set_max_depth", { maxDepth }),
	get_max_depth: () => hostBridge.hostRequest("rlm.get_max_depth", {}),
	set_context_budget: (request: { maxContextTokens?: number; compactAtTokens?: number }) =>
		hostBridge.hostRequest("rlm.set_context_budget", request),
	get_context_budget: () => hostBridge.hostRequest("rlm.get_context_budget", {}),
	find_models: (query: string) => hostBridge.hostRequest("rlm.find_models", { query }),
	list_subagents: () => hostBridge.hostRequest("rlm.list_subagents", {}),
	delete_subagent: (target: string) => hostBridge.hostRequest("rlm.delete_subagent", { target }),
	host_request: (type: string, payload: Record<string, unknown>) => hostBridge.hostRequest(type, payload),
});

/**
 * Harness-owned helpers the runtime has no equivalent for, grouped under one
 * name so the sandbox's bare-name surface does not grow and so a cell's own
 * variables cannot shadow them by accident. `pi` is the CLI's own name.
 *
 * Deliberately small: anything Bun already ships (`Bun.stringWidth`,
 * `Bun.stripANSI`, `Bun.sliceAnsi`, `Bun.wrapAnsi`, `Bun.markdown`) stays with
 * Bun rather than being mirrored here. What is left are the two things a cell
 * would otherwise hand-roll wrongly: a line diff, and truncation that cannot
 * split a UTF-8 sequence or a line.
 *
 * Pure functions over their arguments: no harness state is read or mutated, so
 * a cell can call them freely.
 */
const piObj = Object.freeze({
	/** Line diff with line numbers and elided context, in the format the edit tool prints. */
	diff: (oldText: string, newText: string, options?: { contextLines?: number; startLine?: number }) =>
		generateDiffString(oldText, newText, options?.contextLines ?? 4, options?.startLine ?? 1),
	/** Keep the first lines/bytes; never returns a partial line. */
	truncateHead,
	/** Keep the last lines/bytes; splits on UTF-8 boundaries, not bytes. */
	truncateTail,
});

/**
 * Names the sandbox provides, so they never appear in snapshots or namespace listings.
 *
 * Filled from what is actually installed below rather than restated by hand: the previous
 * literal covered a third of the injected surface, so `fetch`, `Bun`, `$` and every other
 * platform global were listed as the cell's own variables and pushed through every snapshot.
 */
const INJECTED = new Set<string>();

/**
 * Install the harness's own API, refusing replacement.
 *
 * Persistence rewrites a cell's `const rlm = ...` into `globalThis.rlm = ...` (see
 * transform.ts), so an ordinary declaration does not shadow `rlm` for one cell — it replaces
 * the function for the rest of the session, and nothing in the session can put it back. A
 * setter that throws refuses the write in both strict and sloppy mode, and covers every route
 * to it: declaration, bare assignment, destructuring, import alias.
 */
function installHarnessGlobal(name: string, value: unknown): void {
	INJECTED.add(name);
	Object.defineProperty(context, name, {
		configurable: true,
		enumerable: true,
		get: () => value,
		set() {
			throw new Error(
				`\`${name}\` is part of the REPL runtime and cannot be redeclared: top-level declarations persist as globals, so this would replace it for the rest of the session. Rename the variable.`,
			);
		},
	});
}

// Per-execute state.
/** Child process of a running %%bash cell, so an interrupt can stop it. */
let _activeBash: { kill: (signal?: NodeJS.Signals) => boolean } | null = null;
let _execId: string | null = null;
// Kept after the cell settles so a send that resolves late can still be attributed
// to the cell that issued it.
let _lastExecId: string | null = null;
let _displayData: Array<{ mime: string; data: unknown }> = [];
let _diffs: KernelDiffDisplay[] = [];
let _sentAgentMessages: KernelSentAgentMessage[] = [];

function sendStdout(chunk: string): void {
	if (_execId !== null) send({ id: _execId, type: "stdout", chunk });
}
function sendStderr(chunk: string): void {
	if (_execId !== null) send({ id: _execId, type: "stderr", chunk });
}

const util = {
	inspect: (v: unknown) => serializeValue(v),
	format: (...args: unknown[]) => args.map(serializeValue).join(" "),
};

/**
 * Working-directory and environment control for the sandbox. The REPL is a
 * dedicated child process, so `process.chdir` is safe here and keeps JS cells and
 * `%%bash` cells on the same cwd. `env` is the child's real environment, so an
 * assignment carries into every later `%%bash` cell.
 */
function cd(dir: string): string {
	process.chdir(dir);
	return process.cwd();
}

function pwd(): string {
	return process.cwd();
}

/**
 * File IO, synchronous on purpose.
 *
 * A cell is sequential, so nothing is gained by making these async, and sync means
 * `read(p)` and `await read(p)` both yield the string — a forgotten `await` cannot
 * leave a stray Promise where the model expected text. Relative paths resolve
 * against the REPL's cwd, which is what `cd()` moves.
 */
function read(path: string, opts?: { from?: number; to?: number }): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === "ENOENT") throw new Error(`read: no such file: ${path}`);
		if (code === "EISDIR") throw new Error(`read: ${path} is a directory`);
		throw err;
	}
	if (opts?.from === undefined && opts?.to === undefined) return text;
	// 1-based inclusive, the numbering the diff and edit tools print.
	const lines = text.split("\n");
	const from = Math.max(1, opts?.from ?? 1);
	const to = Math.min(lines.length, opts?.to ?? lines.length);
	return lines.slice(from - 1, to).join("\n");
}

function write(path: string, content: string | Uint8Array | ArrayBuffer): { path: string; bytes: number } {
	const target = resolve(path);
	mkdirSync(dirname(target), { recursive: true });
	const data =
		typeof content === "string"
			? Buffer.from(content, "utf8")
			: content instanceof ArrayBuffer
				? new Uint8Array(content)
				: content;
	// Written beside the target, never in a temp dir: rename is only atomic within one
	// filesystem, and a crash mid-write must not leave the target truncated.
	const temp = `${target}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	try {
		writeFileSync(temp, data);
		renameSync(temp, target);
	} catch (err: unknown) {
		try {
			unlinkSync(temp);
		} catch {
			// never created
		}
		throw err;
	}
	return { path: target, bytes: data.byteLength };
}
/**
 * Repository inspection primitives, so repo questions never need a shell grep/find.
 *
 * Both walk with Bun.Glob and read through the filesystem directly: no subprocess and
 * no output the model has to truncate by hand — every knob caps its own work. Skipped
 * directories are the ones a repo-wide grep trips over first here: node_modules,
 * .git, dist.
 */
interface SearchMatch {
	file: string;
	line: number;
	text: string;
}

interface SearchOptions {
	/** Restrict which files are scanned by glob pattern. Defaults to every file. */
	glob?: string;
	cwd?: string;
	maxResults?: number;
	maxCharsPerLine?: number;
	ignore?: "default";
}

interface LsOptions {
	cwd?: string;
	limit?: number;
}

const SEARCH_IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);
const DEFAULT_SEARCH_MAX_RESULTS = 200;
const DEFAULT_SEARCH_MAX_CHARS_PER_LINE = 300;
const DEFAULT_LS_LIMIT = 2000;

/** The slice of Bun.Glob the kernel needs, read structurally because the build has no @types/bun. */
interface GlobScanner {
	scanSync(options?: { cwd?: string; dot?: boolean; onlyFiles?: boolean }): Iterable<string>;
}

function globScanner(pattern: string): GlobScanner {
	const ctor = (bunGlobal as { Glob?: new (pattern: string) => GlobScanner } | undefined)?.Glob;
	if (!ctor) throw new Error("Bun.Glob is unavailable in this runtime");
	return new ctor(pattern);
}

function resolveCwd(cwd?: string): string {
	return cwd === undefined ? process.cwd() : resolve(cwd);
}

function cappedPositiveInt(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

function isSkippedPath(rel: string): boolean {
	return rel.split("/").some((part) => SEARCH_IGNORED_DIRS.has(part));
}

/**
 * Regex search across repository files, grouped per file.
 *
 * `pattern` is a regex source string ('foo.*bar'), not shell-grep syntax. Results stop
 * at maxResults overall, so a broad pattern stays cheap instead of scanning the whole
 * tree before returning.
 */
function search(pattern: string, opts?: SearchOptions): SearchMatch[] {
	if (typeof pattern !== "string" || pattern.length === 0) {
		throw new Error(
			"search: pattern must be a non-empty regex source string, e.g. search('TODO:', { glob: 'src/**/*.ts' })",
		);
	}
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`search: invalid regular expression ${JSON.stringify(pattern)}: ${message}`);
	}
	const cwd = resolveCwd(opts?.cwd);
	const maxResults = cappedPositiveInt(opts?.maxResults, DEFAULT_SEARCH_MAX_RESULTS, "maxResults");
	const maxChars = cappedPositiveInt(opts?.maxCharsPerLine, DEFAULT_SEARCH_MAX_CHARS_PER_LINE, "maxCharsPerLine");
	const scan = globScanner(opts?.glob ?? "**/*");
	// Sorted before scanning: the walk itself is unordered, and a stable, per-file
	// grouped result is what both the model reading it and the cap below assume.
	const files = [...scan.scanSync({ cwd, dot: true, onlyFiles: true })].sort();
	const matches: SearchMatch[] = [];
	for (const rel of files) {
		if (matches.length >= maxResults) break;
		if (isSkippedPath(rel)) continue;
		// Unreadable files (permissions, mid-write races) are skipped, not fatal:
		// one bad file must not take down a repo-wide query.
		let bytes: Buffer;
		try {
			bytes = readFileSync(resolve(cwd, rel));
		} catch {
			continue;
		}
		// grep's heuristic: a NUL byte means binary, and decoding it as text only
		// produces garbage matches on mangled line boundaries.
		if (bytes.subarray(0, 8192).includes(0)) continue;
		const lines = bytes.toString("utf8").split("\n");
		for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
			if (!regex.test(lines[i])) continue;
			const text = lines[i].length > maxChars ? `${lines[i].slice(0, maxChars)}…` : lines[i];
			matches.push({ file: rel, line: i + 1, text });
		}
	}
	return matches;
}

/**
 * File listing through Bun.Glob. Sorted so output is stable across cells.
 * The default-ignored directories are skipped too: '**' that walks node_modules
 * is exactly the listing nobody wanted.
 */
function ls(pattern = "**", opts?: LsOptions): string[] {
	if (typeof pattern !== "string" || pattern.length === 0) {
		throw new Error("ls: pattern must be a non-empty glob, e.g. ls('src/**/*.ts')");
	}
	const cwd = resolveCwd(opts?.cwd);
	const limit = cappedPositiveInt(opts?.limit, DEFAULT_LS_LIMIT, "limit");
	const out: string[] = [];
	for (const rel of globScanner(pattern).scanSync({ cwd, dot: true, onlyFiles: true })) {
		if (isSkippedPath(rel)) continue;
		out.push(rel);
		if (out.length >= limit) break;
	}
	return out.sort();
}

function sandboxConsole() {
	// Strings print bare and everything else through `inspect`, matching what a normal
	// console does. The previous version passed the whole argument list as one value, so
	// `console.log("a", "b")` printed `["a","b"]` instead of `a b`, and an Error printed `{}`.
	const format = (args: unknown[]): string =>
		args.map((a) => (typeof a === "string" ? a : inspect(a, INSPECT_OPTIONS))).join(" ");
	return {
		log: (...args: unknown[]): void => sendStdout(`${format(args)}\n`),
		info: (...args: unknown[]): void => sendStdout(`${format(args)}\n`),
		warn: (...args: unknown[]): void => sendStderr(`${format(args)}\n`),
		error: (...args: unknown[]): void => sendStderr(`${format(args)}\n`),
		debug: (...args: unknown[]): void => sendStderr(`${format(args)}\n`),
		trace: (...args: unknown[]): void => sendStderr(`${format(args)}\n`),
	};
}

/** Normalize a display() payload into { mime, data }. */
function normalizeDisplay(args: unknown[]): Array<{ mime: string; data: unknown }> {
	const first = args[0];
	if (first && typeof first === "object" && !Array.isArray(first)) {
		const o = first as Record<string, unknown>;
		const mime = typeof o.mimeType === "string" ? o.mimeType : typeof o.mime === "string" ? o.mime : "text/plain";
		return [{ mime, data: o.data ?? o.value }];
	}
	if (args.length >= 2 && typeof first === "string") {
		const mime = typeof args[1] === "string" ? args[1] : "text/plain";
		return [{ mime, data: first }];
	}
	if (Array.isArray(first)) {
		return first as Array<{ mime: string; data: unknown }>;
	}
	return [{ mime: "text/plain", data: first }];
}

/** Parse a DIFF_DISPLAY_MIME payload, tolerating malformed input. */
function parseDiffDisplay(data: unknown): KernelDiffDisplay | undefined {
	if (!isRecord(data)) return undefined;
	const { path, old_str: oldStr, new_str: newStr, start_line: startLine } = data;
	if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
	return {
		path,
		oldStr,
		newStr,
		...(typeof startLine === "number" ? { startLine } : {}),
	};
}

function display(...args: unknown[]): void {
	for (const d of normalizeDisplay(args)) {
		if (d.mime === DIFF_DISPLAY_MIME) {
			const diff = parseDiffDisplay(d.data);
			if (diff) _diffs.push(diff);
			continue;
		}
		if (d.mime === AGENT_MESSAGE_DISPLAY_MIME) {
			const sent = isRecord(d.data)
				? receiptToKernelSentAgentMessage(d.data, d.data.receiverRole ?? d.data.receiver_role)
				: undefined;
			if (!sent) continue;
			if (_execId !== null) {
				_sentAgentMessages.push(sent);
			} else if (_lastExecId !== null) {
				// The cell already returned (an un-awaited send): report it separately so
				// the host can still attach it to that cell's tool result.
				send({ id: _lastExecId, type: "lateSentAgentMessage", message: sent });
			}
			continue;
		}
		_displayData.push(d);
	}
}

// Module loading for the sandbox. The vm cannot run static imports, so expose an
// explicit host-side dynamic loader (`__import`) plus native `await import(...)` via
// the `importModuleDynamically` hook wired in runJs (below).
const importModule = async (specifier: string): Promise<unknown> => import(specifier);

// Curated set of globals exposed to the sandbox. The sandbox deliberately does
// not get `process`, so user code cannot kill the REPL child or touch its host.
/**
 * A read-only slice of `process`. The full object is withheld so a cell cannot
 * `exit()` the REPL child or `chdir()` out from under `cd()`/`pwd()`, but the
 * informational fields are what agents actually reach for, and a bare
 * `process is not defined` sent them hunting for a shim. The mutating members
 * throw an explanation rather than being absent, so the failure names its cause.
 */
const sandboxProcess = Object.freeze({
	platform: process.platform,
	arch: process.arch,
	version: process.version,
	versions: Object.freeze({ ...process.versions }),
	pid: process.pid,
	env: process.env,
	cwd: () => process.cwd(),
	uptime: () => process.uptime(),
	memoryUsage: () => process.memoryUsage(),
	hrtime: process.hrtime,
	nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => cb(...args)),
	exit: () => {
		throw new Error(
			"process.exit is unavailable in the REPL: it would kill the persistent kernel. Return a value instead.",
		);
	},
	chdir: () => {
		throw new Error(
			"process.chdir is unavailable in the REPL: use cd('<dir>') so %%bash cells and file paths stay in sync.",
		);
	},
	kill: () => {
		throw new Error("process.kill is unavailable in the REPL. Use Bun.spawn to manage child processes you started.");
	},
});

/**
 * Globals Bun provides that `@types/node` does not declare. Read off globalThis
 * for the same reason `Bun` is: the build must stay dependency-free.
 */
function bunOnlyGlobal(name: string): unknown {
	return (globalThis as Record<string, unknown>)[name];
}

// The Bun runtime object, resolved dynamically so the build needs no @types/bun.
const bunGlobal = (globalThis as { Bun?: unknown }).Bun;

// Platform surface: what Bun would have given the cell anyway. A cell may replace any of it.
Object.assign(context, {
	globalThis: context,
	console: sandboxConsole(),
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	queueMicrotask,
	Buffer,
	URL,
	URLSearchParams,
	TextEncoder,
	TextDecoder,
	atob,
	btoa,
	crypto,
	// The vm context starts empty, so every global the prompt advertises has to be
	// injected explicitly. DEFAULT_RLM_RUNTIME_LABELS promises Bun and native
	// fetch; without these the documented API throws ReferenceError and the model
	// burns turns rediscovering that the prompt was wrong.
	// Read off globalThis rather than the bare identifier: `Bun` has no ambient
	// type without @types/bun, the same tradeoff runBash documents below.
	Bun: bunGlobal,
	// Bun's shell, pre-bound. `import { $ } from "bun"` is the documented idiom but
	// static imports cannot run in this vm, so exposing it as a global removes the
	// trap rather than leaving a syntax error as the only feedback.
	$: (bunGlobal as { $?: unknown } | undefined)?.$,
	fetch,
	Request,
	Response,
	Headers,
	FormData,
	Blob,
	File,
	AbortController,
	AbortSignal,
	structuredClone,
	performance,
	ReadableStream,
	WritableStream,
	TransformStream,
	ByteLengthQueuingStrategy,
	CountQueuingStrategy,
	// Streaming HTML parsing, correct on malformed markup where a regex is not.
	HTMLRewriter: bunOnlyGlobal("HTMLRewriter"),
	CompressionStream,
	DecompressionStream,
	TextEncoderStream,
	TextDecoderStream,
	URLPattern: bunOnlyGlobal("URLPattern"),
	WebSocket,
	Worker: bunOnlyGlobal("Worker"),
	BroadcastChannel,
	MessageChannel,
	MessagePort,
	Event,
	EventTarget,
	CustomEvent,
	DOMException,
	navigator,
	util,
});
for (const name of Object.keys(context)) INJECTED.add(name);

// Harness surface: losing any of it breaks the runtime, so it is installed protected.
for (const [name, value] of Object.entries({
	process: sandboxProcess,
	display,
	cd,
	pwd,
	read,
	write,
	env: process.env,
	__import: importModule,
	__rlm_host_request: hostBridge.hostRequest.bind(hostBridge),
	rlm: rlmObj,
	spawn: rlmObj,
	mcp: mcpObj,
	// Repo inspection without a shell: search()/ls() cover grep/find/ls so the
	// model has no reason to reach for child_process to look around.
	pi: piObj,
	search,
	ls,
})) {
	installHarnessGlobal(name, value);
}
/**
 * Database handles, bound lazily.
 *
 * `Database`, `SQL`, `sql` and `redis` are the names Bun's own documentation uses, so a model
 * reaches for them without an import. They are getters because `bun:sqlite` and the SQL client
 * cost real work to construct, and most cells never touch a database — resolving them eagerly
 * would put that on every REPL start.
 */
for (const [name, resolve] of [
	["Database", () => (require("bun:sqlite") as { Database: unknown }).Database],
	["SQL", () => (bunGlobal as { SQL?: unknown } | undefined)?.SQL],
	["sql", () => (bunGlobal as { sql?: unknown } | undefined)?.sql],
	["redis", () => (bunGlobal as { redis?: unknown } | undefined)?.redis],
	["RedisClient", () => (bunGlobal as { RedisClient?: unknown } | undefined)?.RedisClient],
	["S3Client", () => (bunGlobal as { S3Client?: unknown } | undefined)?.S3Client],
] as const) {
	let cached: unknown;
	let resolved = false;
	Object.defineProperty(context, name, {
		configurable: true,
		enumerable: true,
		get() {
			if (!resolved) {
				try {
					cached = resolve();
				} catch {
					cached = undefined;
				}
				resolved = true;
			}
			return cached;
		},
		// Assignable, so a cell can shadow the name with its own value.
		set(value: unknown) {
			Object.defineProperty(context, name, { configurable: true, enumerable: true, writable: true, value });
		},
	});
	INJECTED.add(name);
}

context.globalThis = context; // keep the context's own globalThis pointing at itself

// ---------------------------------------------------------------------------
// %%bash: route to Bun.spawn.
// ---------------------------------------------------------------------------
async function runBash(req: BunReplExecuteRequest, body: string): Promise<void> {
	const command = bashCommand(body);
	const cmd = req.commandPrefix ? `${req.commandPrefix}\n${command}` : command;
	// `node:child_process` spawn runs under Bun (Bun implements it); using it keeps the
	// build's types green without requiring @types/bun for the Bun.spawn global.
	// Bash output is piped and forwarded as JSON protocol frames so it never corrupts
	// the NDJSON control stream on the child's stdout. Bare %%bash cells run through the
	// configured shell (shellPath) when one is provided.
	const shell = req.shellPath?.trim() || "bash";
	const proc = spawn(shell, ["-c", cmd], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	_activeBash = proc;

	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (d: string) => sendStdout(d));
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d: string) => sendStderr(d));

	let code = -1;
	try {
		code = await new Promise<number>((resolve, reject) => {
			proc.on("error", reject);
			proc.on("close", (c) => resolve(c ?? -1));
		});
	} catch (err: unknown) {
		throw new Error(`%%bash failed to start: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (code !== 0) {
		throw new Error(`%%bash exited with status ${code}`);
	}
}

// ---------------------------------------------------------------------------
// JS cells: transform top-level declarations, wrap in an IIFE for await, run in
// the persistent vm context.
// ---------------------------------------------------------------------------
/** Wrap a cell body into the async IIFE the vm evaluates. */
function wrapCell(body: string): string {
	const { code, lastExpression } = transformTopLevel(body);
	const tail = lastExpression ? `return (${lastExpression});` : "";
	return `
(async () => {
  ${code}
  ${tail}
})()
`;
}

/**
 * Strip TypeScript syntax from a cell body.
 *
 * The tool advertises TypeScript, but `node:vm` only evaluates JavaScript, so a cell
 * containing an annotation used to come back as a bare `SyntaxError`. Bun's transpiler
 * does the stripping. It is applied *only* after plain JS evaluation has failed to
 * compile: the transpiler also drops statements it considers dead (a bare `({a:1})`
 * expression, for one), which would silently change the result of valid JS.
 */
/** Cross-realm-safe check for a parse failure (the vm's `SyntaxError` is not ours). */
function isSyntaxError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "SyntaxError";
}

type TsTranspiler = { transformSync(source: string): string };

function bunTranspiler(): TsTranspiler | null {
	const bun = (globalThis as { Bun?: { Transpiler: new (o: { loader: string }) => TsTranspiler } }).Bun;
	return bun ? new bun.Transpiler({ loader: "ts" }) : null;
}

function stripTypes(body: string): string | null {
	const transpiler = bunTranspiler();
	if (!transpiler) return null;
	try {
		return transpiler.transformSync(body);
	} catch {
		return null;
	}
}

/**
 * Bun's parse diagnostic for a cell `node:vm` refused to compile.
 *
 * The vm reports nearly every parse failure as `Unexpected EOF`, at a line number into the
 * *wrapped* cell — pointing at code the model never wrote, and naming nothing it can fix.
 * Bun's parser names the actual mistake ("Unterminated string literal"), which is worth a
 * second parse on a path that has already failed.
 */
function transpileDiagnostic(body: string): string | null {
	const transpiler = bunTranspiler();
	if (!transpiler) return null;
	try {
		transpiler.transformSync(body);
		return null;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return message.trim() || null;
	}
}

/**
 * Guidance appended to a syntax error raised by a cell that still contains a static
 * import. The engine's own message ("import call expects one or two arguments") reads
 * like a mis-called function and says nothing about the fix, so an agent that hits it
 * retries the same shape instead of switching to the form that works.
 */
const STATIC_IMPORT_HINT =
	'This REPL evaluates cells in a vm where static `import` statements are unavailable; use `await import("module")` instead.';

/**
 * The recurring shape behind an unterminated literal: a long prompt written across lines
 * inside `'...'`. The engine calls that `Unexpected EOF`, which reads like a truncated cell
 * and invites a retry of the same quoting.
 */
const MULTILINE_STRING_HINT =
	"A quoted string cannot span lines. Use a backtick template literal (`...`) for multi-line text such as a subagent prompt, or escape the newlines as \\n.";

/** Append what the engine's own message leaves out, without repeating anything already in it. */
function withSyntaxHints(err: unknown, body: string): unknown {
	if (!isSyntaxError(err)) return err;
	const e = err as { message?: unknown };
	if (typeof e.message !== "string") return err;

	const hints: string[] = [];
	if (hasStaticImport(body)) hints.push(STATIC_IMPORT_HINT);
	const diagnostic = transpileDiagnostic(body);
	if (diagnostic) {
		hints.push(diagnostic);
		if (/unterminated string/i.test(diagnostic)) hints.push(MULTILINE_STRING_HINT);
	}

	let message = e.message;
	for (const hint of hints) {
		if (!message.includes(hint)) message += `\n${hint}`;
	}
	e.message = message;
	return err;
}

async function runJs(req: BunReplExecuteRequest, body: string): Promise<void> {
	// vm `timeout` bounds synchronous execution; a runaway async `await` cannot be
	// aborted in-process, so the host hard-kills this child process instead.
	// `importModuleDynamically` lets cells use `await import('...')` for real module
	// loading; cast keeps it green across the local node:vm typings which omit the hook.
	const evaluate = (source: string): Promise<unknown> =>
		runInContext(source, vmContext, {
			timeout: req.timeout,
			importModuleDynamically: (specifier: string) => import(specifier),
		} as Parameters<typeof runInContext>[2]);

	let value: unknown;
	try {
		value = await evaluate(wrapCell(body));
	} catch (err: unknown) {
		// A parse failure may just be TypeScript syntax. Retrying is safe because a cell
		// that failed to compile ran none of its statements. If the retry also fails to
		// compile it was a genuine JS mistake, so the original error is what surfaces.
		const stripped = isSyntaxError(err) ? stripTypes(body) : null;
		if (stripped === null) throw withSyntaxHints(err, body);
		try {
			value = await evaluate(wrapCell(stripped));
		} catch (retryErr: unknown) {
			throw isSyntaxError(retryErr) ? withSyntaxHints(err, body) : retryErr;
		}
	}
	const resultStr = value !== undefined ? serializeValue(value) : undefined;
	send({
		id: req.id,
		type: "result",
		status: "ok",
		value: resultStr,
		displayData: _displayData.length > 0 ? _displayData : undefined,
		diffs: _diffs.length > 0 ? _diffs : undefined,
		sentAgentMessages: _sentAgentMessages.length > 0 ? _sentAgentMessages : undefined,
	});
}

const TRACEBACK_MAX_LINES = 32;

/**
 * Describe a thrown value as `{name, message, traceback}`.
 *
 * Cell code runs in a separate vm realm, so its `Error` is not the host's `Error` and
 * `instanceof` is always false here — the shape has to be read structurally instead.
 * Frames belonging to this script or to the vm wrapper are dropped: they are the REPL's
 * own plumbing, not the agent's code, and only mislead whoever reads the trace.
 */
function describeError(err: unknown): { name: string; message: string; traceback: string[] } {
	if (typeof err !== "object" || err === null) {
		return { name: "Error", message: String(err), traceback: [] };
	}
	const e = err as { name?: unknown; message?: unknown; stack?: unknown };
	const name = typeof e.name === "string" && e.name ? e.name : "Error";
	const message = typeof e.message === "string" ? e.message : String(err);
	const traceback = typeof e.stack === "string" ? cellFrames(e.stack) : [];
	// `stack` was frozen when the error was constructed, so anything added to the message
	// afterwards — the syntax hints above — is missing from it. The host prints the traceback
	// whenever there is one, so a hint that lives only on the message is never read.
	const traceText = traceback.join("\n");
	for (const line of message.split("\n")) {
		if (line.trim() && !traceText.includes(line)) traceback.push(line);
	}
	return { name, message, traceback };
}

/**
 * Keep the error header and the frames that belong to the cell, dropping the REPL's own
 * plumbing below them (the vm entry point, the stdin pump, node internals) — everything
 * after the last `evalmachine` frame is this script, not the agent's code.
 */
function cellFrames(stack: string): string[] {
	const lines = stack.split("\n");
	const lastCellFrame = lines.reduce((last, line, i) => (line.includes("evalmachine") ? i : last), -1);
	// No cell frame at all means the error came from the REPL itself — a `%%bash` exit status,
	// a refused runtime binding. Every `at ...` line then points into this script, which says
	// nothing about the cell that was run, so the message stands alone.
	const firstFrame = lines.findIndex((line) => /^\s+at\s/.test(line));
	const kept =
		lastCellFrame >= 0 ? lines.slice(0, lastCellFrame + 1) : firstFrame >= 0 ? lines.slice(0, firstFrame) : lines;
	return kept.slice(0, TRACEBACK_MAX_LINES);
}

async function executeCode(req: BunReplExecuteRequest): Promise<void> {
	_execId = req.id;
	_lastExecId = req.id;
	_displayData = [];
	_diffs = [];
	const cell = parseCell(req.code);
	try {
		if (cell.kind === "bash") {
			await runBash(req, cell.body);
			// stdout was streamed already; no standalone result value.
			send({
				id: req.id,
				type: "result",
				status: "ok",
				displayData: _displayData.length > 0 ? _displayData : undefined,
				diffs: _diffs.length > 0 ? _diffs : undefined,
				sentAgentMessages: _sentAgentMessages.length > 0 ? _sentAgentMessages : undefined,
			});
		} else {
			await runJs(req, cell.body);
		}
	} catch (err: unknown) {
		const { name, message, traceback } = describeError(err);
		send({
			id: req.id,
			type: "result",
			status: "error",
			error: message ? `${name}: ${message}` : name,
			errorName: name,
			traceback,
			displayData: _displayData.length > 0 ? _displayData : undefined,
			diffs: _diffs.length > 0 ? _diffs : undefined,
			sentAgentMessages: _sentAgentMessages.length > 0 ? _sentAgentMessages : undefined,
		});
	} finally {
		_activeBash = null;
		_execId = null;
		_displayData = [];
		_diffs = [];
		_sentAgentMessages = [];
		send({ id: req.id, type: "idle" });
	}
}

/**
 * Capture the namespace as JSON.
 *
 * JSON cannot carry functions, classes, or symbols, so those names are recorded in
 * `dropped` rather than quietly vanishing: the agent that defined them needs to be told
 * on the next restore that they are gone and have to be redefined.
 */
/** Ceiling on the whole snapshot, mirroring the old kernel's DEFAULT_SNAPSHOT_MAX_BYTES. */
const SNAPSHOT_MAX_CHARS = 256 * 1024 * 1024;

/**
 * True when a value can actually be carried by the snapshot.
 *
 * The test is an attempted `structuredClone`, which is exactly the algorithm the snapshot
 * writer uses, so nothing can pass here and fail there. It accepts far more than JSON did —
 * Map, Set, Date, RegExp, BigInt, TypedArrays and circular references all survive — and it
 * throws on the things that must never be captured: functions, and host objects such as a live
 * `Bun.serve` handle, a `Timeout`, or the `Bun` namespace itself.
 *
 * That last case was a real failure: host objects stringify to `{}` without throwing, so JSON
 * captured the `Bun` global as an empty object and restoring it wiped `Bun.file`, `Bun.spawn`
 * and `Bun.Glob` for the rest of the session.
 */
function isSnapshotable(value: unknown): boolean {
	if (typeof value === "function" || typeof value === "symbol") return false;
	try {
		structuredClone(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Every global present before user code runs. Captured once at boot so runtime globals — the
 * `Bun` namespace, `fetch`, `Response`, `process`, the stream classes — are excluded from
 * snapshots silently, rather than being reported to the model as variables that failed to
 * restore.
 */
const BUILTIN_KEYS = new Set(Object.keys(context));

function snapshotState(): { payload: string; names: string[]; dropped: string[] } {
	const values: Record<string, unknown> = {};
	/** Function sources, kept apart so restore can re-evaluate rather than assign them. */
	const sources: Record<string, string> = {};
	const names: string[] = [];
	const dropped: string[] = [];
	let total = 0;
	for (const [key, value] of Object.entries(context)) {
		if (key.startsWith("__")) continue;
		if (INJECTED.has(key) || BUILTIN_KEYS.has(key)) continue;
		if (typeof value === "undefined" || typeof value === "symbol") {
			if (typeof value === "symbol") dropped.push(key);
			continue;
		}
		// Functions cannot be cloned, but their source usually can be re-evaluated, which is
		// what saves the helpers the agent defines once and expects to still have next turn.
		if (typeof value === "function") {
			const src = functionSource(value as (...args: never) => unknown);
			if (!src) {
				dropped.push(key);
				continue;
			}
			const cost = src.length;
			if (total + cost > SNAPSHOT_MAX_CHARS) {
				dropped.push(key);
				continue;
			}
			total += cost;
			sources[key] = src;
			names.push(key);
			continue;
		}
		// Live handles and runtime globals are not data. Reported as dropped so the model is
		// told what did not come back rather than finding a hollow object later.
		if (!isSnapshotable(value)) {
			dropped.push(key);
			continue;
		}
		let bytes: number;
		try {
			bytes = serialize(value).byteLength;
		} catch {
			dropped.push(key);
			continue;
		}
		// One runaway variable must not make the whole snapshot unwritable, so the cap is
		// charged per name and the offender is reported rather than the save failing.
		if (total + bytes > SNAPSHOT_MAX_CHARS) {
			dropped.push(key);
			continue;
		}
		total += bytes;
		values[key] = value;
		names.push(key);
	}
	const payload = serialize({ values, sources }).toString("base64");
	return { payload, names, dropped };
}

/**
 * Source text for a function that can be re-evaluated on restore, or null.
 *
 * Native and bound functions stringify to a `[native code]` stub that would re-evaluate into
 * something that throws at call time, so they are refused here and reported as dropped.
 */
function functionSource(fn: (...args: never) => unknown): string | null {
	let src: string;
	try {
		src = Function.prototype.toString.call(fn);
	} catch {
		return null;
	}
	if (src.includes("[native code]")) return null;
	// A method shorthand (`foo() {}`) is not a valid standalone expression; only forms that
	// parse on their own are worth keeping.
	try {
		runInContext(`(${src})`, context, { timeout: 1000 });
	} catch {
		return null;
	}
	return src;
}

/**
 * Rebuild a host-realm value using the sandbox's own intrinsics.
 *
 * The vm context starts empty, so it has its own `Map`, `Date`, `Array` and friends. Anything
 * `deserialize` produces belongs to the host realm instead, which means user code sees an
 * object whose methods all work but which fails `instanceof Map` — the confusing half-broken
 * state. Rebuilding through constructors read out of the vm makes restored values
 * indistinguishable from ones the agent constructs itself.
 *
 * Values of a type not listed here (class instances, ArrayBuffers) pass through untouched:
 * cross-realm is still better than dropped.
 */
interface VmIntrinsics {
	Array: new () => unknown[];
	Map: new () => Map<unknown, unknown>;
	Set: new () => Set<unknown>;
	Date: new (time: number) => Date;
	RegExp: new (source: string, flags: string) => RegExp;
	Error: new (message: string) => Error;
	Object: new () => Record<string, unknown>;
	/** Typed-array and other constructor lookups by name. */
	[name: string]: unknown;
}

function makeReRealmer(): (value: unknown) => unknown {
	const VM = runInContext(
		"({ Object, Array, Map, Set, Date, RegExp, Error, Uint8Array, Int8Array, Uint8ClampedArray," +
			" Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array," +
			" BigInt64Array, BigUint64Array })",
		context,
	) as VmIntrinsics;
	const seen = new WeakMap<object, unknown>();

	const walk = (value: unknown): unknown => {
		if (value === null || typeof value !== "object") return value;
		const existing = seen.get(value);
		// Preserves shared references and stops cycles from recursing forever.
		if (existing !== undefined) return existing;

		if (Array.isArray(value)) {
			const out: unknown[] = new VM.Array();
			seen.set(value, out);
			for (const item of value) out.push(walk(item));
			return out;
		}
		if (value instanceof Map) {
			const out = new VM.Map();
			seen.set(value, out);
			for (const [k, v] of value) out.set(walk(k), walk(v));
			return out;
		}
		if (value instanceof Set) {
			const out = new VM.Set();
			seen.set(value, out);
			for (const item of value) out.add(walk(item));
			return out;
		}
		if (value instanceof Date) return new VM.Date(value.getTime());
		if (value instanceof RegExp) return new VM.RegExp(value.source, value.flags);
		if (ArrayBuffer.isView(value)) {
			const Ctor: unknown = VM[value.constructor.name];
			if (typeof Ctor === "function") {
				return new (Ctor as new (value: unknown) => object)(value);
			}
			return value;
		}
		if (value instanceof Error) {
			const out = new VM.Error(value.message);
			out.name = value.name;
			out.stack = value.stack;
			return out;
		}
		// Plain object, or a class instance whose prototype the clone already flattened away.
		if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
			const out: Record<string, unknown> = new VM.Object();
			seen.set(value, out);
			for (const [k, v] of Object.entries(value)) out[k] = walk(v);
			return out;
		}
		return value;
	};
	return walk;
}

function restoreState(input: { dataB64?: string; data?: Record<string, unknown> }): {
	restored: string[];
	failed: string[];
} {
	const restored: string[] = [];
	const failed: string[] = [];
	let values: Record<string, unknown> = {};
	let sources: Record<string, string> = {};
	if (input.dataB64) {
		const decoded = deserialize(Buffer.from(input.dataB64, "base64")) as {
			values?: Record<string, unknown>;
			sources?: Record<string, string>;
		};
		values = decoded.values ?? {};
		sources = decoded.sources ?? {};
	} else if (input.data) {
		// Snapshot written before the structured-clone format: plain JSON, no functions.
		values = input.data;
	}
	const reRealm = makeReRealmer();
	const assign = (key: string, value: unknown): void => {
		// An injected name is host-owned; overwriting it would replace a live helper
		// (`display`, `rlm`, …) with dead snapshot data.
		if (INJECTED.has(key)) {
			failed.push(key);
			return;
		}
		try {
			context[key] = reRealm(value);
			restored.push(key);
		} catch {
			// A frozen/getter-only global on the context can reject assignment.
			failed.push(key);
		}
	};
	for (const [key, value] of Object.entries(values)) assign(key, value);
	for (const [key, src] of Object.entries(sources)) {
		if (INJECTED.has(key)) {
			failed.push(key);
			continue;
		}
		try {
			assign(key, runInContext(`(${src})`, context, { timeout: 5000 }));
		} catch {
			// The source was re-evaluable when captured but is not now — a closure over a name
			// this session never defined, most often.
			failed.push(key);
		}
	}
	return { restored, failed };
}

/** Names the agent itself has defined, excluding host-injected helpers and internals. */
function listNames(): string[] {
	return Object.keys(context).filter((k) => !k.startsWith("__") && !INJECTED.has(k));
}
/**
 * Type badge per defined name, for user-facing variable listings.
 *
 * `typeof` crosses realms safely; for objects the constructor name is more useful than a
 * bare `object` (`map`, `date`, a class instance's own class). A throwing getter degrades
 * to `unknown` instead of failing the listing.
 */
function nameTypes(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of listNames()) {
		let value: unknown;
		try {
			value = context[name];
		} catch {
			out[name] = "unknown";
			continue;
		}
		if (value === null) {
			out[name] = "null";
			continue;
		}
		if (Array.isArray(value)) {
			out[name] = "array";
			continue;
		}
		const base = typeof value;
		if (base === "object") {
			const ctor = (value as object).constructor?.name;
			out[name] = ctor && ctor !== "Object" ? ctor.toLowerCase() : "object";
			continue;
		}
		out[name] = base;
	}
	return out;
}

/** `Object.prototype.toString`'s output: the absence of a render, not a render. */
const DEFAULT_OBJECT_TEXT = /^\[object [A-Za-z]+\]$/;

/**
 * Render a namespace value as the text an answer will carry.
 *
 * `toString` is the contract, because it is already what the artifacts render through: a
 * `df` frame prints its box table and every `chart` call returns a string. Object's and
 * Array's inherited `toString` are excluded on purpose -- `[object Object]` and `1,2,3`
 * are not renders, they are the absence of one, and pasting either into a user's answer
 * is the mistake this whole path exists to remove.
 */
function renderForInjection(value: unknown): { text: string } | { error: string } {
	if (value === undefined) return { error: "is declared but holds no value yet" };
	if (value === null) return { error: "is null" };
	const kind = typeof value;
	if (kind === "function") return { error: "is a function; call it and reference the result" };
	if (kind === "symbol") return { error: "is a symbol and has no text form" };
	if (kind === "string") return { text: value as string };
	if (kind === "number" || kind === "boolean" || kind === "bigint") return { text: String(value) };
	try {
		// Identity checks against Object.prototype.toString would miss here: cell values live in
		// the vm realm and carry its prototypes, not this module's. The default renders are
		// recognised by their output instead, which crosses realms for free.
		const rendered = Array.isArray(value) ? "" : String(value);
		if (rendered !== "" && !DEFAULT_OBJECT_TEXT.test(rendered)) return { text: rendered };
		const json = JSON.stringify(value, null, 2);
		if (typeof json !== "string") return { error: "has no text form" };
		return { text: json };
	} catch (err: unknown) {
		return { error: `could not be rendered: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/**
 * Resolve names for response injection.
 *
 * Addressable set is exactly `listNames()`: what the agent itself defined. Host helpers
 * and skill bindings are excluded so a reference can never dump an internal or a preloaded
 * function into a transcript.
 */
function resolveRefs(names: string[], maxChars: number): BunReplResolvedRef[] {
	const defined = new Set(listNames());
	return names.map((name): BunReplResolvedRef => {
		if (!defined.has(name)) return { name, error: "is not a variable you defined in the REPL" };
		let rendered: { text: string } | { error: string };
		try {
			rendered = renderForInjection(context[name]);
		} catch (err: unknown) {
			// Reading the name can run a getter, and a throwing getter must not take the answer with it.
			rendered = { error: `threw while being read: ${err instanceof Error ? err.message : String(err)}` };
		}
		if ("error" in rendered) return { name, error: rendered.error };
		const { text } = rendered;
		if (text.trim() === "") return { name, error: "rendered as empty text" };
		if (text.length > maxChars) {
			return { name, error: `rendered ${text.length} chars, over the ${maxChars}-char injection limit` };
		}
		return { name, text };
	});
}

// ---------------------------------------------------------------------------
// stdin protocol pump.
// ---------------------------------------------------------------------------
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let msg: BunReplHostToRepl;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			continue;
		}

		switch (msg.type) {
			case "execute":
				void executeCode(msg);
				break;
			// Without this, an interrupt fell through to `default` and did nothing: the host's
			// only remaining lever was a hard kill, which destroys the whole namespace. Cancel
			// what can be cancelled and let the cell settle as aborted instead.
			case "interrupt": {
				const bash = _activeBash;
				if (bash) {
					try {
						bash.kill("SIGINT");
					} catch {
						// already exited
					}
				}
				for (const [requestId, pending] of pendingHostRequests) {
					pendingHostRequests.delete(requestId);
					pending.reject(new Error("interrupted"));
				}
				break;
			}
			case "shutdown":
				send({ id: msg.id, type: "result", status: "ok", value: '"shutdown"' });
				send({ id: msg.id, type: "idle" });
				process.exit(0);
				break;
			case "snapshot": {
				try {
					const { payload, names, dropped } = snapshotState();
					send({ id: msg.id, type: "snapshotResult", status: "ok", dataB64: payload, names, dropped });
				} catch (err: unknown) {
					send({
						id: msg.id,
						type: "snapshotResult",
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
				break;
			}
			case "restore": {
				try {
					const { restored, failed } = restoreState({ dataB64: msg.dataB64, data: msg.data });
					send({ id: msg.id, type: "restoreResult", status: "ok", restoredNames: restored, failed });
				} catch (err: unknown) {
					send({
						id: msg.id,
						type: "restoreResult",
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
				break;
			}
			case "listNames": {
				send({ id: msg.id, type: "listNamesResult", names: listNames(), types: nameTypes() });
				break;
			}
			case "clearNamespace": {
				try {
					// Deletion must run inside the vm: removing a key from the host-side sandbox
					// object does not remove it from the contextified global, so a host-side
					// `delete` would empty the listing while every value stayed reachable.
					const names = listNames();
					if (names.length > 0) {
						const source = names.map((key) => `delete globalThis[${JSON.stringify(key)}];`).join("");
						runInContext(source, context, { timeout: 5000 });
					}
					const cleared = names.length;
					send({ id: msg.id, type: "clearNamespaceResult", status: "ok", cleared });
				} catch (err: unknown) {
					send({
						id: msg.id,
						type: "clearNamespaceResult",
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
				break;
			}
			case "resolveRefs": {
				send({ id: msg.id, type: "resolveRefsResult", refs: resolveRefs(msg.names, msg.maxChars) });
				break;
			}
			case "hostResponse": {
				const pending = pendingHostRequests.get(msg.requestId);
				if (pending) {
					pendingHostRequests.delete(msg.requestId);
					if (msg.status === "ok") {
						pending.resolve(msg.data);
					} else {
						pending.reject(new Error(msg.error ?? "Host request failed"));
					}
				}
				break;
			}
			default:
				break;
		}
	}
});

process.stdin.on("end", () => {
	process.exit(0);
});

/**
 * Preloaded skills. The host passes `OPTIMUS_REPL_SKILLS` as JSON
 * `[{ name, global, entry }]`; each entry is an ESM module that default-exports
 * (or exports `createSkill`) a factory taking the skill context and returning the
 * object bound into the sandbox under `global`. A module without a factory is
 * bound as its own namespace. Failures are reported on stderr and skipped so one
 * broken skill cannot stop the REPL from booting.
 */
interface PreloadedSkillSpec {
	name: string;
	global: string;
	entry: string;
}

const skillContext = {
	hostRequest: hostBridge.hostRequest.bind(hostBridge),
	display,
	get cwd(): string {
		return process.cwd();
	},
	env: process.env,
};

async function loadPreloadedSkills(): Promise<void> {
	const raw = process.env.OPTIMUS_REPL_SKILLS;
	if (!raw) return;
	let specs: PreloadedSkillSpec[];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;
		specs = parsed as PreloadedSkillSpec[];
	} catch {
		return;
	}
	for (const spec of specs) {
		if (!spec?.global || !spec?.entry) continue;
		try {
			const mod = (await import(spec.entry)) as Record<string, unknown>;
			const factory = typeof mod.createSkill === "function" ? mod.createSkill : mod.default;
			const api = typeof factory === "function" ? await (factory as (ctx: unknown) => unknown)(skillContext) : mod;
			installHarnessGlobal(spec.global, api);
		} catch (err: unknown) {
			process.stderr.write(
				`optimus: skill "${spec.name}" failed to load: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
}

await loadPreloadedSkills();

const readyMsg: BunReplReplToHost = { id: "ready", type: "idle" };
send(readyMsg);
