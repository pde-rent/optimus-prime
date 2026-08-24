import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getModel } from "../src/models.js";
import type { MessageCreateParamsStreaming, TextBlockParam } from "../src/providers/anthropic-wire-types.js";
import type {
	ChatCompletionCreateParamsStreaming,
	ResponseCreateParamsStreaming,
} from "../src/providers/openai-wire-types.js";
import { stream } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

function systemBlocks(payload: MessageCreateParamsStreaming | null): TextBlockParam[] {
	if (!payload || typeof payload.system === "string") {
		return [];
	}
	return payload.system ?? [];
}

describe("Cache Retention (PI_CACHE_RETENTION)", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CACHE_RETENTION = originalEnv;
		} else {
			delete process.env.PI_CACHE_RETENTION;
		}
	});

	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	describe("Anthropic Provider", () => {
		it.skipIf(!process.env.ANTHROPIC_API_KEY)(
			"should use default cache TTL (no ttl field) when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("anthropic", "claude-haiku-4-5");
				let capturedPayload: MessageCreateParamsStreaming | null = null;

				const s = stream(model, context, {
					onPayload: (payload) => {
						capturedPayload = payload as MessageCreateParamsStreaming;
					},
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				// System prompt should have cache_control without ttl
				expect(capturedPayload!.system).toBeDefined();
				expect(systemBlocks(capturedPayload)[0]?.cache_control).toEqual({ type: "ephemeral" });
			},
		);

		it.skipIf(!process.env.ANTHROPIC_API_KEY)("should use 1h cache TTL when PI_CACHE_RETENTION=long", async () => {
			process.env.PI_CACHE_RETENTION = "long";
			const model = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: MessageCreateParamsStreaming | null = null;

			const s = stream(model, context, {
				onPayload: (payload) => {
					capturedPayload = payload as MessageCreateParamsStreaming;
				},
			});

			// Consume the stream to trigger the request
			for await (const _ of s) {
				// Just consume
			}

			expect(capturedPayload).not.toBeNull();
			// System prompt should have cache_control with ttl: "1h"
			expect(capturedPayload!.system).toBeDefined();
			expect(systemBlocks(capturedPayload)[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should add ttl for non-api.anthropic.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: MessageCreateParamsStreaming | null = null;

			// We can't actually make the request (no proxy), but we can verify the payload
			// by using a mock or checking the logic directly
			// For this test, we'll import the helper directly

			// Since we can't easily test this without mocking, we'll skip the actual API call
			// and just verify the helper logic works correctly
			const { streamAnthropic } = await import("../src/providers/anthropic.js");

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "fake-key",
					onPayload: (payload) => {
						capturedPayload = payload as MessageCreateParamsStreaming;
					},
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(systemBlocks(capturedPayload)[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should omit ttl when supportsLongCacheRetention is false", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: MessageCreateParamsStreaming | null = null;

			const { streamAnthropic } = await import("../src/providers/anthropic.js");

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					onPayload: (payload) => {
						capturedPayload = payload as MessageCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(systemBlocks(capturedPayload)[0]?.cache_control).toEqual({ type: "ephemeral" });
		});

		it("should omit cache_control when cacheRetention is none", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: MessageCreateParamsStreaming | null = null;

			const { streamAnthropic } = await import("../src/providers/anthropic.js");

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					cacheRetention: "none",
					onPayload: (payload) => {
						capturedPayload = payload as MessageCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(systemBlocks(capturedPayload)[0]?.cache_control).toBeUndefined();
		});

		it("should add cache_control to string user messages", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: MessageCreateParamsStreaming | null = null;

			const { streamAnthropic } = await import("../src/providers/anthropic.js");

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					onPayload: (payload) => {
						capturedPayload = payload as MessageCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			const lastMessage = capturedPayload!.messages[capturedPayload!.messages.length - 1];
			expect(Array.isArray(lastMessage.content)).toBe(true);
			if (!Array.isArray(lastMessage.content)) {
				throw new Error("expected content blocks");
			}
			const lastContent = lastMessage.content;
			const lastBlock = lastContent[lastContent.length - 1];
			expect("cache_control" in lastBlock ? lastBlock.cache_control : undefined).toEqual({ type: "ephemeral" });
		});

		it("should set 1h cache TTL when cacheRetention is long", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: MessageCreateParamsStreaming | null = null;

			const { streamAnthropic } = await import("../src/providers/anthropic.js");

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					onPayload: (payload) => {
						capturedPayload = payload as MessageCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(systemBlocks(capturedPayload)[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});
	});

	describe("OpenAI Responses Provider", () => {
		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should not set prompt_cache_retention when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: ResponseCreateParamsStreaming | null = null;

				const s = stream(model, context, {
					onPayload: (payload) => {
						capturedPayload = payload as ResponseCreateParamsStreaming;
					},
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload!.prompt_cache_retention).toBeUndefined();
			},
		);

		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should set prompt_cache_retention to 24h when PI_CACHE_RETENTION=long",
			async () => {
				process.env.PI_CACHE_RETENTION = "long";
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: ResponseCreateParamsStreaming | null = null;

				const s = stream(model, context, {
					onPayload: (payload) => {
						capturedPayload = payload as ResponseCreateParamsStreaming;
					},
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload!.prompt_cache_retention).toBe("24h");
			},
		);

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = getModel("openai", "gpt-4o-mini");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: ResponseCreateParamsStreaming | null = null;

			const { streamOpenAIResponses } = await import("../src/providers/openai-responses.js");

			try {
				const s = streamOpenAIResponses(proxyModel, context, {
					apiKey: "fake-key",
					onPayload: (payload) => {
						capturedPayload = payload as ResponseCreateParamsStreaming;
					},
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload!.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			const model = {
				...getModel("openai", "gpt-4o-mini"),
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: ResponseCreateParamsStreaming | null = null;

			const { streamOpenAIResponses } = await import("../src/providers/openai-responses.js");

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-compat-false",
					onPayload: (payload) => {
						capturedPayload = payload as ResponseCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload!.prompt_cache_retention).toBeUndefined();
		});

		it("should omit prompt_cache_key when cacheRetention is none", async () => {
			const model = getModel("openai", "gpt-4o-mini");
			let capturedPayload: ResponseCreateParamsStreaming | null = null;

			const { streamOpenAIResponses } = await import("../src/providers/openai-responses.js");

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "none",
					sessionId: "session-1",
					onPayload: (payload) => {
						capturedPayload = payload as ResponseCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload!.prompt_cache_key).toBeUndefined();
			expect(capturedPayload!.prompt_cache_retention).toBeUndefined();
		});

		it("should set prompt_cache_retention when cacheRetention is long", async () => {
			const model = getModel("openai", "gpt-4o-mini");
			let capturedPayload: ResponseCreateParamsStreaming | null = null;

			const { streamOpenAIResponses } = await import("../src/providers/openai-responses.js");

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-2",
					onPayload: (payload) => {
						capturedPayload = payload as ResponseCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload!.prompt_cache_key).toBe("session-2");
			expect(capturedPayload!.prompt_cache_retention).toBe("24h");
		});
	});

	describe("OpenAI Completions Provider", () => {
		function createCompletionsModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
			return {
				id: "test-model",
				name: "Test Model",
				api: "openai-completions",
				provider: "test-openai-completions",
				baseUrl: "https://my-proxy.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				compat,
			};
		}

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			let capturedPayload: ChatCompletionCreateParamsStreaming | null = null;
			const { streamOpenAICompletions } = await import("../src/providers/openai-completions.js");

			try {
				const s = streamOpenAICompletions(createCompletionsModel(), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions",
					onPayload: (payload) => {
						capturedPayload = payload as ChatCompletionCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload!.prompt_cache_key).toBe("session-completions");
			expect(capturedPayload!.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			let capturedPayload: ChatCompletionCreateParamsStreaming | null = null;
			const { streamOpenAICompletions } = await import("../src/providers/openai-completions.js");

			try {
				const s = streamOpenAICompletions(createCompletionsModel({ supportsLongCacheRetention: false }), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions-false",
					onPayload: (payload) => {
						capturedPayload = payload as ChatCompletionCreateParamsStreaming;
					},
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload!.prompt_cache_key).toBeUndefined();
			expect(capturedPayload!.prompt_cache_retention).toBeUndefined();
		});
	});
});
