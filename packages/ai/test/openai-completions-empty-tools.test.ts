import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Model } from "../src/types.js";
import { completionsStopChunk, mockOpenAIFetch, type OpenAIFetchMock } from "./openai-fetch-mock.js";

// Empty tools arrays must NOT be serialized as `tools: []` — some OpenAI-compatible
// backends (e.g. DashScope / Aliyun Qwen via compatible-mode) reject the request with
// `"[] is too short - 'tools'"` (HTTP 400) when `--no-tools` produces an empty array.
// Regression for https://github.com/earendil-works/pi-mono/issues/<issue-number>

describe("openai-completions empty tools handling", () => {
	let fetchMock: OpenAIFetchMock;

	beforeEach(() => {
		fetchMock = mockOpenAIFetch([completionsStopChunk()]);
	});

	afterEach(() => {
		fetchMock.restore();
	});

	it("omits tools field when context.tools is an empty array", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = fetchMock.lastRequest().body as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("omits tools field when context.tools is undefined", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = fetchMock.lastRequest().body as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("uses conservative OpenAI-compatible fields for Cloudflare AI Gateway /compat models", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = fetchMock.lastRequest().body as {
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			reasoning_effort?: string;
			store?: boolean;
		};
		expect(params.messages[0].role).toBe("system");
		expect(params.max_tokens).toBeDefined();
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();

		const request = fetchMock.lastRequest();
		expect(request.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat/chat/completions");
		// `Authorization: null` in the gateway defaults deletes the bearer header.
		expect(request.headers.Authorization).toBeUndefined();
		expect(request.headers["cf-aig-authorization"]).toBe("Bearer test");
	});

	it("uses OpenAI reasoning fields for an explicitly configured private Prime Inference route", async () => {
		const model: Model<"openai-completions"> = {
			id: "internal/glm-5.2-fast",
			name: "GLM 5.2 Fast",
			api: "openai-completions",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 131072,
			compat: {
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
			},
		};

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "medium" },
		).result();

		const params = fetchMock.lastRequest().body as { reasoning_effort?: string; enable_thinking?: boolean };
		expect(params.reasoning_effort).toBe("medium");
		expect(params.enable_thinking).toBeUndefined();
	});

	it("preserves inline upstream Authorization for Cloudflare AI Gateway BYOK requests", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "gpt-5.1")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "cf-token", headers: { Authorization: "Bearer upstream-token" } },
		).result();

		const { headers } = fetchMock.lastRequest();
		expect(headers.Authorization).toBe("Bearer upstream-token");
		expect(headers["cf-aig-authorization"]).toBe("Bearer cf-token");
	});

	it("sends session affinity headers for Workers AI through Cloudflare AI Gateway", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const workersModel = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			workersModel,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", sessionId: "session-1" },
		).result();

		const { headers } = fetchMock.lastRequest();
		expect(headers.session_id).toBe("session-1");
		expect(headers["x-client-request-id"]).toBe("session-1");
		expect(headers["x-session-affinity"]).toBe("session-1");
	});

	it("still emits tools: [] for Anthropic/LiteLLM proxy when conversation has tool history", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "use the tool", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "t1",
								name: "noop",
								arguments: {},
							},
						],
						stopReason: "toolUse",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "noop",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = fetchMock.lastRequest().body as { tools?: unknown[] };
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools).toEqual([]);
	});
});
