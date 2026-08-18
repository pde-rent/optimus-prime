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

export interface BunReplExecuteOptions {
	signal?: AbortSignal;
	timeout?: number;
	/**
	 * Caller-side id for this cell (the tool call id). Retained after the cell
	 * settles so an agent message sent from an un-awaited promise can still be
	 * attributed to the right tool result via `onLateSentAgentMessage`.
	 */
	correlationId?: string;
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
			env: { ...process.env, ...this._options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

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

		child.stderr.setEncoding("utf8");

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
				const result = await handler(msg.payload);
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
			if (opts?.correlationId) {
				// Bounded FIFO: only recent cells can still produce a late message.
				if (this._execCorrelationIds.size >= 64) {
					const oldest = this._execCorrelationIds.keys().next().value;
					if (oldest !== undefined) this._execCorrelationIds.delete(oldest);
				}
				this._execCorrelationIds.set(id, opts.correlationId);
			}
			let stdout = "";
			let stderr = "";
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
						stdout += chunk;
					},
					stderr: (chunk: string) => {
						stderr += chunk;
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

				if (resultMsg.status === "error") {
					return {
						stdout,
						stderr,
						attachments: displayDataToAttachments(resultMsg.displayData),
						diffs: resultMsg.diffs,
						sentAgentMessages: resultMsg.sentAgentMessages,
						status: "error" as const,
						error: {
							ename: "Error",
							evalue: resultMsg.error ?? "Unknown error",
							traceback: [],
						},
						durationMs,
					};
				}

				this._scheduleAutoSnapshot();

				return {
					stdout,
					stderr,
					result: resultMsg.value,
					attachments: displayDataToAttachments(resultMsg.displayData),
					diffs: resultMsg.diffs,
					sentAgentMessages: resultMsg.sentAgentMessages,
					status: "ok" as const,
					durationMs,
				};
			} catch (err: unknown) {
				settled = true;
				this._activeCollector = null;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", abortHandler);
				const aborted = opts?.signal?.aborted || runaway;
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
			await this.snapshotState().catch(() => {});
		}

		if (this._child?.pid) {
			this._sendToChild({ id: randomUUID(), type: "shutdown" });
			await Promise.race([this._exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
			if (this._child?.pid) {
				this._child.kill("SIGKILL");
			}
		}

		this._state = "shutdown";
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

		const names = await saveSnapshot(this._options.snapshotDir, result.data);
		return { names };
	}

	async restoreState(): Promise<{ restoredNames: string[] } | null> {
		if (!this.isRunning || !this._options.snapshotDir) return null;

		const data = await loadSnapshot(this._options.snapshotDir);
		if (!data) return null;

		const result = await this._sendAndWait<BunReplRestoreResult>({
			id: randomUUID(),
			type: "restore",
			data,
		});

		if (result.status === "error") return null;
		return { restoredNames: (result as BunReplRestoreResult & { restoredNames?: string[] }).restoredNames ?? [] };
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
