import { spawn } from "node:child_process";
import { inspect } from "node:util";
import { createContext, runInContext } from "node:vm";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	DIFF_DISPLAY_MIME,
	type KernelDiffDisplay,
	type KernelSentAgentMessage,
} from "../tools/kernel-types.js";
import { bashCommand, parseCell } from "./cell.js";
import type {
	BunReplExecuteRequest,
	BunReplHostRequest,
	BunReplHostResponse,
	BunReplHostToRepl,
	BunReplReplToHost,
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
	// `inspect` is the JS analogue of Python's `repr` the old kernel returned: it renders
	// Map/Set/Error/class instances faithfully, where JSON.stringify flattens them to `{}`.
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

function jsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function" || typeof value === "symbol") return String(value);
	try {
		const seen = new WeakSet();
		return JSON.parse(
			JSON.stringify(value, (_key, val) => {
				if (typeof val === "object" && val !== null) {
					if (seen.has(val)) return "[Circular]";
					seen.add(val);
				}
				if (typeof val === "function") return undefined;
				if (typeof val === "bigint") return val.toString();
				return val;
			}),
		);
	} catch {
		return String(value);
	}
}

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
	overview: (options?: HarnessOptions) => harnessRequest("harness.overview", options),
};

/**
 * `rlm` is documented to the model as a callable (`await rlm('sub-task')`) that also
 * carries the registry and harness helpers, so the injected binding is the spawn
 * function with those members assigned onto it.
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
	find_models: (query: string) => hostBridge.hostRequest("rlm.find_models", { query }),
	list_subagents: () => hostBridge.hostRequest("rlm.list_subagents", {}),
	delete_subagent: (target: string) => hostBridge.hostRequest("rlm.delete_subagent", { target }),
	host_request: (type: string, payload: Record<string, unknown>) => hostBridge.hostRequest(type, payload),
});

// Names injected into the sandbox that must never appear in snapshots/namespace listings.
const INJECTED = new Set([
	"globalThis",
	"console",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"queueMicrotask",
	"Buffer",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"atob",
	"btoa",
	"crypto",
	"display",
	"sys",
	"util",
	"cd",
	"pwd",
	"env",
	"__import",
	"__rlm_host_request",
	"rlm",
]);

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
// The Bun runtime object, resolved dynamically so the build needs no @types/bun.
const bunGlobal = (globalThis as { Bun?: unknown }).Bun;

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
	display,
	sys: { display },
	util,
	cd,
	pwd,
	env: process.env,
	__import: importModule,
	__rlm_host_request: hostBridge.hostRequest.bind(hostBridge),
	rlm: rlmObj,
});
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
	// configured shell (shellPath) when one is provided, mirroring the old ipython option.
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

function stripTypes(body: string): string | null {
	const transpiler = (
		globalThis as { Bun?: { Transpiler: new (o: { loader: string }) => { transformSync(s: string): string } } }
	).Bun;
	if (!transpiler) return null;
	try {
		return new transpiler.Transpiler({ loader: "ts" }).transformSync(body);
	} catch {
		return null;
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

function withStaticImportHint(err: unknown, body: string): unknown {
	if (!isSyntaxError(err) || !hasStaticImport(body)) return err;
	const e = err as { message?: unknown };
	if (typeof e.message === "string" && !e.message.includes(STATIC_IMPORT_HINT)) {
		e.message = `${e.message}\n${STATIC_IMPORT_HINT}`;
	}
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
		if (stripped === null) throw withStaticImportHint(err, body);
		try {
			value = await evaluate(wrapCell(stripped));
		} catch (retryErr: unknown) {
			throw isSyntaxError(retryErr) ? withStaticImportHint(err, body) : retryErr;
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
	return { name, message, traceback: typeof e.stack === "string" ? cellFrames(e.stack) : [] };
}

/**
 * Keep the error header and the frames that belong to the cell, dropping the REPL's own
 * plumbing below them (the vm entry point, the stdin pump, node internals) — everything
 * after the last `evalmachine` frame is this script, not the agent's code.
 */
function cellFrames(stack: string): string[] {
	const lines = stack.split("\n");
	const lastCellFrame = lines.reduce((last, line, i) => (line.includes("evalmachine") ? i : last), -1);
	const kept = lastCellFrame >= 0 ? lines.slice(0, lastCellFrame + 1) : lines;
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

function snapshotState(): { data: Record<string, unknown>; dropped: string[] } {
	const data: Record<string, unknown> = {};
	const dropped: string[] = [];
	let total = 0;
	for (const [key, value] of Object.entries(context)) {
		if (key.startsWith("__")) continue;
		if (INJECTED.has(key)) continue;
		if (typeof value === "function" || typeof value === "symbol") {
			dropped.push(key);
			continue;
		}
		if (typeof value === "undefined") continue;
		const safe = jsonSafe(value);
		// `jsonSafe` falls back to `String(value)` when a value cannot be serialized; a
		// non-string original that came back as a string did not survive intact.
		if (typeof safe === "string" && typeof value !== "string") {
			dropped.push(key);
			continue;
		}
		// One runaway variable must not make the whole snapshot unwritable, so the cap is
		// charged per name and the offender is reported rather than the save failing.
		const size = JSON.stringify(safe)?.length ?? 0;
		if (total + size > SNAPSHOT_MAX_CHARS) {
			dropped.push(key);
			continue;
		}
		total += size;
		data[key] = safe;
	}
	return { data, dropped };
}

function restoreState(data: Record<string, unknown>): { restored: string[]; failed: string[] } {
	const restored: string[] = [];
	const failed: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		// An injected name is host-owned; overwriting it would replace a live helper
		// (`display`, `rlm`, …) with dead snapshot data.
		if (INJECTED.has(key)) {
			failed.push(key);
			continue;
		}
		try {
			context[key] = value;
			restored.push(key);
		} catch {
			// A frozen/getter-only global on the context can reject assignment.
			failed.push(key);
		}
	}
	return { restored, failed };
}

function listNames(): string[] {
	return Object.keys(context).filter((k) => !k.startsWith("__") && !INJECTED.has(k));
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
					const { data, dropped } = snapshotState();
					send({ id: msg.id, type: "snapshotResult", status: "ok", data, dropped });
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
					const { restored, failed } = restoreState(msg.data);
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
				send({ id: msg.id, type: "listNamesResult", names: listNames() });
				break;
			}
			case "hostResponse": {
				const resp = msg as unknown as BunReplHostResponse;
				const pending = pendingHostRequests.get(resp.requestId);
				if (pending) {
					pendingHostRequests.delete(resp.requestId);
					if (resp.status === "ok") {
						pending.resolve(resp.data);
					} else {
						pending.reject(new Error(resp.error ?? "Host request failed"));
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
 * Preloaded skills. The host passes `PRIME_AGENT_REPL_SKILLS` as JSON
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
	const raw = process.env.PRIME_AGENT_REPL_SKILLS;
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
			context[spec.global] = api;
			INJECTED.add(spec.global);
		} catch (err: unknown) {
			process.stderr.write(
				`prime-agent: skill "${spec.name}" failed to load: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
}

await loadPreloadedSkills();

const readyMsg: BunReplReplToHost = { id: "ready", type: "idle" };
send(readyMsg);
