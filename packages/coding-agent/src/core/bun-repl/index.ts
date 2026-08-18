import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelAttachment, KernelDiffDisplay, KernelSentAgentMessage } from "../tools/kernel-types.js";
import type {
	BunReplExecuteRequest,
	BunReplHostRequest,
	BunReplHostResponse,
	BunReplHostToRepl,
	BunReplLateSentAgentMessage,
	BunReplListNamesResult,
	BunReplReplToHost,
	BunReplRestoreResult,
	BunReplResult,
	BunReplSnapshotResult,
} from "./protocol.js";
import { loadSnapshot, saveSnapshot } from "./state-snapshot.js";

/** Rolling tail kept from the child's stderr, matching the old kernel's diagnostic tail. */
const CHILD_STDERR_TAIL_CHARS = 4096;

/** Cap on the final snapshot taken during dispose. */
const SNAPSHOT_DISPOSE_TIMEOUT_MS = 5000;

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
		this._readyPromise = new Promise<void>((resolve) => {
			this._readyResolve = resolve;
		});

		const bunPath = this._options.bunPath ?? "bun";
		// Prefer the source `.ts` when running from the tree (vitest/dev), falling back
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

		trackLiveManager(this);

		this._child = child;

		this._exitPromise = new Promise<void>((resolve) => {
			this._resolveExit = resolve;
		});

		// Guard on child identity: during a deliberate restart (`_restartForRunaway`)
		// the old child is SIGKILLed and respawned; the old process's async `exit` event
		// must not clobber the new child's state.
		child.on("exit", () => {
			if (this._child !== child) return;
			this._state = "shutdown";
			this._child = null;
			for (const [, pending] of this._pendingRequests) {
				pending.reject(new Error("REPL process exited"));
			}
			this._pendingRequests.clear();
			this._resolveExit?.();
		});

		child.on("error", () => {
			if (this._child !== child) return;
			this._state = "shutdown";
			this._child = null;
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

		await this._readyPromise;
		this._state = "running";
	}

	private _handleMessage(msg: BunReplReplToHost): void {
		if (msg.type === "idle" && msg.id === "ready") {
			this._readyResolve?.();
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

	private _sendAndWait<T extends BunReplReplToHost>(msg: BunReplHostToRepl): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this._pendingRequests.set(msg.id, {
				resolve: resolve as (value: BunReplReplToHost) => void,
				reject,
			});
			this._sendToChild(msg as unknown as Record<string, unknown>);
		});
	}

	execute(code: string, opts?: BunReplExecuteOptions): Promise<BunReplExecuteResult> {
		const execPromise = this._executionQueue.then(async () => {
			const start = Date.now();

			if (opts?.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted" as const, durationMs: 0 };
			}

			// The child may have been hard-killed by a previous runaway; make sure it is up.
			if (this._state !== "running") {
				if (this._state === "starting") {
					await this._readyPromise;
				} else {
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

			const timeoutMs = opts?.timeout ?? 120_000;
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

				// Wait until the child signals idle (execution fully settled).
				await idlePromise;

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

		this._executionQueue = execPromise.catch(() => {});
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

		if (result.status === "error" || !("data" in result) || !result.data) {
			return null;
		}

		const names = await saveSnapshot(this._options.snapshotDir, result.data, result.dropped ?? []);
		return { names };
	}

	/**
	 * Revive the last snapshot into the live namespace.
	 *
	 * `failed` is the other half of the answer and matters as much as `restoredNames`: the
	 * snapshot is JSON, so every function, class and closure the agent built is gone. Reporting
	 * only what came back leaves the model assuming the rest is still there.
	 */
	async restoreState(): Promise<{ restoredNames: string[]; failed: string[] } | null> {
		if (!this.isRunning || !this._options.snapshotDir) return null;

		const snapshot = await loadSnapshot(this._options.snapshotDir);
		if (!snapshot) return null;

		const result = await this._sendAndWait<BunReplRestoreResult>({
			id: randomUUID(),
			type: "restore",
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
