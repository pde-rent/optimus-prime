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
		setDynamicModelsFetcher("groq", undefined);
		setDynamicModelsFetcher("anthropic", undefined);
		setDynamicModelsFetcher("alibaba-coding-plan", undefined);
		setDynamicModelsFetcher("github-copilot", undefined);
		setDynamicModelsFetcher("mistral", undefined);
		setDynamicModelsFetcher("kimi-coding", undefined);
		setDynamicModelsFetcher("huggingface", undefined);
		setDynamicModelsFetcher("groq", undefined);
		setDynamicModelsFetcher("togetherai", undefined);

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

	test("cursor discovery maps AvailableModels entries and keeps curated metadata", async () => {
		authStorage.set("cursor", { type: "api_key", key: "TOKEN" });
		const availableModels = {
			models: [
				{
					name: "composer-2",
					defaultOn: true,
					supportsThinking: true,
					supportsImages: false,
					contextTokenLimit: 300000,
				},
				{ name: "claude-4.5-sonnet", supportsImages: true },
			],
		};
		const body = new Uint8Array(5 + new TextEncoder().encode(JSON.stringify(availableModels)).length);
		new DataView(body.buffer).setUint32(1, body.length - 5);
		body.set(new TextEncoder().encode(JSON.stringify(availableModels)), 5);
		const restoreFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
		try {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.refreshModelCatalog();

			const cursor = modelsFor(registry, "cursor");
			expect(cursor.map((m) => m.id)).toEqual(["composer-2", "claude-4.5-sonnet"]);
			const added = cursor.find((m) => m.id === "composer-2")!;
			expect(added.api).toBe("cursor-connect");
			expect(added.baseUrl).toBe("https://api2.cursor.sh");
			expect(added.reasoning).toBe(true);
			expect(added.contextWindow).toBe(300000);
			// Known static id keeps its curated catalog entry.
			const curated = cursor.find((m) => m.id === "claude-4.5-sonnet")!;
			expect(curated.name).toBe("Claude 4.5 Sonnet");
		} finally {
			globalThis.fetch = restoreFetch;
		}
	});

	test("discovery keeps curated metadata for known ids and drops removed ones", async () => {
		authStorage.set("groq", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("groq", async () =>
			openAIListResponse([
				// Known static id: payload has no pricing or reasoning info, the
				// curated catalog entry must survive intact.
				{ id: "openai/gpt-oss-20b", name: "gpt-oss-20b" },
				// Unknown id: parsed defaults apply.
				{ id: "brand-new-model", name: "Brand New Model", context_length: 64000 },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const groq = modelsFor(registry, "groq");
		expect(groq.map((m) => m.id)).toEqual(["openai/gpt-oss-20b", "brand-new-model"]);
		const curated = groq.find((m) => m.id === "openai/gpt-oss-20b")!;
		expect(curated.name).toBe("GPT OSS 20B");
		expect(curated.reasoning).toBe(true);
		expect(curated.contextWindow).toBe(131072);
		expect(curated.cost.input).toBeCloseTo(0.075);
		// Static ids absent from the discovery response are gone.
		expect(groq.some((m) => m.id === "llama-3.1-8b-instant")).toBe(false);
		const added = groq.find((m) => m.id === "brand-new-model")!;
		expect(added.api).toBe("openai-completions");
		expect(added.baseUrl).toBe("https://api.groq.com/openai/v1");
		expect(added.contextWindow).toBe(64000);
	});

	test("discovery maps architecture modalities when present and omits output when absent", async () => {
		authStorage.set("nous", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("nous", async () =>
			openAIListResponse([
				{
					id: "gemini-image-pro",
					name: "Gemini Image Pro",
					context_length: 1000000,
					architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
				},
				{ id: "plain-text", name: "Plain Text", context_length: 128000 },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		const nous = modelsFor(registry, "nous");
		const imageModel = nous.find((m) => m.id === "gemini-image-pro");
		expect(imageModel?.input).toEqual(["text", "image"]);
		expect(imageModel?.output).toEqual(["text", "image"]);
		const plain = nous.find((m) => m.id === "plain-text");
		expect(plain?.input).toEqual(["text"]);
		expect(plain?.output).toBeUndefined();
	});

	test("anthropic discovery maps display_name entries", async () => {
		authStorage.set("anthropic", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("anthropic", async () =>
			openAIListResponse([
				{ type: "model", id: "claude-test-9", display_name: "Claude Test 9" },
				{ type: "model", id: "claude-test-8", display_name: "Claude Test 8" },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const anthropic = modelsFor(registry, "anthropic");
		expect(anthropic.map((m) => m.id)).toEqual(["claude-test-9", "claude-test-8"]);
		expect(anthropic[0]!.name).toBe("Claude Test 9");
		expect(anthropic[0]!.api satisfies Api).toBe("anthropic-messages");
		expect(anthropic[0]!.baseUrl).toBe("https://api.anthropic.com");
		// Static ids absent from discovery are dropped.
		expect(anthropic.some((m) => m.id.startsWith("claude-opus"))).toBe(false);
	});

	test("google discovery parses the bespoke catalog and strips the models/ prefix", async () => {
		authStorage.set("google", { type: "api_key", key: "KEY" });
		const restoreFetch = globalThis.fetch;
		// Other configured providers may refresh in parallel with google; record
		// headers per URL so their requests cannot clobber google's.
		const headersByUrl = new Map<string, Record<string, string>>();
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			headersByUrl.set(String(url), (init?.headers ?? {}) as Record<string, string>);
			return new Response(
				JSON.stringify({
					models: [
						// Known static id: curated catalog metadata must survive.
						{
							name: "models/gemini-2.5-flash",
							displayName: "wrong display name",
							supportedGenerationMethods: ["generateContent"],
						},
						{
							name: "models/gemini-test-fresh",
							displayName: "Gemini Test Fresh",
							inputTokenLimit: 1000000,
							outputTokenLimit: 65536,
							supportedGenerationMethods: ["generateContent", "countTokens"],
						},
						{
							name: "models/text-embedding-test",
							supportedGenerationMethods: ["embedContent"],
						},
					],
				}),
				{ status: 200 },
			) as Response;
		}) as typeof fetch;
		try {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.refreshModelCatalog();

			const googleHeaders = headersByUrl.get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100");
			expect(googleHeaders?.["x-goog-api-key"]).toBe("KEY");
			const google = modelsFor(registry, "google");
			expect(google.map((m) => m.id)).toContain("gemini-test-fresh");
			expect(google.some((m) => m.id.startsWith("text-embedding"))).toBe(false);
			// Discovered id enriches against the static catalog via the bare name.
			const staticGemini = google.find((m) => m.id === "gemini-2.5-flash");
			expect(staticGemini?.name).toBe("Gemini 2.5 Flash");
			const added = google.find((m) => m.id === "gemini-test-fresh")!;
			expect(added.name).toBe("Gemini Test Fresh");
			expect(added.api satisfies Api).toBe("google-generative-ai");
			expect(added.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
			expect(added.contextWindow).toBe(1000000);
			expect(added.maxTokens).toBe(65536);
		} finally {
			globalThis.fetch = restoreFetch;
		}
	});

	test("alibaba-coding-plan discovery maps OpenAI-shaped entries onto the coding endpoint", async () => {
		authStorage.set("alibaba-coding-plan", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("alibaba-coding-plan", async () =>
			openAIListResponse([{ id: "qwen-test-next", object: "model", ownedBy: "system" }]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const alibaba = modelsFor(registry, "alibaba-coding-plan");
		expect(alibaba.map((m) => m.id)).toEqual(["qwen-test-next"]);
		expect(alibaba[0]!.api satisfies Api).toBe("openai-completions");
		expect(alibaba[0]!.baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
		// Unknown ids fall back to the id for the missing name field.
		expect(alibaba[0]!.name).toBe("qwen-test-next");
	});

	test("duplicate ids in the discovery payload collapse to one entry (GMI free+paid)", async () => {
		authStorage.set("gmi", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("gmi", async () =>
			openAIListResponse([
				{ id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3 (free)", is_free: true, context_length: 1048576 },
				{ id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", is_free: false, context_length: 1048576 },
				{ id: "other-model", name: "Other" },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const gmi = modelsFor(registry, "gmi");
		expect(gmi.map((m) => m.id)).toEqual(["MiniMaxAI/MiniMax-M3", "other-model"]);
		// Known id keeps its curated catalog name over the discovery payload's.
		expect(gmi[0]!.name).toBe("MiniMax M3");
	});

	test("github-copilot discovery keeps chat models and reads capability limits", async () => {
		authStorage.set("github-copilot", { type: "api_key", key: "TOKEN" });
		setDynamicModelsFetcher("github-copilot", async () =>
			openAIListResponse([
				{
					id: "gpt-test-9",
					name: "GPT Test 9",
					capabilities: {
						type: "chat",
						limits: { max_context_window_tokens: 200000, max_output_tokens: 32000 },
					},
				},
				{ id: "text-embedding-test", capabilities: { type: "embeddings" } },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const copilot = modelsFor(registry, "github-copilot");
		expect(copilot.some((m) => m.id === "text-embedding-test")).toBe(false);
		const added = copilot.find((m) => m.id === "gpt-test-9")!;
		expect(added.name).toBe("GPT Test 9");
		expect(added.baseUrl).toBe("https://api.individual.githubcopilot.com");
		expect(added.contextWindow).toBe(200000);
		expect(added.maxTokens).toBe(32000);
	});

	test("discovery accepts top-level arrays and reads anthropic + kimi metadata", async () => {
		authStorage.set("mistral", { type: "api_key", key: "KEY" });
		authStorage.set("kimi-coding", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("mistral", async () => [
			{ id: "mistral-test-chat", max_context_length: 131072, capabilities: { completion_chat: true } },
			{ id: "ft:test-tune", max_context_length: 32768 },
			{ id: "mistral-embed-test", max_context_length: 8192 },
		]);
		setDynamicModelsFetcher("kimi-coding", async () =>
			openAIListResponse([
				{ id: "kimi-test", context_length: 262144, supports_reasoning: true, supports_image_in: false },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const mistral = modelsFor(registry, "mistral");
		expect(mistral.map((m) => m.id)).toContain("mistral-test-chat");
		expect(mistral.find((m) => m.id === "mistral-test-chat")!.contextWindow).toBe(131072);
		const kimi = modelsFor(registry, "kimi-coding");
		expect(kimi[0]!.reasoning).toBe(true);
		expect(kimi[0]!.contextWindow).toBe(262144);
	});

	test("discovery aggregates huggingface provider serving data", async () => {
		authStorage.set("huggingface", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("huggingface", async () =>
			openAIListResponse([
				{
					id: "hf-test-model",
					providers: [
						{ status: "error", context_length: 1000 },
						{ status: "ok", context_length: 128000, pricing: { input: 0.0000002, output: 0.0000008 } },
					],
				},
				{ id: "hf-broken-model", providers: [{ status: "error" }] },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		const hf = modelsFor(registry, "huggingface");
		const added = hf.find((m) => m.id === "hf-test-model")!;
		expect(added.contextWindow).toBe(128000);
		expect(added.cost.input).toBeCloseTo(0.2, 5);
		expect(added.cost.output).toBeCloseTo(0.8, 5);
	});

	test("discovery filters groq inactive entries and together non-chat types", async () => {
		authStorage.set("groq", { type: "api_key", key: "KEY" });
		authStorage.set("togetherai", { type: "api_key", key: "KEY" });
		setDynamicModelsFetcher("groq", async () =>
			openAIListResponse([
				{ id: "groq-active", active: true, context_window: 131072 },
				{ id: "groq-retired", active: false, context_window: 32768 },
			]),
		);
		setDynamicModelsFetcher("togetherai", async () =>
			openAIListResponse([
				{ id: "together-chat", type: "chat" },
				{ id: "together-embed", type: "embedding" },
			]),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();

		expect(modelsFor(registry, "groq").map((m) => m.id)).toEqual(["groq-active"]);
		expect(modelsFor(registry, "groq")[0]!.contextWindow).toBe(131072);
		expect(modelsFor(registry, "togetherai").map((m) => m.id)).toEqual(["together-chat"]);
	});

	test("offline mode applies cache without fetching", async () => {
		process.env.PI_OFFLINE = "1";
		try {
			authStorage.set("nous", { type: "api_key", key: "KEY" });
			let fetched = false;
			setDynamicModelsFetcher("nous", async () => {
				fetched = true;
				return openAIListResponse([{ id: "nous-live" }]);
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.refreshModelCatalog();
			expect(fetched).toBe(false);
			// Static catalog still seeds while offline; live id must be absent.
			expect(modelsFor(registry, "nous").some((m) => m.id === "nous-live")).toBe(false);
		} finally {
			delete process.env.PI_OFFLINE;
			setDynamicModelsFetcher("nous", undefined);
		}
	});
});
