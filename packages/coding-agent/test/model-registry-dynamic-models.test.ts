import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry, setDynamicModelsFetcher } from "../src/core/model-registry.js";

function openAIListResponse(models: Array<Record<string, unknown>>) {
	return { data: models };
}

describe("ModelRegistry dynamic model discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-dynamic-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		setDynamicModelsFetcher("openrouter", undefined);
		setDynamicModelsFetcher("nous", undefined);
		setDynamicModelsFetcher("grok", undefined);

		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function modelsFor(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	test("discovery replaces static entries for a configured provider and keeps models.json models", async () => {
		authStorage.set("openrouter", { type: "api_key", key: "KEY" });
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					openrouter: {
						apiKey: "KEY",
						modelOverrides: {
							"discovered/new-model": { contextWindow: 123456 },
						},
					},
				},
			}),
		);
		setDynamicModelsFetcher("openrouter", async () =>
			openAIListResponse([
				{
					id: "discovered/new-model",
					name: "New Model",
					context_length: 200000,
					supported_parameters: ["reasoning"],
					pricing: { prompt: "0.0000015", completion: "-1" },
					top_provider: { max_completion_tokens: 8192 },
				},
			]),
		);

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const models = modelsFor(registry, "openrouter");
		expect(models.length).toBe(1);
		const model = models[0]!;
		expect(model.id).toBe("discovered/new-model");
		expect(model.name).toBe("New Model");
		expect(model.api satisfies Api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(123456);
		expect(model.maxTokens).toBe(8192);
		expect(model.cost.input).toBeCloseTo(1.5);
		expect(model.cost.output).toBe(0);
		expect(registry.getAvailable().some((m) => m.provider === "openrouter")).toBe(true);
	});

	test("fetch failure falls back to the on-disk cache", async () => {
		authStorage.set("openrouter", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("openrouter", async () =>
			openAIListResponse([{ id: "discovered/first", name: "First" }]),
		);
		const first = ModelRegistry.create(authStorage, modelsJsonPath);
		await first.refreshModelCatalog();
		expect(modelsFor(first, "openrouter").map((m) => m.id)).toEqual(["discovered/first"]);

		setDynamicModelsFetcher("openrouter", async () => {
			throw new Error("network down");
		});
		const second = ModelRegistry.create(authStorage, modelsJsonPath);
		await second.refreshModelCatalog();
		expect(modelsFor(second, "openrouter").map((m) => m.id)).toEqual(["discovered/first"]);
	});

	test("empty fetched list falls back to the previous catalog", async () => {
		authStorage.set("openrouter", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("openrouter", async () => openAIListResponse([{ id: "discovered/keep", name: "Keep" }]));
		const first = ModelRegistry.create(authStorage, modelsJsonPath);
		await first.refreshModelCatalog();

		setDynamicModelsFetcher("openrouter", async () => openAIListResponse([]));
		const second = ModelRegistry.create(authStorage, modelsJsonPath);
		await second.refreshModelCatalog();
		expect(modelsFor(second, "openrouter").map((m) => m.id)).toEqual(["discovered/keep"]);
	});

	test("skips refetching while the TTL is fresh", async () => {
		authStorage.set("openrouter", { type: "api_key", key: "KEY" });
		let calls = 0;
		setDynamicModelsFetcher("openrouter", async () => {
			calls++;
			return openAIListResponse([{ id: "discovered/once", name: "Once" }]);
		});
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		await registry.refreshModelCatalog();
		expect(calls).toBe(1);
		expect(modelsFor(registry, "openrouter").map((m) => m.id)).toEqual(["discovered/once"]);
	});

	test("does not fetch or add models for providers without configured auth", async () => {
		setDynamicModelsFetcher("nous", async () => {
			throw new Error("must not be called");
		});
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		const staticNousIds = modelsFor(registry, "nous").map((m) => m.id);
		expect(staticNousIds.length).toBeGreaterThan(0);

		authStorage.set("nous", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("nous", async () =>
			openAIListResponse([{ id: "deepconf-mini", name: "DeepConf Mini", context_length: 128000 }]),
		);
		await registry.refreshModelCatalog();
		const nous = modelsFor(registry, "nous");
		expect(nous.map((m) => m.id)).toEqual(["deepconf-mini"]);
		expect(nous[0]!.baseUrl).toBe("https://inference-api.nousresearch.com/v1");
	});

	test("authenticated discovery replaces static entries for grok when auth is configured", async () => {
		authStorage.set("grok", { type: "api_key", key: "xai-test-token" });
		setDynamicModelsFetcher("grok", async () =>
			openAIListResponse([
				{ id: "grok-4.7", name: "Grok 4.7", context_length: 500000 },
				{ id: "grok-build-0.2", name: "Grok Build 0.2", context_length: 500000 },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		const grok = modelsFor(registry, "grok");
		expect(grok.map((m) => m.id)).toEqual(["grok-4.7", "grok-build-0.2"]);
		expect(grok[0]!.api).toBe("grok-responses");
		expect(grok[0]!.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
	});
});
