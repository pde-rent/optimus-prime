import { describe, expect, it } from "bun:test";
import { getModel } from "../src/models.js";
import { complete, stream } from "../src/stream.js";
import type { Api, Context, Model } from "../src/types.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { describeProviders, type ProviderSpec, type StreamOptionsWithExtras } from "./helpers.js";
import { getKimiCodingTestModel } from "./kimi-test-model.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const [openaiCodexToken] = await Promise.all([resolveApiKey("openai-codex")]);

async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = await stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// If we get here without throwing, the abort didn't work
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();

	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

async function testAbortThenNewMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// First request: abort immediately before any response content arrives
	const controller = new AbortController();
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello, how are you?", timestamp: Date.now() }],
	};

	const abortedResponse = await complete(llm, context, { ...options, signal: controller.signal });
	expect(abortedResponse.stopReason).toBe("aborted");
	// The aborted message has empty content since we aborted before anything arrived
	expect(abortedResponse.content.length).toBe(0);

	// Add the aborted assistant message to context (this is what happens in the real coding agent)
	context.messages.push(abortedResponse);

	// Second request: send a new message - this should work even with the aborted message in context
	context.messages.push({
		role: "user",
		content: "What is 2 + 2?",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}
describe("AI Providers Abort Tests", () => {
	const spec = (
		name: string,
		skipIf: boolean,
		model: () => Model<Api>,
		options?: StreamOptionsWithExtras,
	): ProviderSpec => ({
		name,
		skipIf,
		model,
		cases: [
			{ name: "should abort mid-stream", fn: testAbortSignal, options },
			{ name: "should handle immediate abort", fn: testImmediateAbort, options },
		],
	});

	describeProviders([
		spec("Google Provider Abort", !process.env.GEMINI_API_KEY, () => getModel("google", "gemini-2.5-flash"), {
			thinking: { enabled: true },
		}),
		spec("OpenAI Completions Provider Abort", !process.env.OPENAI_API_KEY, () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
			void _compat;
			return { ...baseModel, api: "openai-completions" };
		}),
		spec("OpenAI Responses Provider Abort", !process.env.OPENAI_API_KEY, () => getModel("openai", "gpt-5-mini")),
		spec(
			"Azure OpenAI Responses Provider Abort",
			!hasAzureOpenAICredentials(),
			() => getModel("azure-openai-responses", "gpt-4o-mini"),
			(() => {
				const azureDeploymentName = resolveAzureDeploymentName(
					getModel("azure-openai-responses", "gpt-4o-mini").id,
				);
				return azureDeploymentName ? { azureDeploymentName } : {};
			})(),
		),
		{
			name: "Anthropic Provider Abort",
			skipIf: !process.env.ANTHROPIC_OAUTH_TOKEN,
			model: () => getModel("anthropic", "claude-opus-4-6"),
			cases: [
				...spec("", false, () => getModel("anthropic", "claude-opus-4-6"), {
					thinkingEnabled: true,
					thinkingBudgetTokens: 2048,
				}).cases,
				{
					// Previously exercised via Bedrock; re-pointed at Anthropic when that provider was dropped.
					name: "should recover on a new message after an abort",
					fn: testAbortThenNewMessage,
					options: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
				},
			],
		},
		spec("Mistral Provider Abort", !process.env.MISTRAL_API_KEY, () => getModel("mistral", "devstral-medium-latest")),
		spec("MiniMax Provider Abort", !process.env.MINIMAX_API_KEY, () => getModel("minimax", "MiniMax-M2.7")),
		spec("Xiaomi MiMo (API billing) Provider Abort", !process.env.XIAOMI_API_KEY, () =>
			getModel("xiaomi", "mimo-v2.5-pro"),
		),
		spec("Xiaomi MiMo Token Plan (CN) Provider Abort", !process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY, () =>
			getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
		),
		spec("Xiaomi MiMo Token Plan (AMS) Provider Abort", !process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY, () =>
			getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
		),
		spec("Xiaomi MiMo Token Plan (SGP) Provider Abort", !process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY, () =>
			getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
		),
		spec("Kimi For Coding Provider Abort", !process.env.KIMI_API_KEY, () => getKimiCodingTestModel()),
		spec("Vercel AI Gateway Provider Abort", !process.env.AI_GATEWAY_API_KEY, () =>
			getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
		),
	]);

	describe("OpenAI Codex Provider Abort", () => {
		it.skipIf(!openaiCodexToken)("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(getModel("openai-codex", "gpt-5.2-codex"), { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(getModel("openai-codex", "gpt-5.2-codex"), { apiKey: openaiCodexToken });
		});
	});
});
