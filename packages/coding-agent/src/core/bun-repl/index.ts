import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BunReplExecuteRequest,
	BunReplHostRequest,
	BunReplHostResponse,
	BunReplHostToRepl,
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
}

export interface BunReplExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

export type BunReplHostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface BunReplManagerOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: Record<string, BunReplHostRequestHandler>;
	snapshotDir?: string;
	bunPath?: string;
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
		const scriptPath = join(fileURLToPath(new URL(".", import.meta.url)), "repl-script.js");

		const child = spawn(bunPath, ["run", scriptPath], {
			cwd: this._options.cwd,
			env: { ...process.env, ...this._options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this._child = child;

		this._exitPromise = new Promise<void>((resolve) => {
			this._resolveExit = resolve;
		});

		child.on("exit", () => {
			this._state = "shutdown";
			this._child = null;
			for (const [, pending] of this._pendingRequests) {
				pending.reject(new Error("REPL process exited"));
			}
			this._pendingRequests.clear();
			this._resolveExit?.();
		});

		child.on("error", () => {
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

			const id = randomUUID();
			let stdout = "";
			let stderr = "";

			const resultPromise = new Promise<BunReplResult>((resolve) => {
				this._activeCollector = {
					_execId: id,
					stdout: (chunk: string) => {
						stdout += chunk;
					},
					stderr: (chunk: string) => {
						stderr += chunk;
					},
					result: resolve,
					idle: () => {},
				};
			});

			const abortHandler = () => {
				this._sendToChild({ id: randomUUID(), type: "interrupt" });
			};
			opts?.signal?.addEventListener("abort", abortHandler, { once: true });

			try {
				const req: BunReplExecuteRequest = {
					id,
					type: "execute",
					code,
					timeout: opts?.timeout ?? 120_000,
				};
				this._sendToChild(req as unknown as Record<string, unknown>);

				const resultMsg = await resultPromise;

				// Wait for idle signal
				await new Promise<void>((resolve) => {
					if (this._activeCollector) {
						this._activeCollector.idle = resolve;
					} else {
						resolve();
					}
				});

				this._activeCollector = null;
				opts?.signal?.removeEventListener("abort", abortHandler);

				const durationMs = Date.now() - start;

				if (resultMsg.status === "error") {
					return {
						stdout,
						stderr,
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
					status: "ok" as const,
					durationMs,
				};
			} catch (err: unknown) {
				this._activeCollector = null;
				opts?.signal?.removeEventListener("abort", abortHandler);
				return {
					stdout,
					stderr,
					status: opts?.signal?.aborted ? ("aborted" as const) : ("error" as const),
					error: {
						ename: "Error",
						evalue: err instanceof Error ? err.message : String(err),
						traceback: [],
					},
					durationMs: Date.now() - start,
				};
			}
		});

		this._executionQueue = execPromise.catch(() => {});
		return execPromise;
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
