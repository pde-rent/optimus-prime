import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes only mcp.refresh when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.config", "mcp.refresh"]);

		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow("Could not refresh");
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("exposes mcp.begin_login only when beginLogin is provided", async () => {
		let called = "";
		const manager = new McpManager({
			authStorage,
			beginLogin: async (server) => {
				called = server;
			},
		});
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.begin_login", "mcp.config", "mcp.refresh"]);
		await handlers["mcp.begin_login"]({ server: "linear" });
		expect(called).toBe("linear");
	});

	it("honors a bearer-token env var for user-declared servers", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({
				authStorage,
				getUserServers: () => ({
					custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" },
				}),
			});
			const status = manager.listStatus().find((s) => s.server === "custom");
			expect(status?.enabled).toBe(true);
		} finally {
			delete process.env.MY_MCP_TOKEN;
		}
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("drops the built-in provider when a catalog name is overridden without oauth", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp" } }),
		});
		void manager;
		expect(getOAuthProvider("mcp:linear")).toBeUndefined();
	});

	it("unregisters a user server's OAuth provider when it's removed on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
		};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(getOAuthProvider("mcp:acme")).toBeDefined();

		servers = {};
		manager.refresh();
		expect(getOAuthProvider("mcp:acme")).toBeUndefined();
	});
});
