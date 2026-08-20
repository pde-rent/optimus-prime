import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MODELS } from "../src/models.generated.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Model, OpenAICompletionsCompat, OpenRouterRouting } from "../src/types.js";
import { completionsStopChunk, mockOpenAIFetch, type OpenAIFetchMock } from "./openai-fetch-mock.js";

// OpenRouter multiplexes one model id across many upstream backends and names the
// one that served the request in a top-level `provider`. Without it a garbage
// response is only attributable to "openrouter", not to the backend that produced it.

function openRouterModel(routing?: OpenRouterRouting): Model<"openai-completions"> {
	return {
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...(routing ? { compat: { openRouterRouting: routing } } : {}),
	};
}

function openAIModel(routing?: OpenRouterRouting): Model<"openai-completions"> {
	return {
		id: "gpt-5.2",
		name: "GPT-5.2",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...(routing ? { compat: { openRouterRouting: routing } } : {}),
	};
}

async function run(model: Model<"openai-completions">): Promise<AssistantMessage> {
	return await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test-key" },
	).result();
}

describe("openai-completions upstream provider capture", () => {
	let fetchMock: OpenAIFetchMock;

	beforeEach(() => {
		fetchMock = mockOpenAIFetch([]);
	});

	afterEach(() => {
		fetchMock.restore();
	});

	it("captures provider and system_fingerprint from a single unstreamed chunk", async () => {
		fetchMock.events = [
			completionsStopChunk({
				id: "gen-1",
				provider: "OpenInference",
				system_fingerprint: "fp_abc123",
				choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
			}),
		];

		const message = await run(openRouterModel());

		expect(message.upstreamProvider).toBe("OpenInference");
		expect(message.systemFingerprint).toBe("fp_abc123");
		expect(message.provider).toBe("openrouter");
		expect(message.stopReason).toBe("stop");
	});

	it("captures both when they appear on the first chunk only", async () => {
		fetchMock.events = [
			{
				id: "gen-2",
				provider: "DeepInfra",
				system_fingerprint: "fp_first",
				choices: [{ index: 0, delta: { content: "he" } }],
			},
			{ id: "gen-2", choices: [{ index: 0, delta: { content: "llo" } }] },
			completionsStopChunk({ id: "gen-2" }),
		];

		const message = await run(openRouterModel());

		expect(message.upstreamProvider).toBe("DeepInfra");
		expect(message.systemFingerprint).toBe("fp_first");
	});

	it("keeps the first reported values when a later chunk reports different ones", async () => {
		fetchMock.events = [
			{ id: "gen-3", provider: "DeepInfra", system_fingerprint: "fp_first", choices: [{ index: 0, delta: {} }] },
			{ id: "gen-3", provider: "Novita", system_fingerprint: "fp_second", choices: [{ index: 0, delta: {} }] },
			completionsStopChunk({ id: "gen-3" }),
		];

		const message = await run(openRouterModel());

		expect(message.upstreamProvider).toBe("DeepInfra");
		expect(message.systemFingerprint).toBe("fp_first");
	});

	it("leaves both absent when the endpoint reports neither", async () => {
		fetchMock.events = [
			{ id: "gen-4", choices: [{ index: 0, delta: { content: "hi" } }] },
			completionsStopChunk({ id: "gen-4" }),
		];

		const message = await run(openAIModel());

		expect(message.upstreamProvider).toBeUndefined();
		expect(message.systemFingerprint).toBeUndefined();
		expect("upstreamProvider" in message).toBe(false);
		expect("systemFingerprint" in message).toBe(false);
	});
});

describe("openai-completions OpenRouter provider routing", () => {
	let fetchMock: OpenAIFetchMock;

	beforeEach(() => {
		fetchMock = mockOpenAIFetch([completionsStopChunk({ id: "gen-routing" })]);
	});

	afterEach(() => {
		fetchMock.restore();
	});

	it("sends openRouterRouting as the request `provider` field for an OpenRouter model", async () => {
		await run(openRouterModel({ ignore: ["OpenInference"], quantizations: ["fp8", "bf16"] }));

		const body = fetchMock.lastRequest().body as { provider?: OpenRouterRouting };
		expect(body.provider).toEqual({ ignore: ["OpenInference"], quantizations: ["fp8", "bf16"] });
	});

	it("omits `provider` when no routing preference is configured", async () => {
		await run(openRouterModel());

		const body = fetchMock.lastRequest().body as Record<string, unknown>;
		expect("provider" in body).toBe(false);
	});

	it("does not send `provider` to a non-OpenRouter endpoint", async () => {
		await run(openAIModel({ ignore: ["OpenInference"] }));

		const body = fetchMock.lastRequest().body as Record<string, unknown>;
		expect("provider" in body).toBe(false);
	});
});

describe("openrouter catalogue thinking format", () => {
	// OpenRouter only understands `reasoning: { effort }`. A provider-native shape
	// (DeepSeek's `thinking: { type }`, z.ai's `enable_thinking`) sent to it is a
	// silently ignored parameter, so guard the whole generated catalogue.
	it("never gives an openrouter-served model a non-openrouter thinkingFormat", () => {
		const offenders: string[] = [];
		for (const providerModels of Object.values(MODELS)) {
			for (const model of Object.values(providerModels) as Model<"openai-completions">[]) {
				if (model.provider !== "openrouter") continue;
				const thinkingFormat = (model.compat as OpenAICompletionsCompat | undefined)?.thinkingFormat;
				if (thinkingFormat && thinkingFormat !== "openrouter") {
					offenders.push(`${model.id}: ${thinkingFormat}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
