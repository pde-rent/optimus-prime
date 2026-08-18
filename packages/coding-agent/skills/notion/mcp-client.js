/**
 * MCP-client integration base for Prime Agent JS skills.
 *
 * A skill targets one MCP `server`, and its tools are discovered from that
 * server at runtime and dispatched dynamically, so the agent writes ordinary
 * JavaScript:
 *
 *     const issues = await linear.list_issues({ team: "Engineering" });
 *
 * Credentials live in the host's `auth.json` (single store, survives REPL
 * restarts). This module reads that file directly for the common case; on token
 * expiry or a 401/403 it asks the host to refresh via
 * `hostRequest("mcp.refresh", ...)` and re-reads. Interactive login runs
 * host-side, never here.
 *
 * Transport is MCP Streamable HTTP spoken directly over `fetch`: JSON-RPC 2.0
 * POSTs that may answer with either a plain JSON body or an SSE
 * `text/event-stream` body. No npm dependencies.
 *
 * NOTE: this file is duplicated verbatim into each MCP skill directory. Skills
 * are loaded by absolute entry path from independent roots (user dir, project
 * dir, bundled dir) and may be installed individually, so a relative import
 * across skill directories is not robust.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Stored access tokens are treated as expired this many seconds early so a
 * token never dies mid-request. Mirrors the host's refresh buffer.
 */
const EXPIRY_SKEW_SECONDS = 30;

/** Raised when an integration has no usable credentials. */
export class NotEnabled extends Error {
	constructor(server) {
		super(
			`The '${server}' integration is not enabled: no credentials found. ` +
				`Tell the user to run \`/mcp login ${server}\` in Prime Agent to connect it. ` +
				`Do not ask them to set environment variables.`,
		);
		this.name = "NotEnabled";
		this.server = server;
	}
}

/** Raised when an MCP tool call returns a result flagged as an error. */
export class McpToolError extends Error {
	constructor(message) {
		super(message);
		this.name = "McpToolError";
	}
}

/** Resolve the Prime Agent config dir the same way the rest of the runtime does. */
function agentDir(env) {
	const raw = env.PRIME_AGENT_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || `${homedir()}/.prime/agent`;
	const expanded = raw.startsWith("~") ? homedir() + raw.slice(1) : raw;
	// resolve() so a relative env override reads auth.json from the right place,
	// not relative to the REPL's cwd.
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Read one credential entry from auth.json. Returns null if absent/unreadable. */
async function readAuth(env, provider) {
	let data;
	try {
		data = await Bun.file(`${agentDir(env)}/auth.json`).json();
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const cred = data[provider];
	return cred && typeof cred === "object" && !Array.isArray(cred) ? cred : null;
}

/**
 * Resolve a stored api_key value the way the host does.
 *
 * A value may be a literal, an env-var name, or a `!command` indirection. The
 * command form can't run safely here (the host injects those resolved), so skip
 * it; otherwise treat the value as an env-var name if set, else literal.
 */
function resolveConfigValue(env, value) {
	const v = String(value ?? "").trim();
	if (!v || v.startsWith("!")) return "";
	return String(env[v] || v).trim();
}

/** Parse an SSE body into the JSON-RPC messages carried by its `data:` fields. */
function parseSse(body) {
	const messages = [];
	for (const rawEvent of body.split(/\r?\n\r?\n/)) {
		const data = rawEvent
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		try {
			messages.push(JSON.parse(data));
		} catch {
			// Ignore keep-alives / non-JSON comment frames.
		}
	}
	return messages;
}

/**
 * Normalize a JSON-RPC `tools/call` result into plain JS (structured output
 * preferred). Throws McpToolError when the server flags the result as an error,
 * so a failed tool call doesn't look like a successful one to the caller.
 */
function parseToolResult(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	const texts = blocks.filter((b) => typeof b?.text === "string").map((b) => b.text);
	if (result?.isError) {
		throw new McpToolError(texts.join("\n") || "MCP tool returned an error");
	}
	// Falsy-but-valid payloads ({} / []) are real results.
	if (result?.structuredContent !== undefined && result?.structuredContent !== null) {
		return result.structuredContent;
	}
	if (texts.length) return texts.join("\n");
	// Non-text content (images, embedded resources) is already plain JSON here.
	if (blocks.length) return blocks;
	return result;
}

/**
 * MCP Streamable-HTTP client bound to one server.
 *
 * Tools are discovered on first use and cached; `callTool(name, args)` is the
 * explicit escape hatch and the hook for hand-written typed wrappers.
 */
export class McpClient {
	/**
	 * @param {object} opts
	 * @param {string} opts.server   credential/config key (matches auth.json `mcp:<server>`)
	 * @param {string} [opts.url]    default remote MCP endpoint
	 * @param {string} [opts.bearerTokenEnv] env var holding a static bearer token
	 * @param {(type: string, payload: object) => Promise<any>} [opts.hostRequest]
	 * @param {object} [opts.env]    environment (defaults to process.env)
	 */
	constructor({ server, url = null, bearerTokenEnv = null, hostRequest = null, env = null } = {}) {
		if (!server) throw new Error("McpClient requires a non-empty `server`");
		this.server = server;
		this.url = url;
		this.bearerTokenEnv = bearerTokenEnv;
		this._hostRequest = hostRequest;
		this._env = env || process.env;
		this._tools = null;
		this._toolsPromise = null;
	}

	get providerId() {
		return `mcp:${this.server}`;
	}

	async _host(type, payload) {
		if (typeof this._hostRequest !== "function") {
			throw new Error(`host bridge unavailable for '${type}'`);
		}
		return this._hostRequest(type, payload);
	}

	// -- credentials --------------------------------------------------------

	/**
	 * Current usable bearer token, or null if missing/expired (needs refresh).
	 *
	 * A static bearer-token env var wins (matches the host's `isAuthed` check);
	 * otherwise read auth.json. OAuth tokens are only returned while still fresh.
	 */
	async _token() {
		if (this.bearerTokenEnv) {
			const envToken = String(this._env[this.bearerTokenEnv] || "").trim();
			if (envToken) return envToken;
		}
		const cred = await readAuth(this._env, this.providerId);
		if (cred === null) return null;
		if (cred.type === "api_key") {
			return resolveConfigValue(this._env, cred.key) || null;
		}
		// OAuth credential: { access, refresh, expires(ms) }.
		const access = String(cred.access || "");
		const expires = cred.expires;
		const fresh =
			typeof expires === "number" && Number.isFinite(expires) && Date.now() < expires - EXPIRY_SKEW_SECONDS * 1000;
		if (access && fresh) return access;
		return null; // signal: needs refresh
	}

	/** Resolve a usable token, refreshing host-side once if the stored one is stale. */
	async _resolveToken() {
		const token = await this._token();
		if (token) return token;
		// Expired or missing-access: ask the host to refresh, then re-validate via
		// _token() (which re-checks expiry) rather than trusting any access value.
		if ((await readAuth(this._env, this.providerId)) !== null) {
			const refreshError = await this._refresh();
			const refreshed = await this._token();
			if (refreshed) return refreshed;
			// A refresh that failed (vs. genuinely-absent creds) is a recoverable
			// error; don't mislabel it as "not enabled / re-login".
			if (refreshError) {
				throw new Error(`Failed to refresh credentials for '${this.server}': ${refreshError.message}`, {
					cause: refreshError,
				});
			}
		}
		throw new NotEnabled(this.server);
	}

	/** Ask the host to refresh credentials. Returns the error on failure, else null. */
	async _refresh() {
		try {
			await this._host("mcp.refresh", { server: this.server });
			return null;
		} catch (err) {
			return err instanceof Error ? err : new Error(String(err));
		}
	}

	// -- connection ---------------------------------------------------------

	/**
	 * Host-resolved `{ url, headers }`, honoring a user's mcpServers override.
	 * Falls back to the configured `url` and no extra headers on host error.
	 */
	async _resolveConfig() {
		let cfg = {};
		try {
			cfg = (await this._host("mcp.config", { server: this.server })) || {};
		} catch {
			cfg = {};
		}
		const url = typeof cfg?.url === "string" && cfg.url ? cfg.url : this.url;
		const raw = cfg?.headers && typeof cfg.headers === "object" ? cfg.headers : {};
		const headers = {};
		for (const [k, v] of Object.entries(raw)) headers[String(k)] = String(v);
		return { url, headers };
	}

	/** POST one JSON-RPC message; returns the parsed response (null for notifications). */
	async _post(url, headers, message, { expectResponse = true } = {}) {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(message),
		});
		const sessionId = res.headers.get("mcp-session-id");
		if (res.status === 401 || res.status === 403) {
			const err = new Error(`MCP server '${this.server}' rejected credentials (${res.status})`);
			err.status = res.status;
			throw err;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			const err = new Error(
				`MCP request to '${this.server}' failed (${res.status})${body ? `: ${body.slice(0, 500)}` : ""}`,
			);
			err.status = res.status;
			throw err;
		}
		// 202 Accepted (notifications) and empty bodies carry no JSON-RPC response.
		const contentType = res.headers.get("content-type") || "";
		const body = await res.text();
		if (!expectResponse || !body.trim()) return { sessionId, result: null };

		let messages;
		if (contentType.includes("text/event-stream")) {
			messages = parseSse(body);
		} else {
			try {
				const parsed = JSON.parse(body);
				messages = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				throw new Error(`MCP server '${this.server}' returned a non-JSON body: ${body.slice(0, 500)}`);
			}
		}
		const reply = messages.find((m) => m && m.id === message.id && ("result" in m || "error" in m));
		if (!reply) {
			throw new Error(`MCP server '${this.server}' returned no response for '${message.method}'`);
		}
		if (reply.error) {
			const { code, message: msg, data } = reply.error;
			const err = new Error(
				`MCP error from '${this.server}' (${code}): ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`,
			);
			err.code = code;
			throw err;
		}
		return { sessionId, result: reply.result };
	}

	/**
	 * Open an initialized MCP session and run `fn(request)` against it.
	 *
	 * A fresh session per call: MCP sessions are not safe to hold across REPL
	 * restarts, and per-call connect keeps this robust to idle sessions and token
	 * rotation at modest latency cost. On a credential rejection the host is asked
	 * to refresh once and the whole exchange is retried.
	 */
	async _withSession(fn) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this._session(fn);
			} catch (err) {
				const authFailure = err?.status === 401 || err?.status === 403;
				if (!authFailure || attempt === 1) throw err;
				const refreshError = await this._refresh();
				if (refreshError) {
					throw new Error(`Failed to refresh credentials for '${this.server}': ${refreshError.message}`, {
						cause: refreshError,
					});
				}
			}
		}
		throw new Error("unreachable");
	}

	async _session(fn) {
		const { url, headers: extraHeaders } = await this._resolveConfig();
		if (!url) throw new Error(`MCP skill '${this.server}' has no URL configured`);
		const token = await this._resolveToken();
		// Extra configured headers first, Authorization last so it always wins.
		const headers = { ...extraHeaders, Authorization: `Bearer ${token}` };

		const init = await this._post(url, headers, {
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "prime-agent", version: "1.0.0" },
			},
		});
		// The session id returned by `initialize` must ride along on every later
		// request in this session.
		if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
		const protocolVersion = init.result?.protocolVersion;
		if (protocolVersion) headers["MCP-Protocol-Version"] = String(protocolVersion);

		await this._post(
			url,
			headers,
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ expectResponse: false },
		);

		const request = (method, params) =>
			this._post(url, headers, {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method,
				params: params || {},
			}).then((r) => r.result);

		return fn(request);
	}

	// -- tools --------------------------------------------------------------

	/** Return the server's tools as `[{ name, description, inputSchema }]`. */
	async listTools() {
		await this._ensureTools();
		return Object.values(this._tools).map((t) => ({ ...t }));
	}

	async _ensureTools() {
		if (this._tools) return;
		if (!this._toolsPromise) {
			this._toolsPromise = this._withSession(async (request) => {
				const resp = await request("tools/list", {});
				const tools = {};
				for (const t of resp?.tools || []) {
					tools[t.name] = {
						name: t.name,
						description: t.description || "",
						inputSchema: t.inputSchema || {},
					};
				}
				return tools;
			})
				.then((tools) => {
					this._tools = tools;
				})
				.finally(() => {
					this._toolsPromise = null;
				});
		}
		await this._toolsPromise;
	}

	/** Call `tool` on the server and return its parsed result. */
	async callTool(tool, args) {
		return this._withSession(async (request) => {
			const result = await request("tools/call", { name: tool, arguments: args || {} });
			return parseToolResult(result);
		});
	}

	/** Call `tool`, first checking it exists so typos fail with the tool list. */
	async callKnownTool(tool, args) {
		await this._ensureTools();
		if (this._tools && !(tool in this._tools)) {
			const available = Object.keys(this._tools).sort().join(", ") || "(none)";
			throw new Error(`'${this.server}' has no tool '${tool}'. Available: ${available}`);
		}
		return this.callTool(tool, args);
	}
}

/**
 * Build the object a skill returns: explicit `call_tool` / `list_tools` escape
 * hatches, plus a Proxy that dispatches any other property access to a matching
 * MCP tool, so `await linear.list_issues({ team: "Engineering" })` works for any
 * tool the server exposes.
 */
export function createMcpSkill({ server, url, bearerTokenEnv }, ctx = {}) {
	const client = new McpClient({
		server,
		url,
		bearerTokenEnv,
		hostRequest: ctx.hostRequest,
		env: ctx.env,
	});

	const api = {
		/** The underlying client (transport, credentials, tool cache). */
		client,

		/** Return the server's tools as `[{ name, description, inputSchema }]`. */
		async list_tools() {
			return client.listTools();
		},

		/** Call a tool by exact name — works for names that aren't valid identifiers. */
		async call_tool(name, args) {
			if (typeof name !== "string" || !name) {
				throw new TypeError("call_tool(name, args): `name` must be a non-empty string");
			}
			return client.callTool(name, args);
		},
	};

	return new Proxy(api, {
		get(target, prop, receiver) {
			if (prop in target || typeof prop !== "string" || prop.startsWith("_")) {
				return Reflect.get(target, prop, receiver);
			}
			// Don't hand a tool stub to `await`, JSON.stringify, console.log, or any
			// other protocol probe — they'd mistake this object for a thenable etc.
			if (prop === "then" || prop === "toJSON" || prop === "inspect") return undefined;
			const fn = (args) => client.callKnownTool(prop, args);
			Object.defineProperty(fn, "name", { value: prop });
			return fn;
		},
		has(target, prop) {
			return typeof prop === "string" && !prop.startsWith("_") ? true : Reflect.has(target, prop);
		},
	});
}
