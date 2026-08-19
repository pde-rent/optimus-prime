import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { McpClient, McpError } from "../src/mcp/client.js";

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

// biome-ignore lint/suspicious/noExplicitAny: test fixtures speak raw JSON-RPC
type Body = any;

function serve(handler: (request: Request, body: Body) => Response | Promise<Response>): string {
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
			return await handler(request, body);
		},
	});
	servers.push(server);
	return server.url.href;
}

const rpc = (id: unknown, result: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		headers: { "Content-Type": "application/json" },
		...init,
	});

const rpcError = (id: unknown, code: number, message: string, data?: unknown, status = 400) =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});

describe("modern servers", () => {
	it("declares the protocol version in both the header and the body", async () => {
		let seen: { header: string | null; meta: unknown } | undefined;
		const url = serve((request, body) => {
			seen = {
				header: request.headers.get("MCP-Protocol-Version"),
				meta: body.params._meta["io.modelcontextprotocol/protocolVersion"],
			};
			return rpc(body.id, { tools: [] });
		});

		await new McpClient({ url }).listTools();
		// A server rejects the request outright when these disagree.
		expect(seen?.header).toBe("2026-07-28");
		expect(seen?.meta).toBe("2026-07-28");
	});

	it("retries once at a version the server actually supports", async () => {
		const asked: string[] = [];
		const url = serve((_request, body) => {
			asked.push(body.params._meta["io.modelcontextprotocol/protocolVersion"]);
			if (asked.length === 1) {
				return rpcError(body.id, -32022, "Unsupported protocol version", { supported: ["2025-11-25"] });
			}
			return rpc(body.id, { tools: [{ name: "ok" }] });
		});

		const tools = await new McpClient({ url }).listTools();
		expect(asked).toEqual(["2026-07-28", "2025-11-25"]);
		expect(tools.map((tool) => tool.name)).toEqual(["ok"]);
	});

	it("gives up when no version is in common, naming what the server offers", async () => {
		const url = serve((_request, body) =>
			rpcError(body.id, -32022, "Unsupported protocol version", { supported: ["1999-01-01"] }),
		);

		const error = await new McpClient({ url }).listTools().catch((caught: McpError) => caught);
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).message).toContain("1999-01-01");
	});

	it("reads a response delivered as an event stream", async () => {
		// A server may answer any request with SSE, and a client must accept both.
		const url = serve((_request, body) => {
			const frames = [
				`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}`,
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "streamed" }] } })}`,
			].join("\n\n");
			return new Response(`${frames}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		});

		expect((await new McpClient({ url }).listTools()).map((tool) => tool.name)).toEqual(["streamed"]);
	});

	it("follows pagination to the end", async () => {
		// Ignoring nextCursor silently truncates, and the missing tools then look like typos.
		const url = serve((_request, body) =>
			body.params.cursor === "second"
				? rpc(body.id, { tools: [{ name: "b" }] })
				: rpc(body.id, { tools: [{ name: "a" }], nextCursor: "second" }),
		);

		expect((await new McpClient({ url }).listTools()).map((tool) => tool.name)).toEqual(["a", "b"]);
	});
});

describe("header mirroring", () => {
	const schema = {
		type: "object",
		properties: {
			region: { type: "string", "x-mcp-header": "Region" },
			query: { type: "string" },
		},
	};

	it("mirrors an annotated parameter into its header", async () => {
		let seen: string | null = null;
		const url = serve((request, body) => {
			seen = request.headers.get("Mcp-Param-Region");
			return rpc(body.id, { content: [] });
		});

		await new McpClient({ url }).callTool("run", { region: "us-west1", query: "select 1" }, schema);
		expect(seen).toBe("us-west1");
	});

	it("base64-encodes a value that cannot travel as a header", async () => {
		let seen: string | null = null;
		const url = serve((request, body) => {
			seen = request.headers.get("Mcp-Param-Region");
			return rpc(body.id, { content: [] });
		});

		await new McpClient({ url }).callTool("run", { region: "Hello, 世界" }, schema);
		expect(seen).toBe(`=?base64?${Buffer.from("Hello, 世界", "utf8").toString("base64")}?=`);
	});

	it("omits the header when the parameter was not supplied", async () => {
		let present = true;
		const url = serve((request, body) => {
			present = request.headers.has("Mcp-Param-Region");
			return rpc(body.id, { content: [] });
		});

		await new McpClient({ url }).callTool("run", { query: "select 1" }, schema);
		expect(present).toBe(false);
	});

	it("drops a tool whose annotations are invalid instead of offering it", async () => {
		// The specification requires rejecting the tool, so one malformed definition
		// cannot take the rest of the server's tools down with it.
		const url = serve((_request, body) =>
			rpc(body.id, {
				tools: [
					{
						name: "bad",
						inputSchema: { type: "object", properties: { a: { type: "object", "x-mcp-header": "A" } } },
					},
					{ name: "good", inputSchema: { type: "object", properties: { b: { type: "string" } } } },
				],
			}),
		);

		expect((await new McpClient({ url }).listTools()).map((tool) => tool.name)).toEqual(["good"]);
	});
});

describe("legacy servers", () => {
	/** A handshake-era server: rejects modern requests, then expects initialize. */
	function legacyServer(options: { sessionId?: string } = {}) {
		const seen: string[] = [];
		const url = serve((request, body) => {
			seen.push(body.method ?? request.method);
			if (body.params?._meta?.["io.modelcontextprotocol/protocolVersion"]) {
				// How a handshake-era server answers a request it cannot parse: a bare 4xx.
				return new Response("Bad Request", { status: 400 });
			}
			if (body.method === "initialize") {
				const headers: Record<string, string> = { "Content-Type": "application/json" };
				if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }),
					{ headers },
				);
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			return rpc(body.id, { tools: [{ name: "legacy-tool" }] });
		});
		return { url, seen };
	}

	it("falls back to the handshake when a bare 4xx comes back", async () => {
		const { url, seen } = legacyServer();
		const tools = await new McpClient({ url }).listTools();

		expect(tools.map((tool) => tool.name)).toEqual(["legacy-tool"]);
		// Probed modern, fell back, handshook, then asked.
		expect(seen).toEqual(["tools/list", "initialize", "notifications/initialized", "tools/list"]);
	});

	it("carries the session id the handshake minted", async () => {
		let seenSession: string | null = null;
		const seen: string[] = [];
		const url = serve((request, body) => {
			seen.push(body.method ?? request.method);
			if (body.params?._meta) return new Response("nope", { status: 400 });
			if (body.method === "initialize") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
					headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" },
				});
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			seenSession = request.headers.get("Mcp-Session-Id");
			return rpc(body.id, { tools: [] });
		});

		await new McpClient({ url }).listTools();
		expect(seenSession).toBe("sess-1");
	});

	it("does not re-probe the modern path once an endpoint is known to be legacy", async () => {
		const { url, seen } = legacyServer();
		const client = new McpClient({ url });
		await client.listTools();
		const afterFirst = seen.length;
		await client.listTools();

		// One request for the second call, not another probe and handshake.
		expect(seen.length - afterFirst).toBe(1);
	});
});
