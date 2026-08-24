// Host side of MCP. The protocol client runs here rather than in the REPL: one
// implementation instead of a copy per skill, and credentials never enter the
// sandbox. The REPL reaches it through `mcp.*` host requests, the same way it
// reaches harness state.

import { createMcpOAuthProvider, McpClient } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
interface ResolvedIntegration {
	server: string;
	label: string;
	url: string;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	enabled?: boolean;
	/** Extra static HTTP headers from the user config. */
	headers?: Record<string, string>;
	/** Transport the entry asked for. Only http can be spoken today. */
	transport: "http" | "stdio";
	includeTools?: string[];
	excludeTools?: string[];
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private integrations = new Map<string, ResolvedIntegration>();
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private registeredUserProviderIds = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.resolveIntegrations();
		this.registerProviders();
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
		this.resolveIntegrations();
		this.registerProviders();
	}

	private providerId(server: string): string {
		return `mcp:${server}`;
	}

	private resolveIntegrations(): void {
		const integrations = new Map<string, ResolvedIntegration>();
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			// A stdio entry is kept rather than dropped. Silently skipping it made a
			// correctly configured server report as unknown, which sends the reader
			// looking for a typo instead of an unimplemented transport.
			integrations.set(server, {
				server,
				label: server,
				url: config.type === "http" ? config.url : "",
				transport: config.type,
				usesOAuth: config.type === "http" && config.oauth === true,
				bearerTokenEnvVar: config.type === "http" ? config.bearerTokenEnvVar : undefined,
				enabled: config.enabled,
				headers: config.type === "http" ? config.headers : undefined,
				includeTools: config.includeTools,
				excludeTools: config.excludeTools,
				userDeclared: true,
			});
		}
		this.integrations = integrations;
	}

	private registerProviders(): void {
		this.registerUserProviders();
	}

	/**
	 * Register OAuth providers for user-declared (non-catalog) servers. Public so it
	 * can run after ModelRegistry.refresh() resets the registry — otherwise custom
	 * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
	 */
	registerUserProviders(): void {
		const current = new Set<string>();
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared) continue;
			const id = this.providerId(integration.server);
			if (integration.usesOAuth) {
				// Register pointing at the user's URL (overrides a catalog default too).
				current.add(id);
				registerOAuthProvider(
					createMcpOAuthProvider({
						server: integration.server,
						label: integration.label,
						url: integration.url,
					}),
				);
			}
		}
		// Drop providers for user servers removed since the last registration.
		for (const id of this.registeredUserProviderIds) {
			if (!current.has(id)) unregisterOAuthProvider(id);
		}
		this.registeredUserProviderIds = current;
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.enabled === false) return false;
		if (integration.bearerTokenEnvVar && process.env[integration.bearerTokenEnvVar]?.trim()) {
			return true;
		}
		const cred = this.authStorage.get(this.providerId(integration.server));
		if (cred === undefined) return false;
		// User-declared endpoints can be retargeted, so their tokens must prove where they belong.
		// Mismatched or unbound tokens require re-login.
		if (!integration.userDeclared) return true;
		const endpoint = (cred as { endpoint?: string }).endpoint;
		return typeof endpoint === "string" && endpoint === integration.url;
	}

	/** Host-request handlers exposed to the kernel. */
	hostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
			"mcp.refresh": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.refresh requires a server");
				// getApiKey refreshes + rewrites auth.json under lock; the skill re-reads.
				// Surface failure (throw) instead of a false success so the kernel can
				// report a refresh error rather than a misleading "not enabled".
				const key = await this.authStorage.getApiKey(this.providerId(server));
				if (!key) throw new Error(`Could not refresh credentials for ${server}`);
				return {};
			},
			// Resolved config so the kernel skill connects to the same URL the host
			// registered/authenticated (honors a user's mcpServers `url` override).
			"mcp.config": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.config requires a server");
				const integration = this.integrations.get(server);
				if (!integration) return {};
				const config: Record<string, unknown> = { url: integration.url };
				if (integration.headers && Object.keys(integration.headers).length > 0) {
					config.headers = integration.headers;
				}
				return config;
			},
		};
		handlers["mcp.list_servers"] = async () => ({
			servers: Array.from(this.integrations.values()).map((integration) => ({
				server: integration.server,
				label: integration.label,
				transport: integration.transport,
				url: integration.url || undefined,
				authed: this.isAuthed(integration),
				// Stated rather than implied, so a configured server that cannot be
				// reached says why instead of looking absent.
				reachable: integration.transport === "http",
			})),
		});
		handlers["mcp.list_tools"] = async (payload) => {
			const server = String(payload.server ?? "");
			const client = await this.#clientFor(server);
			const integration = this.integrations.get(server);
			let tools = await client.listTools();
			// A server can offer dozens of tools; these keep the ones a project cares
			// about. Exclusion wins, so a broad include list stays safe to narrow.
			if (integration?.includeTools?.length) {
				const allowed = new Set(integration.includeTools);
				tools = tools.filter((tool) => allowed.has(tool.name));
			}
			if (integration?.excludeTools?.length) {
				const denied = new Set(integration.excludeTools);
				tools = tools.filter((tool) => !denied.has(tool.name));
			}
			return { tools };
		};
		handlers["mcp.call_tool"] = async (payload) => {
			const name = String(payload.tool ?? "");
			if (!name) throw new Error("mcp.call_tool requires a tool");
			const client = await this.#clientFor(String(payload.server ?? ""));
			const args = (payload.arguments ?? {}) as Record<string, unknown>;
			const schema = payload.input_schema as Record<string, unknown> | undefined;
			return { ...(await client.callTool(name, args, schema)) };
		};
		// Only expose begin_login when an interactive login is actually wired, so the
		// kernel doesn't get a handler whose only behavior is to throw.
		const beginLogin = this.beginLogin;
		if (beginLogin) {
			handlers["mcp.begin_login"] = async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.begin_login requires a server");
				await beginLogin(server);
				return {};
			};
		}
		return handlers;
	}

	/**
	 * Build a client for a configured server.
	 *
	 * A fresh client per call is cheap -- modern servers are stateless and the era
	 * probe is cached per endpoint for the process -- and it keeps a stale token or a
	 * changed configuration from persisting across a refresh.
	 */
	async #clientFor(server: string): Promise<McpClient> {
		if (!server) throw new Error("an MCP request requires a server");
		const integration = this.integrations.get(server);
		if (!integration) {
			const known = Array.from(this.integrations.keys()).join(", ");
			throw new Error(`unknown MCP server ${JSON.stringify(server)}${known ? `; configured: ${known}` : ""}`);
		}
		if (integration.transport !== "http") {
			throw new Error(
				`MCP server ${JSON.stringify(server)} is configured for ${integration.transport}, which this client cannot speak yet; only http servers are reachable`,
			);
		}
		return new McpClient({
			url: integration.url,
			headers: integration.headers,
			// Read per request so a refreshed token is picked up without rebuilding.
			getAccessToken: async () => {
				if (integration.bearerTokenEnvVar) return process.env[integration.bearerTokenEnvVar];
				const cred = this.authStorage.get(this.providerId(server));
				// A token issued for a different (or unknown) endpoint must never be sent here.
				if (cred === undefined) return undefined;
				const endpoint = (cred as { endpoint?: string }).endpoint;
				if (typeof endpoint !== "string" || endpoint !== integration.url) return undefined;
				return (await this.authStorage.getApiKey(this.providerId(server))) ?? undefined;
			},
		});
	}

	/** Status for the /mcp list command. */
	listStatus(): Array<{ server: string; label: string; enabled: boolean; usesOAuth: boolean }> {
		return Array.from(this.integrations.values()).map((integration) => ({
			server: integration.server,
			label: integration.label,
			enabled: this.isAuthed(integration),
			usesOAuth: integration.usesOAuth,
		}));
	}
}
