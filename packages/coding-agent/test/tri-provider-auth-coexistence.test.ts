import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

/**
 * Tri-provider coexistence: Claude subscription OAuth (anthropic) + ChatGPT
 * subscription OAuth (openai-codex) + OpenCode Go API key (opencode-go) must
 * all resolve side-by-side so the main agent can delegate to one model per
 * provider from the same context. Seeded creds stand in for completed logins;
 * unexpired OAuth never touches the network.
 */
describe("tri-provider auth coexistence", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const future = () => Date.now() + 3600_000;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-tri-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.set("anthropic", { type: "oauth", refresh: "r-anth", access: "sk-ant-oat-test", expires: future() });
		authStorage.set("openai-codex", { type: "oauth", refresh: "r-codex", access: "codex-test", expires: future() });
		authStorage.set("opencode-go", { type: "api_key", key: "KEY" });
		registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("api keys resolve for all three providers at once", async () => {
		expect(await registry.getApiKeyForProvider("anthropic")).toBe("sk-ant-oat-test");
		expect(await registry.getApiKeyForProvider("openai-codex")).toBe("codex-test");
		expect(await registry.getApiKeyForProvider("opencode-go")).toBe("KEY");
	});

	test("auth preflight passes for one model per provider", async () => {
		for (const [provider, id] of [
			["anthropic", "claude-fable-5"],
			["openai-codex", "gpt-5.5"],
			["opencode-go", "kimi-k2.6"],
		] as const) {
			const model = registry.find(provider, id);
			expect(model).toBeDefined();
			const auth = await registry.getApiKeyAndHeaders(model!);
			expect(auth.ok).toBe(true);
		}
	});

	test("executable pool keeps anthropic + opencode-go models (codex needs live account check)", async () => {
		const executable = await registry.getExecutableModels();
		const ids = new Set(executable.map((m) => `${m.provider}/${m.id}`));
		expect(ids.has("anthropic/claude-fable-5")).toBe(true);
		expect(ids.has("opencode-go/kimi-k2.6")).toBe(true);
		// Static catalog still lists codex; live entitlement fetch decides executability.
		expect(registry.find("openai-codex", "gpt-5.5")).toBeDefined();
	});

	test("logout of one provider leaves the other two intact", async () => {
		authStorage.logout("openai-codex");
		expect(await registry.getApiKeyForProvider("anthropic")).toBe("sk-ant-oat-test");
		expect(await registry.getApiKeyForProvider("openai-codex")).toBeUndefined();
		expect(await registry.getApiKeyForProvider("opencode-go")).toBe("KEY");
	});

	test("opencode-go key authorizes opencode models too", async () => {
		expect(authStorage.hasAuth("opencode")).toBe(true);
		expect(await registry.getApiKeyForProvider("opencode")).toBe("KEY");
		const model = registry.find("opencode", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect((await registry.getApiKeyAndHeaders(model!)).ok).toBe(true);
	});

	test("opencode key authorizes opencode-go models too", async () => {
		authStorage.remove("opencode-go");
		authStorage.set("opencode", { type: "api_key", key: "ZEN-KEY" });
		expect(authStorage.hasAuth("opencode-go")).toBe(true);
		expect(await registry.getApiKeyForProvider("opencode-go")).toBe("ZEN-KEY");
	});
});
