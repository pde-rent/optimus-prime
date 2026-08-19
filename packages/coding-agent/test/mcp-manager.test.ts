import { describe, expect, it } from "bun:test";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

// biome-ignore lint/suspicious/noExplicitAny: only the two members the manager touches
const authStorage = { get: () => undefined, getApiKey: async () => undefined } as any;

function manager(servers: Record<string, McpServerConfig>) {
	return new McpManager({ authStorage, getUserServers: () => servers });
}

describe("configured servers", () => {
	it("lists a stdio server rather than dropping it", async () => {
		// Silently skipping made a correctly configured server report as unknown, which
		// sends the reader hunting for a typo instead of an unimplemented transport.
		const handlers = manager({
			local: { type: "stdio", command: "some-mcp-server" },
			remote: { type: "http", url: "https://example.test/mcp" },
		}).hostHandlers();

		const { servers } = (await handlers["mcp.list_servers"]!({})) as {
			servers: Array<{ server: string; transport: string; reachable: boolean }>;
		};
		expect(servers.map((entry) => entry.server).sort()).toEqual(["local", "remote"]);
		expect(servers.find((entry) => entry.server === "local")).toMatchObject({
			transport: "stdio",
			reachable: false,
		});
	});

	it("says why a stdio server cannot be reached", async () => {
		const handlers = manager({ local: { type: "stdio", command: "some-mcp-server" } }).hostHandlers();

		const error = await handlers["mcp.list_tools"]!({ server: "local" }).catch((caught: Error) => caught);
		expect((error as Error).message).toContain("stdio");
		expect((error as Error).message).not.toContain("unknown MCP server");
	});

	it("names the configured servers when asked for one that does not exist", async () => {
		const handlers = manager({ remote: { type: "http", url: "https://example.test/mcp" } }).hostHandlers();

		const error = await handlers["mcp.list_tools"]!({ server: "typo" }).catch((caught: Error) => caught);
		expect((error as Error).message).toContain("unknown MCP server");
		expect((error as Error).message).toContain("remote");
	});
});

describe("tool filtering", () => {
	/** A fake MCP endpoint offering three tools. */
	function serveTools(): { url: string; stop: () => void } {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json().catch(() => ({}))) as { id?: unknown };
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [{ name: "read" }, { name: "write" }, { name: "delete" }] },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			},
		});
		return { url: server.url.href, stop: () => server.stop(true) };
	}

	async function toolsWith(filter: Partial<{ includeTools: string[]; excludeTools: string[] }>) {
		const { url, stop } = serveTools();
		try {
			const handlers = manager({ s: { type: "http", url, ...filter } }).hostHandlers();
			const { tools } = (await handlers["mcp.list_tools"]!({ server: "s" })) as { tools: Array<{ name: string }> };
			return tools.map((tool) => tool.name);
		} finally {
			stop();
		}
	}

	it("offers every tool when nothing is filtered", async () => {
		expect(await toolsWith({})).toEqual(["read", "write", "delete"]);
	});

	it("narrows to an include list", async () => {
		expect(await toolsWith({ includeTools: ["read"] })).toEqual(["read"]);
	});

	it("withholds an exclude list", async () => {
		expect(await toolsWith({ excludeTools: ["delete"] })).toEqual(["read", "write"]);
	});

	it("lets exclusion win, so a broad include list stays safe to narrow", async () => {
		expect(await toolsWith({ includeTools: ["read", "delete"], excludeTools: ["delete"] })).toEqual(["read"]);
	});
});
