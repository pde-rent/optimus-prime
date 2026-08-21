import { describe, expect } from "bun:test";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, UserMessage } from "../src/types.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import {
	describeProviders,
	type ProviderSpec,
	type ProviderTestCase,
	type StreamOptionsWithExtras,
} from "./helpers.js";
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

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with completely empty content array
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	// Should either handle gracefully or return an error
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty string content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with whitespace-only content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle whitespace-only gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty assistant message in conversation flow
	// User -> Empty Assistant -> User
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty assistant message in context gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}
describe("AI Providers Empty Message Tests", () => {
	const emptyCases = (options?: StreamOptionsWithExtras): ProviderTestCase[] => [
		{ name: "should handle empty content array", fn: testEmptyMessage, options },
		{ name: "should handle empty string content", fn: testEmptyStringMessage, options },
		{ name: "should handle whitespace-only content", fn: testWhitespaceOnlyMessage, options },
		{ name: "should handle empty assistant message in conversation", fn: testEmptyAssistantMessage, options },
	];
	const spec = (
		name: string,
		skipIf: boolean,
		model: () => Model<Api>,
		options?: StreamOptionsWithExtras,
	): ProviderSpec => ({
		name,
		skipIf,
		model,
		cases: emptyCases(options).map((testCase) => ({ ...testCase, timeout: 30000 })),
	});

	describeProviders([
		spec("Google Provider Empty Messages", !process.env.GEMINI_API_KEY, () => getModel("google", "gemini-2.5-flash")),
		spec("OpenAI Completions Provider Empty Messages", !process.env.OPENAI_API_KEY, () =>
			getModel("openai", "gpt-4o-mini"),
		),
		spec("OpenAI Responses Provider Empty Messages", !process.env.OPENAI_API_KEY, () =>
			getModel("openai", "gpt-5-mini"),
		),
		spec(
			"Azure OpenAI Responses Provider Empty Messages",
			!hasAzureOpenAICredentials(),
			() => getModel("azure-openai-responses", "gpt-4o-mini"),
			(() => {
				const azureDeploymentName = resolveAzureDeploymentName(
					getModel("azure-openai-responses", "gpt-4o-mini").id,
				);
				return azureDeploymentName ? { azureDeploymentName } : {};
			})(),
		),
		spec("Anthropic Provider Empty Messages", !process.env.ANTHROPIC_API_KEY, () =>
			getModel("anthropic", "claude-haiku-4-5"),
		),
		spec("xAI Provider Empty Messages", !process.env.XAI_API_KEY, () => getModel("xai", "grok-4.3")),
		spec("Groq Provider Empty Messages", !process.env.GROQ_API_KEY, () => getModel("groq", "openai/gpt-oss-20b")),
		spec("Cerebras Provider Empty Messages", !process.env.CEREBRAS_API_KEY, () =>
			getModel("cerebras", "gpt-oss-120b"),
		),
		spec("Cloudflare Workers AI Provider Empty Messages", !hasCloudflareWorkersAICredentials(), () =>
			getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
		),
		spec("Cloudflare AI Gateway Provider Empty Messages", !hasCloudflareAiGatewayCredentials(), () =>
			getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
		),
		spec("Hugging Face Provider Empty Messages", !process.env.HF_TOKEN, () =>
			getModel("huggingface", "moonshotai/Kimi-K2.5"),
		),
		spec("zAI Provider Empty Messages", !process.env.ZAI_API_KEY, () => getZaiTestModel()),
		spec("Mistral Provider Empty Messages", !process.env.MISTRAL_API_KEY, () =>
			getModel("mistral", "devstral-medium-latest"),
		),
		spec("MiniMax Provider Empty Messages", !process.env.MINIMAX_API_KEY, () => getModel("minimax", "MiniMax-M2.7")),
		spec("Xiaomi MiMo (API billing) Provider Empty Messages", !process.env.XIAOMI_API_KEY, () =>
			getModel("xiaomi", "mimo-v2.5-pro"),
		),
		spec("Xiaomi MiMo Token Plan (CN) Provider Empty Messages", !process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY, () =>
			getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
		),
		spec("Xiaomi MiMo Token Plan (AMS) Provider Empty Messages", !process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY, () =>
			getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
		),
		spec("Xiaomi MiMo Token Plan (SGP) Provider Empty Messages", !process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY, () =>
			getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
		),
		spec("Kimi For Coding Provider Empty Messages", !process.env.KIMI_API_KEY, () => getKimiCodingTestModel()),
		spec("Vercel AI Gateway Provider Empty Messages", !process.env.AI_GATEWAY_API_KEY, () =>
			getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
		),
		{
			name: "Anthropic OAuth Provider Empty Messages",
			skipIf: false,
			model: () => getModel("anthropic", "claude-haiku-4-5"),
			cases: emptyCases({ apiKey: anthropicOAuthToken }).map((testCase) => ({
				...testCase,
				timeout: 30000,
				skipIf: !anthropicOAuthToken,
			})),
		},
		{
			name: "GitHub Copilot Provider Empty Messages",
			skipIf: false,
			model: () => getModel("github-copilot", "gpt-5-mini"),
			cases: emptyCases({ apiKey: githubCopilotToken })
				.map((testCase) => ({ ...testCase, timeout: 30000, skipIf: !githubCopilotToken }))
				.map((testCase) => ({ ...testCase, name: `gpt-5-mini - ${testCase.name}` })),
		},
		{
			name: "GitHub Copilot Provider Empty Messages",
			skipIf: false,
			model: () => getModel("github-copilot", "claude-sonnet-4.5"),
			cases: emptyCases({ apiKey: githubCopilotToken })
				.map((testCase) => ({ ...testCase, timeout: 30000, skipIf: !githubCopilotToken }))
				.map((testCase) => ({ ...testCase, name: `claude-sonnet-4 - ${testCase.name}` })),
		},
		{
			name: "OpenAI Codex Provider Empty Messages",
			skipIf: false,
			model: () => getModel("openai-codex", "gpt-5.2-codex"),
			cases: emptyCases({ apiKey: openaiCodexToken })
				.map((testCase) => ({ ...testCase, timeout: 30000, skipIf: !openaiCodexToken }))
				.map((testCase) => ({ ...testCase, name: `gpt-5.2-codex - ${testCase.name}` })),
		},
	]);
});
