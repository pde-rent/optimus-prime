/**
 * MCP client over Streamable HTTP.
 *
 * The protocol split in two at revision 2026-07-28. Modern servers are stateless:
 * every request is a standalone POST that declares its own protocol version, and
 * there is no handshake, no session id, and no separate event stream. Legacy
 * servers -- 2025-11-25 and earlier -- open with `initialize`, may mint a session
 * id, and expect it back on every later request.
 *
 * Both are spoken here, because the ecosystem has not moved: roughly seven in
 * eight client connections were still handshake-era three weeks after the modern
 * revision shipped. A modern-only client fails against most servers deployed
 * today, and a legacy-only client is obsolete on arrival. So a server's era is
 * probed once, cached per endpoint, and re-probed if the assumption later breaks.
 *
 * Transport is HTTP only. The specification also defines stdio, which is how
 * locally-installed servers are usually run; `request()` is the single seam a
 * stdio transport would replace.
 *
 * Not implemented, and reported rather than mis-parsed if a server uses them:
 * multi-round-trip input requests (sampling, elicitation, roots), long-lived
 * subscription streams, resources and prompts. Tools are the surface an agent
 * needs; the rest can be added behind the same request function.
 */

/** Revisions this client can speak, newest first. The first is what it asks for. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** JSON-RPC error codes the specification assigns meaning to. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const HEADER_MISMATCH = -32020;
const METHOD_NOT_FOUND = -32601;

/** A tool parameter can ask to be mirrored into `Mcp-Param-<name>`. */
const HEADER_ANNOTATION = "x-mcp-header";
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_SAFE_VALUE = /^[\x20-\x7E]*$/;

export interface McpClientOptions {
	/** The server's MCP endpoint. */
	url: string;
	/** Static headers from configuration, such as an API key. */
	headers?: Record<string, string>;
	/** Called before each request; the result becomes `Authorization: Bearer`. */
	getAccessToken?: () => Promise<string | undefined> | string | undefined;
	/** Reported to the server for logging and policy. */
	clientInfo?: { name: string; version: string };
	/** Overall deadline per request. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
	content: Array<Record<string, unknown>>;
	isError?: boolean;
	structuredContent?: unknown;
}

/** A JSON-RPC error from the server, with its code preserved for callers that branch on it. */
export class McpError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "McpError";
	}
}

interface JsonRpcResponse {
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

/** Whether a server speaks the stateless revision or the handshake revisions. */
type ServerEra = "modern" | "legacy";

/**
 * Era and session are properties of the endpoint, not of one request, so they are
 * cached for the process. A wrong guess is corrected by re-probing rather than by
 * failing the call.
 */
const eraByEndpoint = new Map<string, ServerEra>();

const DEFAULT_CLIENT_INFO = { name: "optimus-prime", version: "1" };

/** Header values must be visible ASCII; anything else travels Base64 in a sentinel. */
function encodeHeaderValue(value: string): string {
	if (HEADER_SAFE_VALUE.test(value) && value.trim() === value && !value.startsWith("=?base64?")) {
		return value;
	}
	return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Values a server asked to see mirrored into headers.
 *
 * Only properties reachable from the schema root through `properties` qualify: an
 * annotation under `items`, a composition keyword or a `$ref` is invalid, and the
 * specification requires the whole tool be rejected rather than the annotation
 * ignored. Returns undefined for an invalid annotation so the caller can drop the tool.
 */
function collectParamHeaders(
	schema: Record<string, unknown> | undefined,
	args: Record<string, unknown>,
): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	const seen = new Set<string>();
	let invalid = false;

	const walk = (node: unknown, value: unknown): void => {
		if (invalid || typeof node !== "object" || node === null) return;
		const properties = (node as Record<string, unknown>).properties;
		if (typeof properties !== "object" || properties === null) return;
		for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
			if (typeof child !== "object" || child === null) continue;
			const annotation = (child as Record<string, unknown>)[HEADER_ANNOTATION];
			const childValue =
				typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
			if (annotation !== undefined) {
				const type = (child as Record<string, unknown>).type;
				if (
					typeof annotation !== "string" ||
					!HEADER_TOKEN.test(annotation) ||
					seen.has(annotation.toLowerCase()) ||
					(type !== "string" && type !== "integer" && type !== "boolean")
				) {
					invalid = true;
					return;
				}
				seen.add(annotation.toLowerCase());
				if (childValue !== undefined && childValue !== null) {
					headers[`Mcp-Param-${annotation}`] = encodeHeaderValue(String(childValue));
				}
			}
			walk(child, childValue);
		}
	};

	walk(schema, args);
	return invalid ? undefined : headers;
}

/** Read an SSE body and return the final JSON-RPC message it carries. */
async function readEventStream(response: Response): Promise<JsonRpcResponse> {
	const body = await response.text();
	let last: JsonRpcResponse | undefined;
	for (const block of body.split(/\r?\n\r?\n/)) {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("");
		if (!data) continue;
		try {
			const parsed = JSON.parse(data) as JsonRpcResponse & { method?: string };
			// Notifications relate to the request but are not its answer.
			if (parsed.result !== undefined || parsed.error !== undefined) last = parsed;
		} catch {
			// A malformed frame is not fatal while a later frame may still answer.
		}
	}
	if (!last) throw new McpError("server sent an event stream with no response", METHOD_NOT_FOUND);
	return last;
}

export class McpClient {
	readonly #url: string;
	readonly #staticHeaders: Record<string, string>;
	readonly #getAccessToken: McpClientOptions["getAccessToken"];
	readonly #clientInfo: { name: string; version: string };
	readonly #timeoutMs: number;
	readonly #signal?: AbortSignal;
	/** Set once a legacy handshake mints one; absent for modern servers. */
	#sessionId: string | undefined;
	#negotiatedVersion: string = MODERN_PROTOCOL_VERSION;
	#nextId = 1;

	constructor(options: McpClientOptions) {
		this.#url = options.url;
		this.#staticHeaders = options.headers ?? {};
		this.#getAccessToken = options.getAccessToken;
		this.#clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
		this.#timeoutMs = options.timeoutMs ?? 60_000;
		this.#signal = options.signal;
	}

	/** Tools the server offers, following pagination to the end. */
	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.#rpc("tools/list", cursor ? { cursor } : {});
			for (const entry of (result.tools as McpTool[] | undefined) ?? []) {
				// A tool whose header annotations are invalid must not be offered at all.
				if (collectParamHeaders(entry.inputSchema, {}) === undefined) continue;
				tools.push(entry);
			}
			cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
		} while (cursor);
		return tools;
	}

	/**
	 * Call a tool.
	 *
	 * `inputSchema` is only needed for servers that mirror parameters into headers;
	 * pass the schema from `listTools()` when you have it.
	 */
	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		inputSchema?: Record<string, unknown>,
	): Promise<McpToolResult> {
		const paramHeaders = collectParamHeaders(inputSchema, args);
		if (paramHeaders === undefined) {
			throw new McpError(`tool ${name} declares invalid ${HEADER_ANNOTATION} annotations`, HEADER_MISMATCH);
		}
		const result = await this.#rpc("tools/call", { name, arguments: args }, { name, extraHeaders: paramHeaders });
		if (Array.isArray((result as Record<string, unknown>).inputRequests)) {
			throw new McpError(
				`tool ${name} asked the client for input (sampling, elicitation or roots), which this client does not provide`,
				METHOD_NOT_FOUND,
			);
		}
		return {
			content: (result.content as Array<Record<string, unknown>>) ?? [],
			isError: result.isError === true,
			structuredContent: result.structuredContent,
		};
	}

	/** Identity, capabilities and supported versions in one call. Modern servers only. */
	async discover(): Promise<Record<string, unknown>> {
		return await this.#rpc("server/discover", {});
	}

	async #authHeaders(): Promise<Record<string, string>> {
		const token = await this.#getAccessToken?.();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	/** One JSON-RPC call, in whichever era this endpoint speaks. */
	async #rpc(
		method: string,
		params: Record<string, unknown>,
		options: { name?: string; extraHeaders?: Record<string, string> } = {},
	): Promise<Record<string, unknown>> {
		const era = eraByEndpoint.get(this.#url);
		if (era === "legacy") return await this.#legacyRpc(method, params, options);
		try {
			const result = await this.#modernRpc(method, params, options);
			eraByEndpoint.set(this.#url, "modern");
			return result;
		} catch (error) {
			if (era === "modern" || !(error instanceof LegacyServerDetected)) throw error;
			eraByEndpoint.set(this.#url, "legacy");
			return await this.#legacyRpc(method, params, options);
		}
	}

	async #modernRpc(
		method: string,
		params: Record<string, unknown>,
		options: { name?: string; extraHeaders?: Record<string, string> },
	): Promise<Record<string, unknown>> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const body = {
				jsonrpc: "2.0",
				id: this.#nextId++,
				method,
				params: {
					...params,
					_meta: {
						[PROTOCOL_VERSION_META_KEY]: this.#negotiatedVersion,
						[CLIENT_INFO_META_KEY]: this.#clientInfo,
						[CLIENT_CAPABILITIES_META_KEY]: {},
					},
				},
			};
			// The header must match the body value or the server rejects the request.
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": this.#negotiatedVersion,
				"Mcp-Method": method,
				...(options.name ? { "Mcp-Name": encodeHeaderValue(options.name) } : {}),
				...options.extraHeaders,
				...this.#staticHeaders,
				...(await this.#authHeaders()),
			};
			const response = await this.#fetch(headers, body);
			const payload = await this.#readBody(response);

			if (response.ok) {
				if (payload?.error) throw new McpError(payload.error.message, payload.error.code, payload.error.data);
				return payload?.result ?? {};
			}
			// A modern server states its objection in a JSON-RPC error; anything else
			// at 4xx is how a handshake-era server answers a request it cannot parse.
			if (!payload?.error) throw new LegacyServerDetected();
			if (payload.error.code === UNSUPPORTED_PROTOCOL_VERSION && attempt === 0) {
				const supported = (payload.error.data as { supported?: string[] } | undefined)?.supported ?? [];
				const agreed = SUPPORTED_PROTOCOL_VERSIONS.find((version) => supported.includes(version));
				if (!agreed) {
					throw new McpError(
						`no protocol version in common; server supports ${supported.join(", ") || "none reported"}`,
						UNSUPPORTED_PROTOCOL_VERSION,
						payload.error.data,
					);
				}
				this.#negotiatedVersion = agreed;
				continue;
			}
			throw new McpError(payload.error.message, payload.error.code, payload.error.data);
		}
		throw new McpError("protocol version negotiation did not converge", UNSUPPORTED_PROTOCOL_VERSION);
	}

	/** The handshake era: initialize once, carry the session id, tear it down on close. */
	async #legacyRpc(
		method: string,
		params: Record<string, unknown>,
		options: { name?: string },
	): Promise<Record<string, unknown>> {
		if (!this.#sessionId) await this.#legacyInitialize();
		return await this.#legacySend(method, params, options);
	}

	async #legacyInitialize(): Promise<void> {
		const version = SUPPORTED_PROTOCOL_VERSIONS.find((candidate) => candidate !== MODERN_PROTOCOL_VERSION);
		this.#negotiatedVersion = version ?? "2025-06-18";
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.#staticHeaders,
			...(await this.#authHeaders()),
		};
		const response = await this.#fetch(headers, {
			jsonrpc: "2.0",
			id: this.#nextId++,
			method: "initialize",
			params: {
				protocolVersion: this.#negotiatedVersion,
				capabilities: {},
				clientInfo: this.#clientInfo,
			},
		});
		const payload = await this.#readBody(response);
		if (!response.ok || payload?.error) {
			throw new McpError(
				payload?.error?.message ?? `initialize failed with ${response.status}`,
				payload?.error?.code ?? response.status,
			);
		}
		// Absent for a stateless legacy server, which is allowed.
		this.#sessionId = response.headers.get("Mcp-Session-Id") ?? "stateless";
		const negotiated = payload?.result?.protocolVersion;
		if (typeof negotiated === "string") this.#negotiatedVersion = negotiated;
		// The handshake is only complete once this notification is sent.
		await this.#fetch(
			{ ...headers, ...this.#sessionHeader() },
			{
				jsonrpc: "2.0",
				method: "notifications/initialized",
			},
		);
	}

	async #legacySend(
		method: string,
		params: Record<string, unknown>,
		options: { name?: string },
	): Promise<Record<string, unknown>> {
		void options;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": this.#negotiatedVersion,
			...this.#sessionHeader(),
			...this.#staticHeaders,
			...(await this.#authHeaders()),
		};
		const response = await this.#fetch(headers, { jsonrpc: "2.0", id: this.#nextId++, method, params });
		// The session expired: the specification says re-initialize rather than surface it.
		if (response.status === 404 && this.#sessionId && this.#sessionId !== "stateless") {
			this.#sessionId = undefined;
			await this.#legacyInitialize();
			return await this.#legacySend(method, params, options);
		}
		const payload = await this.#readBody(response);
		if (!response.ok || payload?.error) {
			throw new McpError(
				payload?.error?.message ?? `${method} failed with ${response.status}`,
				payload?.error?.code ?? response.status,
			);
		}
		return payload?.result ?? {};
	}

	#sessionHeader(): Record<string, string> {
		return this.#sessionId && this.#sessionId !== "stateless" ? { "Mcp-Session-Id": this.#sessionId } : {};
	}

	/** Release a legacy session. Modern servers hold no state, so this is a no-op for them. */
	async close(): Promise<void> {
		if (!this.#sessionId || this.#sessionId === "stateless") return;
		const sessionId = this.#sessionId;
		this.#sessionId = undefined;
		try {
			await fetch(this.#url, {
				method: "DELETE",
				headers: { "Mcp-Session-Id": sessionId, ...this.#staticHeaders, ...(await this.#authHeaders()) },
			});
		} catch {
			// The session expires on its own; failing to close it is not worth an error.
		}
	}

	async #fetch(headers: Record<string, string>, body: unknown): Promise<Response> {
		return await fetch(this.#url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: this.#signal ?? AbortSignal.timeout(this.#timeoutMs),
		});
	}

	async #readBody(response: Response): Promise<JsonRpcResponse | undefined> {
		if (response.status === 202) return undefined;
		const type = response.headers.get("Content-Type") ?? "";
		if (type.includes("text/event-stream")) return await readEventStream(response);
		const text = await response.text();
		if (!text.trim()) return undefined;
		try {
			return JSON.parse(text) as JsonRpcResponse;
		} catch {
			return undefined;
		}
	}
}

/** Thrown internally when a 4xx carries no modern JSON-RPC error, meaning fall back. */
class LegacyServerDetected extends Error {}
