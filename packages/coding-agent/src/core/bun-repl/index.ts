import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordOrphanProcessState } from "../orphan-process-journal.js";
import type { KernelAttachment, KernelDiffDisplay, KernelSentAgentMessage } from "../tools/repl-types.js";
import type {
	BunReplExecuteRequest,
	BunReplHostRequest,
	BunReplHostResponse,
	BunReplHostToRepl,
	BunReplLateSentAgentMessage,
	BunReplListNamesResult,
	BunReplReplToHost,
	BunReplResolvedRef,
	BunReplResolveRefsResult,
	BunReplRestoreResult,
	BunReplResult,
	BunReplSnapshotResult,
} from "./protocol.js";
import { loadSnapshot, saveSnapshot } from "./state-snapshot.js";

/** Rolling tail kept from the child's stderr, matching the old kernel's diagnostic tail. */
const CHILD_STDERR_TAIL_CHARS = 4096;

/** Cap on the final snapshot taken during dispose. */
const SNAPSHOT_DISPOSE_TIMEOUT_MS = 5000;

/**
 * Ceiling on how long the child may take to announce `ready`.
 *
 * A kernel that never announces itself used to wedge the session forever: the tool awaits
 * `start()`, `start()` awaits a promise nothing settles, and no cell ever returns. Any
 * startup failure has to surface as an error the model can read and retry past.
 */
const STARTUP_TIMEOUT_MS = 60_000;

/** Grace for the child's `idle` frame once its `result` is already in hand. */
const IDLE_SETTLE_TIMEOUT_MS = 5000;

/** Per-stream capture cap, matching the old kernel's DEFAULT_MAX_OUTPUT_CHARS. */
export const DEFAULT_MAX_OUTPUT_CHARS = 65536;

/**
 * Ceiling on a single `display()` attachment's base64 payload.
 *
 * The `attach-image` skill compresses well below this, but any cell can call `display()`
 * directly; without a boundary cap one call can push tens of megabytes through the tool
 * result and into the transcript.
 */
export const MAX_ATTACHMENT_DATA_CHARS = 10_000_000;

// ---------------------------------------------------------------------------
// Response injection: a finished answer references REPL values by name instead
// of the model retyping them. See scanInjectionRefs for the syntax rule.
// ---------------------------------------------------------------------------

/**
 * Ceiling on one injected value.
 *
 * A few hundred `df` rows render near 20k chars and a terminal chart near 2k, so this
 * clears the artifacts anyone actually injects while keeping a mistaken reference to a
 * multi-megabyte buffer out of a transcript that is permanent and replayed every turn.
 */
export const MAX_INJECTED_REF_CHARS = 32_768;

/** The same ceiling applied to a whole message, so ten references cannot do what one may not. */
export const MAX_INJECTED_MESSAGE_CHARS = 65_536;

/**
 * The `repl:` namespace is load-bearing. Bare `{{name}}` is what a model writes when it
 * explains Handlebars, Vue or Jinja, and it is already the placeholder form this repo uses
 * for slash-command templates; the prefix costs five characters and makes a collision with
 * text the model meant literally essentially impossible.
 *
 * The capture is deliberately looser than the names that resolve: `{{repl:rows[0].table}}`
 * has to be caught and explained, not left in the user's answer as raw syntax because it
 * failed to match.
 */
// The capture is greedy and untrimmed on purpose. A lazy `[^}\n]*?` followed by `\s*`
// overlaps it on whitespace, and with no closing braces the two backtrack against each other
// cubically — 2000 spaces measured at 416ms, blocking the event loop before any timeout can
// apply. Every quantifier is bounded, so the work per start position is constant: an
// identifier is short, and an unbounded run of whitespace or text is not a reference.
const INJECT_REF_SOURCE = "\\{\\{repl[ \\t]{0,8}:[ \\t]{0,8}([^}\\n]{0,128})\\}\\}";
const INJECT_REF_ALONE_ON_LINE = new RegExp(`^${INJECT_REF_SOURCE}$`);
const FENCE_MARKER = /^(`{3,}|~{3,})/;
const PLAIN_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Names the kernel can be asked for; everything else fails with its reason stated. */
export function isPlainInjectionName(name: string): boolean {
	return PLAIN_NAME.test(name);
}

export interface InjectionRefSite {
	name: string;
	start: number;
	end: number;
}

export interface InjectionExpansion {
	text: string;
	injected: string[];
	failed: Array<{ name: string; reason: string }>;
	/** Chars of the per-message budget still unspent, so a multi-block message shares one. */
	remainingBudget: number;
}

/** Backtick-delimited spans on one line. A reference inside one was meant literally. */
function inlineCodeSpans(line: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		const openStart = i;
		while (line[i] === "`") i++;
		const runLength = i - openStart;
		let j = i;
		let closed = false;
		while (j < line.length) {
			if (line[j] !== "`") {
				j++;
				continue;
			}
			const closeStart = j;
			while (line[j] === "`") j++;
			if (j - closeStart === runLength) {
				spans.push([openStart, j]);
				closed = true;
				break;
			}
		}
		// An unterminated run is literal backticks, so resume just past it rather than skipping the rest.
		i = closed ? j : openStart + runLength;
	}
	return spans;
}

/**
 * Locate the references a message wants substituted.
 *
 * Two pressures pull opposite ways. Code a model quotes has to survive verbatim, including
 * a sample that mentions this very syntax. But a terminal chart or a box table has to sit
 * inside a fence or the markdown renderer reflows it into ruin -- and that is the entire
 * use case, so blanket fence protection would kill the feature it was meant to protect.
 *
 * The split: inside a fence a reference is substituted only when it is the whole line, and
 * never inside an inline code span. A fenced sample that mentions the syntax within code
 * (`const t = "{{repl:x}}"`) is untouched; a fence holding just the reference renders the
 * artifact as a code block. Indented (four-space) code blocks are not tracked: they are
 * vanishingly rare in model prose next to fences, and treating indentation as protection
 * would silently break a reference the model indented under a list item.
 */
export function scanInjectionRefs(text: string): InjectionRefSite[] {
	if (!text.includes("{{repl")) return [];
	const pattern = new RegExp(INJECT_REF_SOURCE, "g");
	const sites: InjectionRefSite[] = [];
	let offset = 0;
	let fence: { char: string; length: number } | null = null;

	for (const line of text.split("\n")) {
		const lineStart = offset;
		offset += line.length + 1;
		const trimmed = line.trim();

		const marker = FENCE_MARKER.exec(trimmed)?.[1];
		if (marker) {
			if (!fence) {
				fence = { char: marker[0], length: marker.length };
			} else if (marker[0] === fence.char && marker.length >= fence.length && trimmed.length === marker.length) {
				fence = null;
			}
			continue;
		}

		if (fence) {
			const alone = INJECT_REF_ALONE_ON_LINE.exec(trimmed);
			if (alone) {
				const start = lineStart + line.indexOf(trimmed);
				sites.push({ name: alone[1].trim(), start, end: start + trimmed.length });
			}
			continue;
		}

		const spans = inlineCodeSpans(line);
		pattern.lastIndex = 0;
		for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
			const start = m.index;
			const end = start + m[0].length;
			if (spans.some(([from, to]) => start >= from && end <= to)) continue;
			sites.push({ name: m[1].trim(), start: lineStart + start, end: lineStart + end });
		}
	}
	return sites;
}

/** What the user reads in place of a reference that could not be resolved. */
export function injectionFailureMarker(name: string, reason: string): string {
	return `[repl:${name} unavailable: ${reason}]`;
}

/**
 * Splice resolved values into the text.
 *
 * An unresolvable reference becomes a visible marker rather than vanishing or being left
 * as raw syntax: the user has to see that something was meant to be there and why it is not.
 */
export function expandInjectionRefs(
	text: string,
	sites: readonly InjectionRefSite[],
	resolved: ReadonlyMap<string, BunReplResolvedRef>,
	budget: number = MAX_INJECTED_MESSAGE_CHARS,
): InjectionExpansion {
	const injected: string[] = [];
	const failed: Array<{ name: string; reason: string }> = [];
	let out = "";
	let cursor = 0;
	let remainingBudget = budget;

	for (const site of sites) {
		out += text.slice(cursor, site.start);
		cursor = site.end;
		const ref = resolved.get(site.name);
		const value = ref?.text;
		let reason: string | undefined;
		if (!isPlainInjectionName(site.name)) {
			reason = "is not a plain variable name; assign the value to one and reference that";
		} else if (value === undefined) {
			reason = ref?.error ?? "was not resolved";
		} else if (value.length > remainingBudget) {
			reason = `is ${value.length} chars, over the ${remainingBudget} left in this message's injection budget`;
		}
		if (reason !== undefined) {
			failed.push({ name: site.name, reason });
			out += injectionFailureMarker(site.name, reason);
			continue;
		}
		remainingBudget -= (value as string).length;
		injected.push(site.name);
		out += value;
	}
	out += text.slice(cursor);
	return { text: out, injected, failed, remainingBudget };
}

export interface BunReplExecuteOptions {
	signal?: AbortSignal;
	timeout?: number;
	/**
	 * Caller-side id for this cell (the tool call id). Retained after the cell
	 * settles so an agent message sent from an un-awaited promise can still be
	 * attributed to the right tool result via `onLateSentAgentMessage`.
	 */
	correlationId?: string;
	/** Live output callback, fired per chunk as the cell runs (never truncated). */
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Per-stream capture cap; the returned buffers are truncated to this. */
	maxOutputChars?: number;
	/** Marks a host-issued cell (snapshot/restore/listNames) so it is not attributed to the agent. */
	internal?: boolean;
}

export interface BunReplExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	/** Media emitted via the sandbox `display()` helper, converted for the attachment pipeline. */
	attachments?: KernelAttachment[];
	/** File edits emitted via `display()`, in order, for inline diff rendering. */
	diffs?: KernelDiffDisplay[];
	/** Agent-family messages sent from within this cell, surfaced on the host tool result. */
	sentAgentMessages?: KernelSentAgentMessage[];
	status: "ok" | "error" | "aborted";
	/** True when this result came after the REPL child was hard-killed and respawned. */
	kernelRestarted?: boolean;
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

/** Convert REPL display data into kernel-shaped attachments (base64-encoded). */
function displayDataToAttachments(displayData: Array<{ mime: string; data: unknown }> | undefined): KernelAttachment[] {
	if (!displayData) return [];
	const attachments: KernelAttachment[] = [];
	for (const d of displayData) {
		const data = typeof d.data === "string" ? d.data : d.data instanceof Uint8Array ? toBase64(d.data) : null;
		if (data) attachments.push({ mimeType: d.mime, data });
	}
	return attachments;
}

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return Buffer.from(bin, "binary").toString("base64");
}

/** The old kernel's truncation marker, kept verbatim so the model reads a familiar signal. */
function truncationMarker(maxChars: number): string {
	return `\n[... output truncated at ${maxChars} chars ...]`;
}

function truncateResult(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined || value.length <= maxChars) return value;
	return value.slice(0, maxChars) + truncationMarker(maxChars);
}

/** Drop attachments whose base64 payload exceeds the ceiling, reporting that it happened. */
function capAttachments(attachments: KernelAttachment[]): { attachments: KernelAttachment[]; oversized: boolean } {
	const kept = attachments.filter((a) => a.data.length <= MAX_ATTACHMENT_DATA_CHARS);
	return { attachments: kept, oversized: kept.length !== attachments.length };
}

export type BunReplHostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface BunReplManagerOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: Record<string, BunReplHostRequestHandler>;
	snapshotDir?: string;
	bunPath?: string;
	/** Custom shell binary for bare %%bash cells (defaults to "bash"). */
	shellPath?: string;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Called when a cell's agent message arrives after that cell's result. */
	onLateSentAgentMessage?: (correlationId: string, message: KernelSentAgentMessage) => void;
	/** Default per-cell execution timeout in ms; overridable per call via execute opts.timeout. */
	defaultTimeoutMs?: number;
	/** Called when a queued cell begins executing. Used by the provisioner to hold off idle reaping. */
	onCellStart?: () => void;
	/** Called when a queued cell settles (ok, error, abort, or runaway), after the caller's promise chain settles. */
	onCellEnd?: () => void;
}

type ReplState = "idle" | "starting" | "running" | "shutdown";

/**
 * Every live REPL, so a process exit cannot strand its children.
 *
 * The REPL runs in a separate `bun` process that does not die with its parent. Without
 * this, any exit path that skips `dispose()` — a crash, an uncaught error — leaves a bun
 * process holding the session's namespace open indefinitely. Only the synchronous `exit`
 * hook is installed: intercepting SIGINT/SIGTERM here would change how the whole app
 * shuts down, which is not this module's call to make.
 */
const liveManagers = new Set<BunReplManager>();
let exitHookInstalled = false;

function trackLiveManager(manager: BunReplManager): void {
	liveManagers.add(manager);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const m of liveManagers) m.disposeSync();
	});
}

interface PendingRequest {
	resolve: (value: BunReplReplToHost) => void;
	reject: (error: Error) => void;
}

interface ExecutionCollector {
	_execId: string;
	stdout: (chunk: string) => void;
	stderr: (chunk: string) => void;
	result: (msg: BunReplResult) => void;
	idle: () => void;
}

export class BunReplManager {
	private _state: ReplState = "idle";
	private _child: ChildProcess | null = null;
	private _pendingRequests = new Map<string, PendingRequest>();
	private _executionQueue: Promise<unknown> = Promise.resolve();
	private _activeCollector: ExecutionCollector | null = null;
	private _options: BunReplManagerOptions;
	private _snapshotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _exitPromise: Promise<void> | null = null;
	private _resolveExit: (() => void) | null = null;
	private _readyResolve: (() => void) | null = null;
	private _readyReject: ((error: Error) => void) | null = null;
	private _readyPromise: Promise<void> | null = null;
	/** exec id -> caller correlation id, bounded so a long session cannot grow it without limit. */
	private _execCorrelationIds = new Map<string, string>();
	/** Source of the most recent agent cell, for attributing host requests it detached. */
	private _lastCellCode = "";
	/** Set when the child was replaced mid-session; consumed by the next result. */
	private _pendingRestartNotice = false;
	/** Rolling tail of the child's stderr, for diagnosing a REPL that will not start. */
	private _childStderr = "";

	constructor(options: BunReplManagerOptions = {}) {
		this._options = options;
	}

	get isRunning(): boolean {
		return this._state === "running";
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this._state === "running") return;
		if (this._state === "starting" && this._readyPromise) {
			await this._readyPromise;
			return;
		}

		this._state = "starting";
		this._readyPromise = new Promise<void>((resolve, reject) => {
			this._readyResolve = resolve;
			this._readyReject = reject;
		});

		// Settled exactly once, by whichever comes first: the `ready` frame, the child dying,
		// or the deadline. The stderr tail carries the reason (a missing script, a skill that
		// threw on load), so it goes to the model with the error.
		const failStart = (reason: string): void => {
			const reject = this._readyReject;
			this._readyResolve = null;
			this._readyReject = null;
			if (!reject) return;
			const tail = this._childStderr.trim();
			reject(new Error(`REPL kernel failed to start: ${reason}${tail ? `\n${tail}` : ""}`));
		};

		const bunPath = this._options.bunPath ?? "bun";
		// Prefer the source `.ts` when running from the tree (tests/dev), falling back
		// to the compiled `.js` emitted by tsc into dist/. Bun can run both.
		const dir = fileURLToPath(new URL(".", import.meta.url));
		const tsPath = join(dir, "repl-script.ts");
		const scriptPath = existsSync(tsPath) ? tsPath : join(dir, "repl-script.js");

		const child = spawn(bunPath, ["run", scriptPath], {
			cwd: this._options.cwd,
			// NO_COLOR keeps ANSI escapes out of `%%bash` output and out of anything the cell
			// shells out to; the model reads that output as text. An explicit caller env wins.
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...this._options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Journal the kernel like detached shell children so supervisor recovery can
		// reap a kernel wedged after its owner hard-died (stdin EOF only helps a live parent).
		if (child.pid) recordOrphanProcessState(child.pid, true);

		trackLiveManager(this);

		this._child = child;

		this._exitPromise = new Promise<void>((resolve) => {
			this._resolveExit = resolve;
		});

		// Guard on child identity: during a deliberate restart (`_restartForRunaway`)
		// the old child is SIGKILLed and respawned; the old process's async `exit` event
		// must not clobber the new child's state.
		child.on("exit", (code, sig) => {
			// The exit event fires exactly once per child, including restart-replaced ones.
			if (child.pid) recordOrphanProcessState(child.pid, false);
			if (this._child !== child) return;
			this._state = "shutdown";
			this._child = null;
			for (const [, pending] of this._pendingRequests) {
				pending.reject(new Error("REPL process exited"));
			}
			this._pendingRequests.clear();
			failStart(sig ? `bun was killed by ${sig}` : `bun exited with code ${code}`);
			this._resolveExit?.();
		});

		child.on("error", (err: Error) => {
			if (this._child !== child) return;
			this._state = "shutdown";
			this._child = null;
			failStart(`bun could not be spawned: ${err.message}`);
			this._resolveExit?.();
		});

		let stdoutBuffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					this._handleMessage(JSON.parse(trimmed));
				} catch {
					// ignore malformed lines
				}
			}
		});

		// The child's stderr must be consumed: it carries skill-load and crash diagnostics, and
		// an unread pipe fills its OS buffer and blocks the child once it writes ~64KB.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (this._child !== child) return;
			this._childStderr = (this._childStderr + chunk).slice(-CHILD_STDERR_TAIL_CHARS);
		});

		if (signal?.aborted) {
			this.kill();
			return;
		}

		const startupTimer = setTimeout(() => {
			if (this._child === child) {
				try {
					child.kill("SIGKILL");
				} catch {
					// already dead; the exit handler settles it
				}
			}
			failStart(`no ready signal within ${STARTUP_TIMEOUT_MS / 1000}s`);
		}, STARTUP_TIMEOUT_MS);
		if (typeof startupTimer === "object" && "unref" in startupTimer) startupTimer.unref();

		try {
			await this._readyPromise;
		} catch (err) {
			this._state = "shutdown";
			this._readyPromise = null;
			throw err;
		} finally {
			clearTimeout(startupTimer);
		}
		this._state = "running";
	}

	private _handleMessage(msg: BunReplReplToHost): void {
		if (msg.type === "idle" && msg.id === "ready") {
			const resolve = this._readyResolve;
			this._readyResolve = null;
			this._readyReject = null;
			resolve?.();
			return;
		}

		if (msg.type === "hostRequest") {
			this._handleHostRequest(msg as BunReplHostRequest);
			return;
		}

		if (msg.type === "lateSentAgentMessage") {
			const late = msg as BunReplLateSentAgentMessage;
			const correlationId = this._execCorrelationIds.get(late.id);
			if (correlationId) this._options.onLateSentAgentMessage?.(correlationId, late.message);
			return;
		}

		if (this._activeCollector && msg.id === this._activeCollector._execId) {
			if (msg.type === "stdout") {
				this._activeCollector.stdout((msg as { chunk: string }).chunk);
				return;
			}
			if (msg.type === "stderr") {
				this._activeCollector.stderr((msg as { chunk: string }).chunk);
				return;
			}
			if (msg.type === "result") {
				this._activeCollector.result(msg as BunReplResult);
				return;
			}
			if (msg.type === "idle") {
				this._activeCollector.idle();
				return;
			}
		}

		const pending = this._pendingRequests.get(msg.id);
		if (pending) {
			this._pendingRequests.delete(msg.id);
			pending.resolve(msg);
		}
	}

	private async _handleHostRequest(msg: BunReplHostRequest): Promise<void> {
		const handler = this._options.hostHandlers?.[msg.requestType];
		let response: BunReplHostResponse;

		if (!handler) {
			response = {
				id: randomUUID(),
				type: "hostResponse",
				requestId: msg.requestId,
				status: "error",
				error: `No handler for request type: ${msg.requestType}`,
			};
		} else {
			try {
				// Mirrors the old kernel: handlers receive the payload plus the source of the
				// cell that issued the request, which `rlm.run` renders as the spawning cell.
				const result = await handler({ cellSourceCode: this._lastCellCode, ...msg.payload });
				response = {
					id: randomUUID(),
					type: "hostResponse",
					requestId: msg.requestId,
					status: "ok",
					data: result,
				};
			} catch (err: unknown) {
				response = {
					id: randomUUID(),
					type: "hostResponse",
					requestId: msg.requestId,
					status: "error",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}

		this._sendToChild(response);
	}

	private _sendToChild(msg: BunReplHostResponse | Record<string, unknown>): void {
		if (!this._child?.stdin?.writable) return;
		this._child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	private _sendAndWait<T extends BunReplReplToHost>(msg: BunReplHostToRepl, timeoutMs?: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			// The child answers these on its stdin pump, which a synchronously wedged cell can
			// starve indefinitely. Callers on a latency-sensitive path pass a ceiling; the rest
			// keep the original unbounded wait.
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							this._pendingRequests.delete(msg.id);
							reject(new Error(`REPL did not answer "${msg.type}" within ${timeoutMs}ms`));
						}, timeoutMs);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
			this._pendingRequests.set(msg.id, {
				resolve: (value) => {
					clearTimeout(timer);
					(resolve as (v: BunReplReplToHost) => void)(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this._sendToChild(msg as unknown as Record<string, unknown>);
		});
	}

	execute(code: string, opts?: BunReplExecuteOptions): Promise<BunReplExecuteResult> {
		const execPromise = this._executionQueue.then(async () => {
			this._options.onCellStart?.();
			const start = Date.now();

			if (opts?.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted" as const, durationMs: 0 };
			}

			// The child may have been hard-killed by a previous runaway; make sure it is up.
			if (this._state !== "running") {
				if (this._state === "starting") {
					await this._readyPromise;
				}
				// Re-checked rather than chained: the startup we just waited on may have failed,
				// and sending a cell to a dead child would hang until the runaway timer.
				if (!this.isRunning) {
					this._state = "idle";
					this._readyPromise = null;
					await this.start();
				}
			}

			const id = randomUUID();
			// Host requests issued from this cell (and from tasks it detaches) are attributed
			// to it, so `rlm.run` can show the model which cell spawned a child agent.
			if (!opts?.internal) this._lastCellCode = code;
			if (opts?.correlationId) {
				// Bounded FIFO: only recent cells can still produce a late message.
				if (this._execCorrelationIds.size >= 64) {
					const oldest = this._execCorrelationIds.keys().next().value;
					if (oldest !== undefined) this._execCorrelationIds.delete(oldest);
				}
				this._execCorrelationIds.set(id, opts.correlationId);
			}
			// Captured output is capped per stream; the live `onStream` callback is not, so
			// the UI still shows everything a long-running cell prints.
			const maxChars = opts?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
			let stdout = "";
			let stderr = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;
			let _resolveResult!: (value: BunReplResult) => void;
			let rejectResult!: (error: Error) => void;
			let resolveIdle!: () => void;

			// idle resolves at construction so the child's `idle` frame is never missed,
			// even when it lands in the same stdout chunk as `result` (result's await
			// resumes on a microtask that runs after the whole chunk is dispatched).
			const idlePromise = new Promise<void>((resolve) => {
				resolveIdle = resolve;
			});
			const resultPromise = new Promise<BunReplResult>((resolve, reject) => {
				_resolveResult = resolve;
				rejectResult = reject;
				this._activeCollector = {
					_execId: id,
					stdout: (chunk: string) => {
						opts?.onStream?.(chunk, "stdout");
						if (stdoutTruncated) return;
						stdout += chunk;
						if (stdout.length > maxChars) {
							stdout = stdout.slice(0, maxChars);
							stdoutTruncated = true;
						}
					},
					stderr: (chunk: string) => {
						opts?.onStream?.(chunk, "stderr");
						if (stderrTruncated) return;
						stderr += chunk;
						if (stderr.length > maxChars) {
							stderr = stderr.slice(0, maxChars);
							stderrTruncated = true;
						}
					},
					result: resolve,
					idle: () => resolveIdle(),
				};
			});

			const timeoutMs = opts?.timeout ?? this._options.defaultTimeoutMs ?? 120_000;
			let runaway = false;
			let settled = false;

			// Hard-kill + restart on a runaway (sync `while(true)` hangs, or an async
			// `await` that never resolves and ignores cooperative abort). The child is a
			// separate OS process, so SIGKILL is guaranteed to free the event loop.
			const killOnRunaway = async () => {
				if (settled) return;
				runaway = true;
				rejectResult(new Error("Bun REPL execution timed out"));
				await this._restartForRunaway();
			};
			const timer = setTimeout(() => void killOnRunaway(), timeoutMs);
			if (typeof timer === "object" && "unref" in timer) timer.unref();

			const abortHandler = () => {
				if (this._child?.pid) {
					this._sendToChild({ id: randomUUID(), type: "interrupt" });
				}
				// Grace for the cooperative interrupt to land a result; otherwise hard-kill.
				const grace = setTimeout(() => void killOnRunaway(), 1000);
				if (typeof grace === "object" && "unref" in grace) grace.unref();
			};
			opts?.signal?.addEventListener("abort", abortHandler, { once: true });

			try {
				const req: BunReplExecuteRequest = {
					id,
					type: "execute",
					code,
					timeout: timeoutMs,
					shellPath: this._options.shellPath,
					commandPrefix: this._options.commandPrefix,
				};
				this._sendToChild(req as unknown as Record<string, unknown>);

				const resultMsg = await resultPromise;
				settled = true;

				// Wait until the child signals idle (execution fully settled). Bounded: the result
				// is already in hand, so a child that never sends `idle` must not hold the cell —
				// `settled` has disarmed the runaway timer by this point, and nothing else would
				// ever end the wait.
				await Promise.race([
					idlePromise,
					new Promise<void>((resolve) => {
						const t = setTimeout(resolve, IDLE_SETTLE_TIMEOUT_MS);
						if (typeof t === "object" && "unref" in t) t.unref();
					}),
				]);

				this._activeCollector = null;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", abortHandler);

				const durationMs = Date.now() - start;
				if (stdoutTruncated) stdout += truncationMarker(maxChars);
				if (stderrTruncated) stderr += truncationMarker(maxChars);

				// An oversized attachment is a loud failure, not a silent drop: the cell believes
				// it put an image in front of the model, and must be told that it did not.
				const { attachments, oversized } = capAttachments(displayDataToAttachments(resultMsg.displayData));
				if (oversized) {
					stderr += `${stderr ? "\n" : ""}attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				}

				const restarted = this._consumeRestartNotice();

				if (resultMsg.status === "error" || oversized) {
					return {
						stdout,
						stderr,
						attachments,
						diffs: resultMsg.diffs,
						sentAgentMessages: resultMsg.sentAgentMessages,
						status: "error" as const,
						kernelRestarted: restarted,
						error: {
							ename: resultMsg.errorName ?? "Error",
							evalue: resultMsg.error ?? "Unknown error",
							traceback: resultMsg.traceback ?? [],
						},
						durationMs,
					};
				}

				this._scheduleAutoSnapshot();

				return {
					stdout,
					stderr,
					result: truncateResult(resultMsg.value, maxChars),
					attachments,
					diffs: resultMsg.diffs,
					sentAgentMessages: resultMsg.sentAgentMessages,
					status: "ok" as const,
					kernelRestarted: restarted,
					durationMs,
				};
			} catch (err: unknown) {
				settled = true;
				this._activeCollector = null;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", abortHandler);
				const aborted = opts?.signal?.aborted || runaway;
				if (stdoutTruncated) stdout += truncationMarker(maxChars);
				if (stderrTruncated) stderr += truncationMarker(maxChars);
				// The notice is deliberately not consumed here: this result already explains
				// itself, and it is the *next* cell that would otherwise never learn its
				// namespace is gone.
				return {
					stdout,
					stderr,
					status: aborted ? ("aborted" as const) : ("error" as const),
					error: {
						ename: runaway ? "TimeoutError" : "Error",
						evalue: runaway
							? "Execution timed out and the REPL was restarted; in-memory state was reset."
							: err instanceof Error
								? err.message
								: String(err),
						traceback: [],
					},
					durationMs: Date.now() - start,
				};
			}
		});

		// The finally keeps the queue chain intact while marking the kernel idle again once the
		// cell settles, on every path (ok, error, abort, runaway).
		this._executionQueue = execPromise.catch(() => {}).finally(() => this._options.onCellEnd?.());
		return execPromise;
	}

	/**
	 * Hard-kill the child (a runaway sync loop or an interruptible-forever await can
	 * only be stopped by terminating the OS process) and respawn a fresh REPL so a
	 * following execute isn't wedged. In-memory state is lost; on-disk snapshots survive.
	 */
	/**
	 * Replace a child that ignored every cooperative signal.
	 *
	 * The kill loses the live namespace, but the last snapshot on disk is still valid and is the
	 * only way back — so it must survive the restart untouched. Previously the fresh child came
	 * up and immediately overwrote it with an empty namespace, turning a recoverable runaway into
	 * permanent loss of everything the agent had built up.
	 */
	private async _restartForRunaway(): Promise<void> {
		if (this._state === "shutdown") return;
		if (this._child?.pid) {
			try {
				this._child.kill("SIGKILL");
			} catch {
				// already dead
			}
		}
		this._child = null;
		this._state = "idle";
		this._readyPromise = null;
		this._readyResolve = null;
		this._readyReject = null;
		// The namespace died with the old process; the next result has to say so.
		this._pendingRestartNotice = true;
		try {
			await this.start();
		} catch {
			this._state = "shutdown";
		}
	}

	async interrupt(): Promise<void> {
		if (!this._child?.pid) return;
		this._sendToChild({ id: randomUUID(), type: "interrupt" });
	}

	async shutdown(opts?: { snapshot?: boolean }): Promise<void> {
		if (this._state === "shutdown") return;

		if (opts?.snapshot) {
			// A wedged child must not hold shutdown open forever; losing the final snapshot is
			// recoverable (the debounced one on disk is recent), a hung dispose is not.
			await Promise.race([
				this.snapshotState().catch(() => {}),
				new Promise<void>((resolve) => {
					const t = setTimeout(resolve, SNAPSHOT_DISPOSE_TIMEOUT_MS);
					if (typeof t === "object" && "unref" in t) t.unref();
				}),
			]);
		}

		if (this._child?.pid) {
			this._sendToChild({ id: randomUUID(), type: "shutdown" });
			await Promise.race([this._exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
			if (this._child?.pid) {
				this._child.kill("SIGKILL");
			}
		}

		this._state = "shutdown";
		liveManagers.delete(this);
	}

	async restart(): Promise<void> {
		await this.shutdown();
		this._state = "idle";
		this._readyPromise = null;
		await this.start();
	}

	async kill(): Promise<void> {
		if (this._child?.pid) {
			this._child.kill("SIGKILL");
		}
		this._state = "shutdown";
		liveManagers.delete(this);
	}

	async snapshotState(): Promise<{ names: string[] } | null> {
		if (!this.isRunning || !this._options.snapshotDir) return null;

		const result = await this._sendAndWait<BunReplSnapshotResult>({
			id: randomUUID(),
			type: "snapshot",
		});

		if (result.status === "error" || !result.dataB64) {
			return null;
		}

		const names = await saveSnapshot(
			this._options.snapshotDir,
			{ dataB64: result.dataB64, names: result.names ?? [] },
			result.dropped ?? [],
		);
		return { names };
	}

	/**
	 * Revive the last snapshot into the live namespace.
	 *
	 * `failed` is the other half of the answer and matters as much as `restoredNames`: live
	 * handles are never captured and some functions cannot be re-evaluated, so part of the
	 * namespace is always gone. Reporting only what came back leaves the model assuming the
	 * rest is still there.
	 */
	async restoreState(): Promise<{ restoredNames: string[]; failed: string[] } | null> {
		if (!this.isRunning || !this._options.snapshotDir) return null;

		const snapshot = await loadSnapshot(this._options.snapshotDir);
		if (!snapshot) return null;

		const result = await this._sendAndWait<BunReplRestoreResult>({
			id: randomUUID(),
			type: "restore",
			dataB64: snapshot.dataB64,
			data: snapshot.data,
		});

		if (result.status === "error") return null;
		const restoredNames = result.restoredNames ?? [];
		// Names the snapshot never captured, plus any the child could not assign back.
		const failed = [...new Set([...snapshot.droppedNames, ...(result.failed ?? [])])].filter(
			(name) => !restoredNames.includes(name),
		);
		return { restoredNames, failed };
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (!this.isRunning) return null;

		const result = await this._sendAndWait<BunReplListNamesResult>({
			id: randomUUID(),
			type: "listNames",
		});

		return result.names;
	}

	/**
	 * Read rendered values out of the live namespace for response injection.
	 *
	 * Bounded on purpose: this runs while a finished answer is held back from the screen,
	 * so a wedged or dead child resolves to null and every reference is reported unavailable
	 * rather than stranding the message.
	 */
	async resolveInjectionRefs(names: readonly string[], timeoutMs: number): Promise<BunReplResolvedRef[] | null> {
		if (!this.isRunning || names.length === 0) return null;
		try {
			const result = await this._sendAndWait<BunReplResolveRefsResult>(
				{ id: randomUUID(), type: "resolveRefs", names: [...names], maxChars: MAX_INJECTED_REF_CHARS },
				timeoutMs,
			);
			return result.refs;
		} catch {
			return null;
		}
	}

	async dispose(): Promise<void> {
		if (this._snapshotDebounceTimer) {
			clearTimeout(this._snapshotDebounceTimer);
		}
		await this.shutdown({ snapshot: true });
	}

	disposeSync(): void {
		if (this._child?.pid) {
			this._child.kill("SIGKILL");
		}
		this._state = "shutdown";
		liveManagers.delete(this);
	}

	/** Read and clear the pending "the REPL was replaced" flag. */
	private _consumeRestartNotice(): boolean {
		const restarted = this._pendingRestartNotice;
		this._pendingRestartNotice = false;
		return restarted;
	}

	/** Tail of the child's stderr, for surfacing why a REPL failed to start. */
	get childStderr(): string {
		return this._childStderr;
	}

	/** Resident size of the kernel child process in bytes; undefined when not running or unreadable. */
	childRssBytes(): number | undefined {
		const pid = this._child?.pid;
		if (!pid || !this.isRunning) return undefined;
		try {
			const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { stdio: "pipe" });
			const kb = Number.parseInt(out.stdout.toString().trim(), 10);
			return Number.isFinite(kb) && kb > 0 ? kb * 1024 : undefined;
		} catch {
			return undefined;
		}
	}

	private _scheduleAutoSnapshot(): void {
		if (!this._options.snapshotDir) return;
		if (this._snapshotDebounceTimer) {
			clearTimeout(this._snapshotDebounceTimer);
		}
		this._snapshotDebounceTimer = setTimeout(() => {
			this.snapshotState().catch(() => {});
		}, 1500);
	}
}
