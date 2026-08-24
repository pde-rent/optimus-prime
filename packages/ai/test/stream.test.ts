import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Type } from "../src/index.js";
import { getModel, getModels } from "../src/models.js";
import { complete, stream } from "../src/stream.js";
import type { Api, Context, ImageContent, Model, Tool, ToolResultMessage } from "../src/types.js";
import { StringEnum } from "../src/utils/typebox-helpers.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

// Calculator tool definition (same as examples)
// Note: Using StringEnum helper because Google's API doesn't support anyOf/const patterns
// that Type.Enum generates. Google requires { type: "string", enum: [...] } format.
const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.",
	}),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

async function basicTextGeneration<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
	};
	const response = await complete(model, context, options);

	expect(response.role).toBe("assistant");
	expect(response.content).toBeTruthy();
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");

	context.messages.push(response);
	context.messages.push({ role: "user", content: "Now say 'Goodbye test successful'", timestamp: Date.now() });

	const secondResponse = await complete(model, context, options);

	expect(secondResponse.role).toBe("assistant");
	expect(secondResponse.content).toBeTruthy();
	expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
	expect(secondResponse.usage.output).toBeGreaterThan(0);
	expect(secondResponse.errorMessage).toBeFalsy();
	expect(secondResponse.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
		"Goodbye test successful",
	);
}

async function handleToolCall<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Calculate 15 + 27 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	const s = await stream(model, context, options);
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	let accumulatedToolArgs = "";
	let index = 0;
	for await (const event of s) {
		if (event.type === "toolcall_start") {
			hasToolStart = true;
			const toolCall = event.partial.content[event.contentIndex];
			index = event.contentIndex;
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.id).toBeTruthy();
			}
		}
		if (event.type === "toolcall_delta") {
			hasToolDelta = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
			}
		}
		if (event.type === "toolcall_end") {
			hasToolEnd = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				JSON.parse(accumulatedToolArgs);
				expect(toolCall.arguments).not.toBeUndefined();
				expect(toolCall.arguments.a).toBe(15);
				expect(toolCall.arguments.b).toBe(27);
				expect(toolCall.arguments.operation).toBeOneOf(["add", "subtract", "multiply", "divide"]);
			}
		}
	}

	expect(hasToolStart).toBe(true);
	expect(hasToolDelta).toBe(true);
	expect(hasToolEnd).toBe(true);

	const response = await s.result();
	expect(response.stopReason).toBe("toolUse");
	expect(response.content.some((b) => b.type === "toolCall")).toBeTruthy();
	const toolCall = response.content.find((b) => b.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		expect(toolCall.name).toBe("math_operation");
		expect(toolCall.id).toBeTruthy();
	} else {
		throw new Error("No tool call found in response");
	}
}

async function handleStreaming<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Context = {
		messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
		systemPrompt: "You are a helpful assistant.",
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "text_start") {
			textStarted = true;
		} else if (event.type === "text_delta") {
			textChunks += event.delta;
		} else if (event.type === "text_end") {
			textCompleted = true;
		}
	}

	const response = await s.result();

	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.content.some((b) => b.type === "text")).toBeTruthy();
}

async function handleThinking<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Context = {
		messages: [
			{
				role: "user",
				content: `Think long and hard about ${(Math.random() * 255) | 0} + 27. Think step by step. Then output the result.`,
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "thinking_start") {
			thinkingStarted = true;
		} else if (event.type === "thinking_delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking_end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(thinkingChunks.length).toBeGreaterThan(0);
	expect(thinkingCompleted).toBe(true);
	expect(response.content.some((b) => b.type === "thinking")).toBeTruthy();
}

async function handleImage<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping image test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	const imageContent: ImageContent = {
		type: "image",
		data: base64Image,
		mimeType: "image/png",
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					imageContent,
				],
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const response = await complete(model, context, options);

	// Check the response mentions red and circle
	expect(response.content.length > 0).toBeTruthy();
	const textContent = response.content.find((b) => b.type === "text");
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

async function multiTurn<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that can use tools to answer questions.",
		messages: [
			{
				role: "user",
				content: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// Collect all text content from all assistant responses
	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await complete(model, context, options);

		// Add the assistant response to context
		context.messages.push(response);

		// Process content blocks
		const results: ToolResultMessage[] = [];
		for (const block of response.content) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				expect(block.name).toBe("math_operation");
				expect(block.id).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				const { a, b, operation } = block.arguments as { a: number; b: number; operation: string };
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				// Add tool result to context
				results.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: `${result}` }],
					isError: false,
					timestamp: Date.now(),
				});
			}
		}
		context.messages.push(...results);

		// If we got a stop response with text content, we're likely done
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		if (response.stopReason === "stop") {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	expect(allTextContent).toBeTruthy();
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}
describe("Generate E2E Tests", () => {
	const text = (options?: StreamOptionsWithExtras): ProviderTestCase => ({
		name: "should complete basic text generation",
		fn: basicTextGeneration,
		options,
	});
	const toolCall = (options?: StreamOptionsWithExtras): ProviderTestCase => ({
		name: "should handle tool calling",
		fn: handleToolCall,
		options,
	});
	const streaming = (options?: StreamOptionsWithExtras): ProviderTestCase => ({
		name: "should handle streaming",
		fn: handleStreaming,
		options,
	});
	const thinking = (
		options?: StreamOptionsWithExtras,
		name = "should handle thinking",
		retry?: number,
	): ProviderTestCase => ({ name, fn: handleThinking, options, retry });
	const multiTurnCase = (
		options?: StreamOptionsWithExtras,
		name = "should handle multi-turn with thinking and tools",
		retry?: number,
	): ProviderTestCase => ({ name, fn: multiTurn, options, retry });
	const image = (options?: StreamOptionsWithExtras): ProviderTestCase => ({
		name: "should handle image input",
		fn: handleImage,
		options,
	});
	const reasoningMedium = { reasoningEffort: "medium" } satisfies StreamOptionsWithExtras;

	const openAiCompletionsModel = (): Model<"openai-completions"> => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		return { ...baseModel, api: "openai-completions" };
	};

	describeProviders([
		{
			name: "Gemini Provider (gemini-2.5-flash)",
			skipIf: !process.env.GEMINI_API_KEY,
			model: () => getModel("google", "gemini-2.5-flash"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking({ thinking: { enabled: true, budgetTokens: 1024 } }),
				multiTurnCase({ thinking: { enabled: true, budgetTokens: 2048 } }),
				image(),
			],
		},
		{
			name: "OpenAI Completions Provider (gpt-4o-mini)",
			skipIf: !process.env.OPENAI_API_KEY,
			model: openAiCompletionsModel,
			cases: [text(), toolCall(), streaming(), image()],
		},
		{
			name: "DeepSeek Provider (deepseek-v4-flash via OpenAI Completions)",
			skipIf: !process.env.DEEPSEEK_API_KEY,
			model: () => getModel("deepseek", "deepseek-v4-flash"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking({ reasoningEffort: "high" }, "should handle thinking mode"),
				multiTurnCase({ reasoningEffort: "high" }),
			],
		},
		{
			name: "OpenAI Responses Provider (gpt-5.4)",
			skipIf: !process.env.OPENAI_API_KEY,
			model: () => getModel("openai", "gpt-5.4"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking({ reasoningEffort: "high" }, undefined, 2),
				multiTurnCase({ reasoningEffort: "high" }),
				image(),
			],
		},
		{
			name: "Anthropic Provider (claude-haiku-4-5)",
			skipIf: !process.env.ANTHROPIC_API_KEY,
			model: () => getModel("anthropic", "claude-haiku-4-5"),
			cases: [text({ thinkingEnabled: true }), toolCall(), streaming(), image()],
		},
		{
			name: "Azure OpenAI Responses Provider (gpt-4o-mini)",
			skipIf: !hasAzureOpenAICredentials(),
			model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
			cases: (() => {
				const llm = getModel("azure-openai-responses", "gpt-4o-mini");
				const azureDeploymentName = resolveAzureDeploymentName(llm.id);
				const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};
				return [text(azureOptions), toolCall(azureOptions), streaming(azureOptions), image(azureOptions)];
			})(),
		},
		{
			name: "xAI Provider (grok-code-fast-1 via OpenAI Completions)",
			skipIf: !process.env.XAI_API_KEY,
			model: () => getModel("xai", "grok-code-fast-1"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium),
			],
		},
		{
			name: "Groq Provider (gpt-oss-20b via OpenAI Completions)",
			skipIf: !process.env.GROQ_API_KEY,
			model: () => getModel("groq", "openai/gpt-oss-20b"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium),
			],
		},
		{
			name: "Cerebras Provider (gpt-oss-120b via OpenAI Completions)",
			skipIf: !process.env.CEREBRAS_API_KEY,
			model: () => getModel("cerebras", "gpt-oss-120b"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium),
			],
		},
		{
			name: "Cloudflare Workers AI Provider (Kimi K2.6 via OpenAI Completions)",
			skipIf: !hasCloudflareWorkersAICredentials(),
			model: () => getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium),
			],
		},
		{
			name: "Cloudflare AI Gateway → Workers AI (Kimi K2.6 via /compat)",
			skipIf: !hasCloudflareAiGatewayCredentials(),
			model: () => getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium),
			],
		},
		{
			name: "Cloudflare AI Gateway → OpenAI BYOK (gpt-5.1 via /openai responses)",
			skipIf: !hasCloudflareAiGatewayCredentials() || !process.env.OPENAI_API_KEY,
			model: () => getModel("cloudflare-ai-gateway", "gpt-5.1"),
			cases: (() => {
				const options = { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } };
				const thinkingOptions = {
					...options,
					thinkingEnabled: true,
					reasoningEffort: "medium",
				} satisfies StreamOptionsWithExtras;
				return [
					text(options),
					toolCall(options),
					streaming(options),
					thinking(thinkingOptions, "should handle thinking mode"),
					multiTurnCase(thinkingOptions),
				];
			})(),
		},
		{
			name: "Cloudflare AI Gateway → Anthropic BYOK (Claude Sonnet 4.6 via /anthropic messages)",
			skipIf: !hasCloudflareAiGatewayCredentials() || !process.env.ANTHROPIC_API_KEY,
			model: () => {
				const llm = getModels("cloudflare-ai-gateway").find((model) => model.name === "Claude Sonnet 4.6");
				if (!llm) throw new Error("Cloudflare AI Gateway is missing Claude Sonnet 4.6");
				return llm;
			},
			cases: (() => {
				const options = { headers: { Authorization: `Bearer ${process.env.ANTHROPIC_API_KEY}` } };
				const thinkingOptions = {
					...options,
					thinkingEnabled: true,
					reasoningEffort: "high",
				} satisfies StreamOptionsWithExtras;
				return [
					text(options),
					toolCall(options),
					streaming(options),
					thinking(thinkingOptions, "should handle thinking mode"),
					multiTurnCase(thinkingOptions),
				];
			})(),
		},
		{
			name: "Hugging Face Provider (Kimi-K2.5 via OpenAI Completions)",
			skipIf: !process.env.HF_TOKEN,
			model: () => getModel("huggingface", "moonshotai/Kimi-K2.5"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium),
			],
		},

		{
			name: "NVIDIA NIM Provider (nemotron-super via OpenAI Completions)",
			skipIf: !process.env.NVIDIA_API_KEY,
			model: () => getModel("nvidia", "nvidia/llama-3.3-nemotron-super-49b-v1"),
			cases: [text(), toolCall(), streaming(), multiTurnCase()],
		},
		{
			name: "Alibaba Qwen Coding Plan Provider (qwen3.7-max via OpenAI Completions)",
			skipIf: !process.env.ALIBABA_CODING_PLAN_API_KEY,
			model: () => getModel("alibaba-coding-plan", "qwen3.7-max"),
			cases: [text(), toolCall(), streaming(), multiTurnCase()],
		},
		{
			name: "Zhipu GLM Coding Plan CN Provider (glm-5.1 via OpenAI Completions)",
			skipIf: !process.env.ZHIPU_API_KEY,
			model: () => getModel("zhipuai-coding-plan", "glm-5.1"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(),
			],
		},
		{
			name: "Tencent Coding Plan Provider (kimi-k2.5 via OpenAI Completions)",
			skipIf: !process.env.TENCENT_CODING_PLAN_API_KEY,
			model: () => getModel("tencent-coding-plan", "kimi-k2.5"),
			cases: [text(), toolCall(), streaming(), multiTurnCase()],
		},
		{
			name: "SiliconFlow Provider (MiniMax-M2.5 via OpenAI Completions)",
			skipIf: !process.env.SILICONFLOW_API_KEY,
			model: () => getModel("siliconflow", "MiniMaxAI/MiniMax-M2.5"),
			cases: [text(), toolCall(), streaming(), multiTurnCase()],
		},
		{
			name: "Together AI Provider (Kimi-K2.6 via OpenAI Completions)",
			skipIf: !process.env.TOGETHER_API_KEY,
			model: () => getModel("togetherai", "moonshotai/Kimi-K2.6"),
			cases: [text(), toolCall(), streaming(), multiTurnCase()],
		},
		{
			name: "OpenRouter Provider (glm-4.5v via OpenAI Completions)",
			skipIf: !process.env.OPENROUTER_API_KEY,
			model: () => getModel("openrouter", "z-ai/glm-4.5v"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking(reasoningMedium, "should handle thinking mode"),
				multiTurnCase(reasoningMedium, undefined, 2),
				image(),
			],
		},
		{
			name: "Nous Portal Provider (stealth/ox-alpha via OpenAI Completions)",
			skipIf: !process.env.NOUS_API_KEY,
			model: () => getModel("nous", "stealth/ox-alpha"),
			cases: [text(), toolCall(), streaming()],
		},
		{
			name: "Grok Provider (grok-4.6 via SuperGrok CLI proxy)",
			skipIf: !process.env.XAI_OAUTH_TOKEN,
			model: () => getModel("grok", "grok-4.6"),
			cases: [text(), streaming()],
		},
		{
			name: "Cursor Provider (composer-1 via Cursor subscription)",
			skipIf: !process.env.CURSOR_ACCESS_TOKEN,
			model: () => getModel("cursor", "composer-1"),
			cases: [text(), streaming()],
		},
		{
			name: "Vercel AI Gateway Provider (google/gemini-2.5-flash via Anthropic Messages)",
			skipIf: !process.env.AI_GATEWAY_API_KEY,
			model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				image(),
				multiTurnCase(undefined, "should handle multi-turn with tools"),
			],
		},
		{
			name: "Vercel AI Gateway Provider (anthropic/claude-opus-4.5 via Anthropic Messages)",
			skipIf: !process.env.AI_GATEWAY_API_KEY,
			model: () => getModel("vercel-ai-gateway", "anthropic/claude-opus-4.5"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				image(),
				multiTurnCase(undefined, "should handle multi-turn with tools"),
			],
		},
		{
			name: "Vercel AI Gateway Provider (openai/gpt-5.1-codex-max via Anthropic Messages)",
			skipIf: !process.env.AI_GATEWAY_API_KEY,
			model: () => getModel("vercel-ai-gateway", "openai/gpt-5.1-codex-max"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				image(),
				multiTurnCase(undefined, "should handle multi-turn with tools"),
			],
		},
		{
			name: "Mistral Provider (devstral-medium-latest)",
			skipIf: !process.env.MISTRAL_API_KEY,
			model: () => getModel("mistral", "devstral-medium-latest"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				{
					name: "should handle thinking mode",
					fn: async () => {
						await handleThinking(getModel("mistral", "magistral-medium-latest"), { promptMode: "reasoning" });
					},
				},
				{
					name: "should handle multi-turn with thinking and tools",
					fn: async () => {
						await multiTurn(getModel("mistral", "magistral-medium-latest"), { promptMode: "reasoning" });
					},
				},
			],
		},
		{
			name: "Mistral Provider (pixtral-12b with image support)",
			skipIf: !process.env.MISTRAL_API_KEY,
			model: () => getModel("mistral", "pixtral-12b"),
			cases: [text(), toolCall(), streaming(), image()],
		},
		{
			name: "MiniMax Provider (MiniMax-M2.7 via Anthropic Messages)",
			skipIf: !process.env.MINIMAX_API_KEY,
			model: () => getModel("minimax", "MiniMax-M2.7"),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking({ thinkingEnabled: true, thinkingBudgetTokens: 2048 }, "should handle thinking mode"),
				multiTurnCase({ thinkingEnabled: true, thinkingBudgetTokens: 2048 }),
			],
		},
		{
			name: "Kimi For Coding Provider (Anthropic Messages)",
			skipIf: !process.env.KIMI_API_KEY,
			model: () => getKimiCodingTestModel(),
			cases: [
				text(),
				toolCall(),
				streaming(),
				thinking({ thinkingEnabled: true, thinkingBudgetTokens: 2048 }, "should handle thinking mode"),
				multiTurnCase({ thinkingEnabled: true, thinkingBudgetTokens: 2048 }),
			],
		},
		...(
			[
				[
					"xiaomi",
					"Xiaomi MiMo (API billing) Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages)",
					process.env.XIAOMI_API_KEY,
				],
				[
					"xiaomi-token-plan-cn",
					"Xiaomi MiMo Token Plan Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages, CN region)",
					process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
				],
				[
					"xiaomi-token-plan-ams",
					"Xiaomi MiMo Token Plan Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages, AMS region)",
					process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
				],
				[
					"xiaomi-token-plan-sgp",
					"Xiaomi MiMo Token Plan Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages, SGP region)",
					process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
				],
			] as [
				provider: "xiaomi" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-ams" | "xiaomi-token-plan-sgp",
				name: string,
				apiKey: string | undefined,
			][]
		).map(
			([provider, name, apiKey]): ProviderSpec => ({
				name,
				skipIf: !apiKey,
				model: () => getModel(provider, "mimo-v2.5-pro"),
				cases: (() => {
					const thinkingOptions = {
						thinkingEnabled: true,
						reasoningEffort: "high",
					} satisfies StreamOptionsWithExtras;
					return [
						text(),
						toolCall(),
						streaming(),
						thinking(thinkingOptions, "should handle thinking mode"),
						multiTurnCase(thinkingOptions),
					];
				})(),
			}),
		),
		{
			name: "Anthropic OAuth Provider (claude-sonnet-4-6)",
			skipIf: false,
			model: () => getModel("anthropic", "claude-sonnet-4-6"),
			cases: [
				text({ apiKey: anthropicOAuthToken }),
				toolCall({ apiKey: anthropicOAuthToken }),
				streaming({ apiKey: anthropicOAuthToken }),
				thinking({ apiKey: anthropicOAuthToken, thinkingEnabled: true }),
				multiTurnCase({ apiKey: anthropicOAuthToken, thinkingEnabled: true }),
				image({ apiKey: anthropicOAuthToken }),
			].map((testCase) => ({ ...testCase, skipIf: !anthropicOAuthToken })),
		},
		{
			name: "Anthropic OAuth Provider (claude-opus-4-6 with adaptive thinking)",
			skipIf: false,
			model: () => getModel("anthropic", "claude-opus-4-6"),
			cases: [
				text({ apiKey: anthropicOAuthToken }),
				toolCall({ apiKey: anthropicOAuthToken }),
				streaming({ apiKey: anthropicOAuthToken }),
				thinking(
					{ apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "high" },
					"should handle adaptive thinking with effort high",
				),
				thinking(
					{ apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "medium" },
					"should handle adaptive thinking with effort medium",
				),
				multiTurnCase(
					{ apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "high" },
					"should handle multi-turn with adaptive thinking and tools",
				),
				image({ apiKey: anthropicOAuthToken }),
			].map((testCase) => ({ ...testCase, skipIf: !anthropicOAuthToken })),
		},
		{
			name: "GitHub Copilot Provider (gpt-5.3-codex via OpenAI Completions)",
			skipIf: false,
			model: () => getModel("github-copilot", "gpt-5.3-codex"),
			cases: [
				text({ apiKey: githubCopilotToken }),
				toolCall({ apiKey: githubCopilotToken }),
				streaming({ apiKey: githubCopilotToken }),
				{
					name: "should handle thinking",
					fn: async (_model: Model<Api>, options?: StreamOptionsWithExtras) => {
						await handleThinking(getModel("github-copilot", "gpt-5-mini"), {
							...options,
							reasoningEffort: "high",
						});
					},
					options: { apiKey: githubCopilotToken },
					retry: 2,
				},
				{
					name: "should handle multi-turn with thinking and tools",
					fn: async (_model: Model<Api>, options?: StreamOptionsWithExtras) => {
						await multiTurn(getModel("github-copilot", "gpt-5-mini"), { ...options, reasoningEffort: "high" });
					},
					options: { apiKey: githubCopilotToken },
				},
				image({ apiKey: githubCopilotToken }),
			].map((testCase) => ({ ...testCase, skipIf: !githubCopilotToken })),
		},
		{
			name: "GitHub Copilot Provider (claude-sonnet-4 via Anthropic Messages)",
			skipIf: false,
			model: () => getModel("github-copilot", "claude-sonnet-4.5"),
			cases: [
				text({ apiKey: githubCopilotToken }),
				toolCall({ apiKey: githubCopilotToken }),
				streaming({ apiKey: githubCopilotToken }),
				thinking({ apiKey: githubCopilotToken, thinkingEnabled: true }, undefined, 2),
				multiTurnCase({ apiKey: githubCopilotToken, thinkingEnabled: true }),
				image({ apiKey: githubCopilotToken }),
			].map((testCase) => ({ ...testCase, skipIf: !githubCopilotToken })),
		},
		{
			name: "OpenAI Codex Provider (gpt-5.4)",
			skipIf: false,
			model: () => getModel("openai-codex", "gpt-5.4"),
			cases: [
				text({ apiKey: openaiCodexToken }),
				toolCall({ apiKey: openaiCodexToken }),
				streaming({ apiKey: openaiCodexToken }),
				thinking({ apiKey: openaiCodexToken, reasoningEffort: "high" }),
				multiTurnCase({ apiKey: openaiCodexToken }),
				image({ apiKey: openaiCodexToken }),
			].map((testCase) => ({ ...testCase, skipIf: !openaiCodexToken })),
		},
		{
			name: "OpenAI Codex Provider (gpt-5.5)",
			skipIf: false,
			model: () => getModel("openai-codex", "gpt-5.5"),
			cases: [
				text({ apiKey: openaiCodexToken }),
				toolCall({ apiKey: openaiCodexToken }),
				streaming({ apiKey: openaiCodexToken }),
				thinking(
					{ apiKey: openaiCodexToken, reasoningEffort: "xhigh" },
					"should handle thinking with reasoningEffort xhigh",
				),
				multiTurnCase({ apiKey: openaiCodexToken, reasoningEffort: "xhigh" }),
				image({ apiKey: openaiCodexToken }),
			].map((testCase) => ({ ...testCase, skipIf: !openaiCodexToken })),
		},
		{
			name: "OpenAI Codex Provider (gpt-5.5 via WebSocket)",
			skipIf: false,
			model: () => getModel("openai-codex", "gpt-5.5"),
			cases: (() => {
				const wsOptions = { apiKey: openaiCodexToken, transport: "websocket" as const };
				return [
					text(wsOptions),
					toolCall(wsOptions),
					streaming(wsOptions),
					thinking(
						{ ...wsOptions, reasoningEffort: "xhigh" },
						"should handle thinking with reasoningEffort xhigh",
					),
					multiTurnCase({ ...wsOptions, reasoningEffort: "xhigh" }),
					image(wsOptions),
				].map((testCase) => ({ ...testCase, skipIf: !openaiCodexToken }));
			})(),
		},
	]);

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider (via OpenAI Completions)", () => {
		const llm = getZaiTestModel({ toolStream: true });

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, reasoningMedium);
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, reasoningMedium);
		});

		it.skipIf(!llm.input.includes("image"))("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	// Check if ollama is installed and local LLM tests are enabled
	let ollamaInstalled = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("which ollama", { stdio: "ignore" });
			ollamaInstalled = true;
		} catch {
			ollamaInstalled = false;
		}
	}

	describe.skipIf(!ollamaInstalled)("Ollama Provider (gpt-oss-20b via OpenAI Completions)", () => {
		let llm: Model<"openai-completions">;
		let ollamaProcess: ChildProcess | null = null;

		beforeAll(async () => {
			// Check if model is available, if not pull it
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch (_e) {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			ollamaProcess = spawn("ollama", ["serve"], {
				detached: false,
				stdio: "ignore",
			});

			// Wait for server to be ready
			await new Promise<void>((resolve) => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000); // Initial delay
			});

			llm = {
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				name: "Ollama GPT-OSS 20B",
			};
		}, 30000); // 30 second timeout for setup

		afterAll(() => {
			// Kill ollama server
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: "test" });
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: "test" });
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: "test" });
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: "test", reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: "test", reasoningEffort: "medium" });
		});
	});
});
