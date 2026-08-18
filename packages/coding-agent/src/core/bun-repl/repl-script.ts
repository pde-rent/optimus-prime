import { spawn } from "node:child_process";
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
import { transformTopLevel } from "./transform.js";

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
	try {
		const seen = new WeakSet();
		return JSON.stringify(value, (_key, val) => {
			if (typeof val === "object" && val !== null) {
				if (seen.has(val)) return "[Circular]";
				seen.add(val);
			}
			if (typeof val === "function") return undefined;
			if (typeof val === "bigint") return `${val.toString()}n`;
			return val;
		});
	} catch {
		return String(value);
	}
}

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

const util = { inspect: (v: unknown) => serializeValue(v) };

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
	const format = (...args: unknown[]): string =>
		args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" ");
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
async function runJs(req: BunReplExecuteRequest, body: string): Promise<void> {
	const { code, lastExpression } = transformTopLevel(body);
	const tail = lastExpression ? `return (${lastExpression});` : "";
	const wrappedCode = `
(async () => {
  ${code}
  ${tail}
})()
`;

	// vm `timeout` bounds synchronous execution; a runaway async `await` cannot be
	// aborted in-process, so the host hard-kills this child process instead.
	// `importModuleDynamically` lets cells use `await import('...')` for real module
	// loading; cast keeps it green across the local node:vm typings which omit the hook.
	const value = await runInContext(wrappedCode, vmContext, {
		timeout: req.timeout,
		importModuleDynamically: (specifier: string) => import(specifier),
	} as Parameters<typeof runInContext>[2]);
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
		const errorMsg = err instanceof Error ? err.message : String(err);
		send({
			id: req.id,
			type: "result",
			status: "error",
			error: errorMsg,
			displayData: _displayData.length > 0 ? _displayData : undefined,
			diffs: _diffs.length > 0 ? _diffs : undefined,
			sentAgentMessages: _sentAgentMessages.length > 0 ? _sentAgentMessages : undefined,
		});
	} finally {
		_execId = null;
		_displayData = [];
		_diffs = [];
		_sentAgentMessages = [];
		send({ id: req.id, type: "idle" });
	}
}

function snapshotState(): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(context)) {
		if (key.startsWith("__")) continue;
		if (INJECTED.has(key)) continue;
		if (typeof value === "function") continue;
		if (typeof value === "symbol") continue;
		if (typeof value === "undefined") continue;
		result[key] = jsonSafe(value);
	}
	return result;
}

function restoreState(data: Record<string, unknown>): string[] {
	const restored: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (INJECTED.has(key)) continue;
		context[key] = value;
		restored.push(key);
	}
	return restored;
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
			case "shutdown":
				send({ id: msg.id, type: "result", status: "ok", value: '"shutdown"' });
				send({ id: msg.id, type: "idle" });
				process.exit(0);
				break;
			case "snapshot": {
				try {
					const data = snapshotState();
					send({ id: msg.id, type: "snapshotResult", status: "ok", data });
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
					const names = restoreState(msg.data);
					send({ id: msg.id, type: "restoreResult", status: "ok", restoredNames: names });
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
