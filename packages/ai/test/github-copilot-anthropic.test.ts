import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import type { Context } from "../src/types.js";

function createSseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 5 },
		})}\n`,
	].join("\n");

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function stubFetch(): { calls: CapturedRequest[] } {
	const calls: CapturedRequest[] = [];
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
		calls.push({
			url: String(input),
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
			),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return createSseResponse();
	});
	return { calls };
}

describe("Copilot Claude via Anthropic Messages", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	it("uses Bearer auth, Copilot headers, and valid Anthropic Messages payload", async () => {
		const model = getModel("github-copilot", "claude-sonnet-4.5");
		expect(model.api).toBe("anthropic-messages");
		const { calls } = stubFetch();

		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(model, context, { apiKey: "tid_copilot_session_test_token" });
		for await (const event of s) {
			if (event.type === "error") break;
		}

		expect(calls).toHaveLength(1);
		const { url, headers, body } = calls[0]!;
		expect(url).toBe(`${model.baseUrl}/v1/messages`);

		// Auth: Bearer, never x-api-key
		expect(headers.authorization).toBe("Bearer tid_copilot_session_test_token");
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers["anthropic-version"]).toBe("2023-06-01");

		// Copilot static headers from model.headers
		expect(headers["user-agent"]).toContain("GitHubCopilotChat");
		expect(headers["copilot-integration-id"]).toBe("vscode-chat");

		// Dynamic headers
		expect(headers["x-initiator"]).toBe("user");
		expect(headers["openai-intent"]).toBe("conversation-edits");

		// No fine-grained-tool-streaming (Copilot doesn't support it)
		const beta = headers["anthropic-beta"] ?? "";
		expect(beta).not.toContain("fine-grained-tool-streaming");

		// Payload is valid Anthropic Messages format
		expect(body.model).toBe("claude-sonnet-4.5");
		expect(body.stream).toBe(true);
		expect(body.max_tokens as number).toBeGreaterThan(0);
		expect(Array.isArray(body.messages)).toBe(true);
	});

	it("includes interleaved-thinking beta when reasoning is enabled", async () => {
		const model = getModel("github-copilot", "claude-sonnet-4.5");
		const { calls } = stubFetch();
		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(model, context, {
			apiKey: "tid_copilot_session_test_token",
			interleavedThinking: true,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		expect(calls[0]!.headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");
	});
});
