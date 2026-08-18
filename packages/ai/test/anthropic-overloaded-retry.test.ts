import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function overloadedResponse(retryAfterSeconds: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
		status: 529,
		headers: {
			"content-type": "application/json",
			"retry-after": retryAfterSeconds,
			"request-id": "req_overloaded",
		},
	});
}

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_ok", usage: { input_tokens: 4, output_tokens: 0 } },
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 2 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("Anthropic 529 overloaded retry", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("retries after `retry-after` and succeeds", async () => {
		const at: number[] = [];
		const fetchMock = vi.fn(async (): Promise<Response> => {
			at.push(Date.now());
			return at.length === 1 ? overloadedResponse("0.2") : sseResponse();
		});
		vi.stubGlobal("fetch", fetchMock);

		const model = getModel("anthropic", "claude-sonnet-4-6");
		const result = await streamAnthropic(model, context, { apiKey: "sk-ant-test" }).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		// `retry-after: 0.2` seconds must be honoured (not the 0.5s exponential default).
		const waited = at[1]! - at[0]!;
		expect(waited).toBeGreaterThanOrEqual(150);
		expect(waited).toBeLessThan(450);
	});

	it("classifies an exhausted retry budget as an `overloaded` stream failure", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => overloadedResponse("0.01"));
		vi.stubGlobal("fetch", fetchMock);

		const model = getModel("anthropic", "claude-sonnet-4-6");
		const result = await streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			maxRetries: 1,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Provider overloaded");
		expect(result.errorMessage).toContain("overloaded_error");
		expect(result.errorMessage).toContain("529");
		expect(result.errorMessage).toContain("req_overloaded");
	});
});
