import { vi } from "vitest";

/**
 * Test double for the OpenAI providers' HTTP transport.
 *
 * The providers talk to `/chat/completions` and `/responses` with plain
 * `fetch`, so tests stub the global `fetch`, capture what was sent (URL,
 * headers, JSON body) and reply with a canned SSE stream.
 */

export interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** Parsed JSON request body; tests cast it to the shape they assert on. */
	body: unknown;
}

/** SSE events for a request: a fixed list, or derived from what was sent. */
export type SseEvents = unknown[] | ((request: CapturedRequest) => unknown[]);

export interface OpenAIFetchMock {
	requests: CapturedRequest[];
	/** Events served for each request; assign to change mid-test. */
	events: SseEvents;
	lastRequest(): CapturedRequest;
	restore(): void;
}

/** Build an SSE body from `events`, terminated by the OpenAI `[DONE]` sentinel. */
export function sseResponse(events: unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Stub `globalThis.fetch` for the current test file. Call `restore()` when done. */
export function mockOpenAIFetch(events: SseEvents = []): OpenAIFetchMock {
	const mock: OpenAIFetchMock = {
		requests: [],
		events,
		lastRequest() {
			const request = mock.requests.at(-1);
			if (!request) throw new Error("no request was captured");
			return request;
		},
		restore() {
			vi.unstubAllGlobals();
		},
	};

	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const request: CapturedRequest = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string> | undefined) },
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		mock.requests.push(request);
		return sseResponse(typeof mock.events === "function" ? mock.events(request) : mock.events);
	});

	return mock;
}

/** The single chunk that ends a chat-completions stream with a `stop` finish reason. */
export function completionsStopChunk(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		choices: [{ delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 1,
			completion_tokens: 1,
			prompt_tokens_details: { cached_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: 0 },
		},
		...overrides,
	};
}
