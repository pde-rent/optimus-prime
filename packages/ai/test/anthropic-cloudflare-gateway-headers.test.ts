import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

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

describe("Cloudflare AI Gateway header deletion", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("strips the SDK auth headers and authenticates via cf-aig-authorization", async () => {
		let captured: Record<string, string> = {};
		let capturedUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			capturedUrl = String(input);
			captured = Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
			);
			return sseResponse();
		});
		vi.stubGlobal("fetch", fetchMock);

		const base = getModel("anthropic", "claude-sonnet-4-6");
		const model: Model<"anthropic-messages"> = {
			...base,
			provider: "cloudflare-ai-gateway",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
		};

		const result = await streamAnthropic(model, context, { apiKey: "cf-gateway-key" }).result();
		expect(result.stopReason).toBe("stop");

		expect(capturedUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages");
		// The gateway rejects the SDK's own auth headers; they must not be sent at all
		// (and never as a literal `null`).
		expect(captured["x-api-key"]).toBeUndefined();
		expect(captured.authorization).toBeUndefined();
		expect(Object.values(captured)).not.toContain(null);
		expect(captured["cf-aig-authorization"]).toBe("Bearer cf-gateway-key");
		expect(captured["anthropic-version"]).toBe("2023-06-01");
	});
});
