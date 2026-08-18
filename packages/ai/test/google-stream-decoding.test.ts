import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamGoogle } from "../src/providers/google.js";
import type { Context } from "../src/types.js";

/**
 * Offline coverage for the Gemini API wire protocol: the provider posts to
 * `models/<id>:streamGenerateContent?alt=sse` itself, so this pins the request
 * URL/body split and the SSE decoding (text, thought, function call, usage).
 */

interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, any>;
}

const SIGNATURE = "c2lnbmF0dXJl";

const SSE_CHUNKS: Record<string, unknown>[] = [
	{
		responseId: "resp-1",
		candidates: [{ content: { role: "model", parts: [{ text: "let me think", thought: true }] } }],
	},
	{
		candidates: [
			{ content: { role: "model", parts: [{ text: " harder", thought: true, thoughtSignature: SIGNATURE }] } },
		],
	},
	{ candidates: [{ content: { role: "model", parts: [{ text: "Hi there" }] } }] },
	{
		candidates: [
			{
				content: {
					role: "model",
					parts: [{ functionCall: { id: "call-1", name: "get_time", args: { tz: "UTC" } } }],
				},
			},
		],
	},
	{
		candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }],
		usageMetadata: {
			promptTokenCount: 20,
			cachedContentTokenCount: 5,
			candidatesTokenCount: 8,
			thoughtsTokenCount: 3,
			totalTokenCount: 31,
		},
	},
];

function stubFetch(chunks: Record<string, unknown>[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string> | undefined) },
			body: JSON.parse(String(init?.body)),
		});
		const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	return requests;
}

function makeContext(): Context {
	return {
		systemPrompt: "Be brief.",
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		tools: [{ name: "get_time", description: "Get the time", parameters: { type: "object", properties: {} } }],
	};
}

describe("Gemini streaming (offline)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts a split config body and decodes the SSE stream", async () => {
		const requests = stubFetch(SSE_CHUNKS);
		const model = getModel("google", "gemini-2.5-flash");

		const message = await streamGoogle(model, makeContext(), {
			apiKey: "test-key",
			maxTokens: 256,
			temperature: 0,
			toolChoice: "auto",
			thinking: { enabled: true, budgetTokens: 1024 },
		}).result();

		expect(message.stopReason, message.errorMessage).toBe("toolUse");

		const request = requests[0];
		expect(request.method).toBe("POST");
		expect(request.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(request.headers["x-goog-api-key"]).toBe("test-key");
		// `systemInstruction` / `tools` / `toolConfig` are lifted out of `generationConfig`.
		expect(request.body.systemInstruction).toEqual({ role: "user", parts: [{ text: "Be brief." }] });
		expect(request.body.tools[0].functionDeclarations[0].name).toBe("get_time");
		expect(request.body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
		expect(request.body.generationConfig).toEqual({
			temperature: 0,
			maxOutputTokens: 256,
			thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
		});
		// `model` lives in the URL, and the abort signal is never serialized.
		expect(request.body.model).toBeUndefined();
		expect(request.body.generationConfig.abortSignal).toBeUndefined();
		expect(request.body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);

		expect(message.responseId).toBe("resp-1");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "let me think harder", thinkingSignature: SIGNATURE },
			{ type: "text", text: "Hi there", textSignature: undefined },
			{ type: "toolCall", id: "call-1", name: "get_time", arguments: { tz: "UTC" } },
		]);
		expect(message.usage.input).toBe(15);
		expect(message.usage.output).toBe(11);
		expect(message.usage.cacheRead).toBe(5);
		expect(message.usage.totalTokens).toBe(31);
	});

	it("reports a non-2xx response through the shared failure classifier", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down" } }), {
					status: 429,
				}),
		);
		const model = getModel("google", "gemini-2.5-flash");

		const message = await streamGoogle(model, makeContext(), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider rate limit exceeded (ProviderApiError, 429): slow down");
	});
});
