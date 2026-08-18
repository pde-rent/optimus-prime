import { createContext, runInContext } from "node:vm";
import type {
	BunReplExecuteRequest,
	BunReplHostRequest,
	BunReplHostResponse,
	BunReplHostToRepl,
	BunReplReplToHost,
} from "./protocol.js";

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

const hostBridge = {
	async hostRequest(requestType: string, payload: Record<string, unknown>): Promise<unknown> {
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			pendingHostRequests.set(requestId, { resolve, reject });
			const msg: BunReplHostRequest = {
				type: "hostRequest",
				requestId,
				requestType,
				payload,
			};
			send(msg);
		});
	},
};

const rlm = async (prompt: string, kwargs?: Record<string, unknown>) => {
	const result = await hostBridge.hostRequest("rlm.run", { prompt, kwargs: kwargs ?? {} });
	return result;
};

const rlmObj = {
	run: rlm,
	find_models: (query: string) => hostBridge.hostRequest("rlm.find_models", { query }),
	list_subagents: () => hostBridge.hostRequest("rlm.list_subagents", {}),
	delete_subagent: (id: string) => hostBridge.hostRequest("rlm.delete_subagent", { id }),
	host_request: (type: string, payload: Record<string, unknown>) => hostBridge.hostRequest(type, payload),
};

Object.assign(context, {
	rlm: rlmObj,
	__rlm_host_request: hostBridge.hostRequest.bind(hostBridge),
});

let _currentExecutionId: string | null = null;
let currentAbortController: AbortController | null = null;

async function executeCode(req: BunReplExecuteRequest): Promise<void> {
	_currentExecutionId = req.id;
	currentAbortController = new AbortController();

	const timeout = setTimeout(() => {
		currentAbortController?.abort();
	}, req.timeout);

	let capturedStdout = "";
	let _capturedStderr = "";
	const displayData: Array<{ mime: string; data: unknown }> = [];

	const _origStdoutWrite = process.stdout.write.bind(process.stdout);
	const _origStderrWrite = process.stderr.write.bind(process.stderr);

	const stdoutInterceptor = (chunk: string | Uint8Array) => {
		const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		capturedStdout += text;
		send({ id: req.id, type: "stdout", chunk: text });
		return true;
	};

	const stderrInterceptor = (chunk: string | Uint8Array) => {
		const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		_capturedStderr += text;
		send({ id: req.id, type: "stderr", chunk: text });
		return true;
	};

	const origStdoutWriteFn = process.stdout.write;
	const origStderrWriteFn = process.stderr.write;
	process.stdout.write = stdoutInterceptor as typeof process.stdout.write;
	process.stderr.write = stderrInterceptor as typeof process.stderr.write;

	try {
		context.__stdout = capturedStdout;
		context.__display_data = displayData;

		const wrappedCode = `
(async () => {
  const __origConsoleLog = console.log;
  const __logs = [];
  console.log = (...args) => {
    __logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    process.stdout.write(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\\n');
  };
  try {
    const __result = await (async () => { ${req.code} })();
    console.log = __origConsoleLog;
    return { __logs, __result };
  } catch (__err) {
    console.log = __origConsoleLog;
    throw __err;
  }
})()
`;

		const result = await runInContext(wrappedCode, vmContext, {
			timeout: req.timeout,
		});

		const resultStr = result?.__result !== undefined ? serializeValue(result.__result) : undefined;

		send({
			id: req.id,
			type: "result",
			status: "ok",
			value: resultStr,
			displayData: displayData.length > 0 ? displayData : undefined,
		});
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		send({
			id: req.id,
			type: "result",
			status: "error",
			error: errorMsg,
		});
	} finally {
		clearTimeout(timeout);
		process.stdout.write = origStdoutWriteFn;
		process.stderr.write = origStderrWriteFn;
		_currentExecutionId = null;
		currentAbortController = null;
		send({ id: req.id, type: "idle" });
	}
}

function snapshotState(): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(context)) {
		if (key.startsWith("__")) continue;
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
		context[key] = value;
		vmContext[key] = value;
		restored.push(key);
	}
	return restored;
}

function listNames(): string[] {
	return Object.keys(context).filter((k) => !k.startsWith("__"));
}

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
				executeCode(msg);
				break;
			case "interrupt":
				currentAbortController?.abort();
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
		}
	}
});

process.stdin.on("end", () => {
	process.exit(0);
});

const readyMsg: BunReplReplToHost = { id: "ready", type: "idle" };
send(readyMsg);
