import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamMistral } from "../src/providers/mistral.js";
import type { Context } from "../src/types.js";

/**
 * Offline coverage for the Mistral wire protocol: the provider posts to
 * `/v1/chat/completions` itself, so this pins the request shape and the SSE
 * decoding (text, thinking, tool calls, usage, finish reason).
 */

interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

const SSE_CHUNKS: Record<string, unknown>[] = [
	{ id: "cmpl-1", model: "devstral-medium-latest", choices: [{ index: 0, delta: { role: "assistant" } }] },
	{
		id: "cmpl-1",
		choices: [
			{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "weigh it" }] }] } },
		],
	},
	{ id: "cmpl-1", choices: [{ index: 0, delta: { content: "Hello" } }] },
	{ id: "cmpl-1", choices: [{ index: 0, delta: { content: [{ type: "text", text: " world" }] } }] },
	{
		id: "cmpl-1",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [{ id: "abc123def", index: 0, function: { name: "get_time", arguments: '{"tz":"UTC"}' } }],
				},
			},
		],
	},
	{
		id: "cmpl-1",
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
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
		const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
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

describe("Mistral streaming (offline)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts the snake_case wire payload and decodes the SSE stream", async () => {
		const requests = stubFetch(SSE_CHUNKS);
		const model = getModel("mistral", "devstral-medium-latest");

		const stream = streamMistral(model, makeContext(), {
			apiKey: "test-key",
			maxTokens: 256,
			sessionId: "session-7",
		});
		const message = await stream.result();

		expect(message.stopReason, message.errorMessage).toBe("toolUse");

		const request = requests[0];
		expect(request.method).toBe("POST");
		expect(request.url).toBe("https://api.mistral.ai/v1/chat/completions");
		expect(request.headers.Authorization).toBe("Bearer test-key");
		expect(request.headers.Accept).toBe("text/event-stream");
		expect(request.headers["x-affinity"]).toBe("session-7");
		expect(request.body.model).toBe("devstral-medium-latest");
		expect(request.body.stream).toBe(true);
		// camelCase request fields are renamed the way the SDK's outbound schema did.
		expect(request.body.max_tokens).toBe(256);
		expect(request.body.maxTokens).toBeUndefined();
		expect(request.body.messages).toEqual([
			{ role: "system", content: "Be brief." },
			{ role: "user", content: "hi" },
		]);

		expect(message.responseId).toBe("cmpl-1");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "weigh it" },
			{ type: "text", text: "Hello world" },
			{ type: "toolCall", id: "abc123def", name: "get_time", arguments: { tz: "UTC" } },
		]);
		expect(message.usage.input).toBe(11);
		expect(message.usage.output).toBe(7);
		expect(message.usage.totalTokens).toBe(18);
	});

	it("reports a non-2xx response as a Mistral API error", async () => {
		vi.stubGlobal("fetch", async () => new Response('{"message":"nope"}', { status: 400 }));
		const model = getModel("mistral", "devstral-medium-latest");

		const message = await streamMistral(model, makeContext(), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe('Mistral API error (400): {"message":"nope"}');
	});
});
