import { describe, expect } from "bun:test";
import { getModel } from "../src/models.js";
import { stream } from "../src/stream.js";
import type { Api, Context, Model } from "../src/types.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { describeProviders, type ProviderSpec, type StreamOptionsWithExtras } from "./helpers.js";
import { getKimiCodingTestModel } from "./kimi-test-model.js";
import { resolveApiKey } from "./oauth.js";
import { getZaiTestModel } from "./zai-test-model.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// OpenAI providers, OpenAI Codex, and zai only send usage in the final chunk,
	// so when aborted they have no token stats. Anthropic and Google send usage information early in the stream.
	// MiniMax and Kimi report input tokens but not output tokens differently on aborted requests.
	if (
		llm.api === "openai-completions" ||
		llm.api === "mistral-conversations" ||
		llm.api === "openai-responses" ||
		llm.api === "azure-openai-responses" ||
		llm.api === "openai-codex-responses" ||
		llm.provider === "zai" ||
		llm.provider === "vercel-ai-gateway"
	) {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "minimax") {
		// MiniMax M2.7 does not report token usage for aborted requests.
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "kimi-coding") {
		// Kimi reports input tokens early but output tokens only in the final chunk.
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);

		// Some providers (Copilot) have zero cost rates
		if (llm.cost.input > 0) {
			expect(msg.usage.cost.input).toBeGreaterThan(0);
			expect(msg.usage.cost.total).toBeGreaterThan(0);
		}
	}
}
describe("Token Statistics on Abort", () => {
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
			{
				name: "should include token stats when aborted mid-stream",
				fn: testTokensOnAbort,
				options,
				timeout: 30000,
			},
		],
	});

	describeProviders([
		spec("Google Provider", !process.env.GEMINI_API_KEY, () => getModel("google", "gemini-2.5-flash"), {
			thinking: { enabled: true },
		}),
		spec("OpenAI Completions Provider", !process.env.OPENAI_API_KEY, () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
			void _compat;
			return { ...baseModel, api: "openai-completions" };
		}),
		spec("OpenAI Responses Provider", !process.env.OPENAI_API_KEY, () => getModel("openai", "gpt-5.4-mini"), {
			reasoningEffort: "low",
		}),
		spec(
			"Azure OpenAI Responses Provider",
			!hasAzureOpenAICredentials(),
			() => getModel("azure-openai-responses", "gpt-4o-mini"),
			(() => {
				const azureDeploymentName = resolveAzureDeploymentName(
					getModel("azure-openai-responses", "gpt-4o-mini").id,
				);
				return azureDeploymentName ? { azureDeploymentName } : {};
			})(),
		),
		spec("Anthropic Provider", !process.env.ANTHROPIC_API_KEY, () => getModel("anthropic", "claude-sonnet-4-6")),
		spec("xAI Provider", !process.env.XAI_API_KEY, () => getModel("xai", "grok-4.3")),
		spec("Groq Provider", !process.env.GROQ_API_KEY, () => getModel("groq", "openai/gpt-oss-20b")),
		spec("Cerebras Provider", !process.env.CEREBRAS_API_KEY, () => getModel("cerebras", "gpt-oss-120b")),
		spec("Cloudflare Workers AI Provider", !hasCloudflareWorkersAICredentials(), () =>
			getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
		),
		spec("Cloudflare AI Gateway Provider", !hasCloudflareAiGatewayCredentials(), () =>
			getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
		),
		spec("Hugging Face Provider", !process.env.HF_TOKEN, () => getModel("huggingface", "moonshotai/Kimi-K2.5")),
		spec("zAI Provider", !process.env.ZAI_API_KEY, () => getZaiTestModel()),
		spec("Mistral Provider", !process.env.MISTRAL_API_KEY, () => getModel("mistral", "devstral-medium-latest")),
		spec("MiniMax Provider", !process.env.MINIMAX_API_KEY, () => getModel("minimax", "MiniMax-M2.7")),
		spec("Kimi For Coding Provider", !process.env.KIMI_API_KEY, () => getKimiCodingTestModel()),
		spec("Vercel AI Gateway Provider", !process.env.AI_GATEWAY_API_KEY, () =>
			getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
		),
		// FIXME(xiaomi): Xiaomi's Anthropic-compatible stream does not populate
		// usage in the message_start event the way Anthropic does — usage only
		// arrives at message_stop. Aborting mid-stream therefore loses input/output
		// token counts. Non-streaming usage works (see total-tokens.test.ts).
		// Re-enable once upstream sends usage in message_start. The same upstream
		// streaming usage limitation applies to the Token Plan endpoints.
		...(
			[
				["Xiaomi MiMo (API billing) Provider", "xiaomi", process.env.XIAOMI_API_KEY],
				["Xiaomi MiMo Token Plan (CN) Provider", "xiaomi-token-plan-cn", process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY],
				[
					"Xiaomi MiMo Token Plan (AMS) Provider",
					"xiaomi-token-plan-ams",
					process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
				],
				[
					"Xiaomi MiMo Token Plan (SGP) Provider",
					"xiaomi-token-plan-sgp",
					process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
				],
			] as [
				name: string,
				provider: "xiaomi" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-ams" | "xiaomi-token-plan-sgp",
				apiKey: string | undefined,
			][]
		).map(([name, provider, apiKey]) => {
			const s = spec(name, !apiKey, () => getModel(provider, "mimo-v2.5-pro"));
			s.cases[0].skip = true;
			return s;
		}),
		{
			name: "Anthropic OAuth Provider",
			skipIf: false,
			model: () => getModel("anthropic", "claude-sonnet-4-6"),
			cases: [
				{
					name: "should include token stats when aborted mid-stream",
					fn: testTokensOnAbort,
					options: { apiKey: anthropicOAuthToken },
					timeout: 30000,
					skipIf: !anthropicOAuthToken,
				},
			],
		},
		{
			name: "GitHub Copilot Provider",
			skipIf: false,
			model: () => getModel("github-copilot", "gpt-5-mini"),
			cases: [
				{
					name: "gpt-5-mini - should include token stats when aborted mid-stream",
					fn: testTokensOnAbort,
					options: { apiKey: githubCopilotToken },
					timeout: 30000,
					skipIf: !githubCopilotToken,
				},
			],
		},
		{
			name: "GitHub Copilot Provider",
			skipIf: false,
			model: () => getModel("github-copilot", "claude-sonnet-4.5"),
			cases: [
				{
					name: "claude-sonnet-4 - should include token stats when aborted mid-stream",
					fn: testTokensOnAbort,
					options: { apiKey: githubCopilotToken },
					timeout: 30000,
					skipIf: !githubCopilotToken,
				},
			],
		},
		{
			name: "OpenAI Codex Provider",
			skipIf: false,
			model: () => getModel("openai-codex", "gpt-5.2-codex"),
			cases: [
				{
					name: "gpt-5.2-codex - should include token stats when aborted mid-stream",
					fn: testTokensOnAbort,
					options: { apiKey: openaiCodexToken },
					timeout: 30000,
					skipIf: !openaiCodexToken,
				},
			],
		},
	]);
});
