import { afterEach, describe, expect, it, vi } from "bun:test";
import { getModel } from "../src/models.js";
import {
	buildCursorHeaders,
	buildCursorRequestBody,
	ConnectEnvelopeParser,
	CURSOR_CHAT_ENDPOINT,
	fetchCursorAvailableModels,
	frameConnectRequest,
	parseCursorEnvelope,
	streamCursorConnect,
} from "../src/providers/cursor.js";
import type { AssistantMessageEvent, Context } from "../src/types.js";

function frameBytes(flags: number, payload: string): Uint8Array {
	const body = new TextEncoder().encode(payload);
	const frame = new Uint8Array(5 + body.length);
	new DataView(frame.buffer).setUint32(1, body.length);
	frame[0] = flags;
	frame.set(body, 5);
	return frame;
}

describe("ConnectEnvelopeParser", () => {
	it("parses multiple frames from a single chunk", () => {
		const chunk = new Uint8Array([...frameBytes(0, `{"text":"a"}`), ...frameBytes(2, `{}`)]);

		const frames = new ConnectEnvelopeParser().push(chunk);
		expect(frames).toEqual([
			{ flags: 0, payload: `{"text":"a"}` },
			{ flags: 2, payload: `{}` },
		]);
	});

	it("reassembles frames split across chunk boundaries", () => {
		const parser = new ConnectEnvelopeParser();
		const full = frameBytes(0, `{"text":"hello world"}`);

		expect(parser.push(full.subarray(0, 3))).toEqual([]);
		expect(parser.push(full.subarray(3, 8))).toEqual([]);
		const frames = parser.push(full.subarray(8));
		expect(frames).toEqual([{ flags: 0, payload: `{"text":"hello world"}` }]);
	});

	it("handles multi-byte UTF-8 payloads split mid-character", () => {
		const parser = new ConnectEnvelopeParser();
		const full = frameBytes(0, `{"text":"\u00e9\u4f60\u597d"}`);

		expect(parser.push(full.subarray(0, 10))).toEqual([]);
		const frames = parser.push(full.subarray(10));
		expect(frames).toHaveLength(1);
		expect(JSON.parse(frames[0].payload)).toEqual({ text: "\u00e9\u4f60\u597d" });
	});
});

describe("parseCursorEnvelope", () => {
	it("maps plain and nested text deltas", () => {
		expect(parseCursorEnvelope({ text: "hi" }, 0)).toEqual({ kind: "delta", delta: "hi" });
		expect(parseCursorEnvelope({ text: { text: "hi" } }, 0)).toEqual({ kind: "delta", delta: "hi" });
	});

	it("maps tool call envelopes", () => {
		const outcome = parseCursorEnvelope({ client_tool_call: { name: "read_file", rawArgs: `{"path":"a.ts"}` } }, 0);
		expect(outcome).toEqual({ kind: "tool_call", toolCall: { name: "read_file", argumentsJson: `{"path":"a.ts"}` } });
	});

	it("ignores unknown message frames", () => {
		expect(parseCursorEnvelope({ prompt_and_tokens: {} }, 0)).toBeUndefined();
		expect(parseCursorEnvelope(null, 0)).toBeUndefined();
	});

	it("marks end-of-stream trailer frames", () => {
		expect(parseCursorEnvelope({}, 0x02)).toEqual({ kind: "end" });
	});

	it("throws on end-frame error objects", () => {
		const error = { error: { code: "unauthenticated", message: "not logged in" } };
		expect(() => parseCursorEnvelope(error, 0x02)).toThrow(/not logged in/);
		expect(() => parseCursorEnvelope(error, 0x00)).toThrow(/not logged in/);
	});
});

describe("buildCursorRequestBody", () => {
	const model = getModel("cursor", "composer-1");

	it("builds the framed request shape", () => {
		const context: Context = {
			systemPrompt: "be brief",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		};

		const body = buildCursorRequestBody(model, context, { maxTokens: 100 });
		expect(body.modelName).toBe("composer-1");
		expect(body.messages).toEqual([{ userMessage: { text: "hello" } }]);
		expect(body.tools).toEqual([]);
		expect(body.explicitContext).toBe("be brief");
		expect(body.maxTokens).toBe(100);
		expect(typeof body.requestId).toBe("string");
		expect(typeof body.conversationId).toBe("string");
	});

	it("frames the request as a single Connect message frame", () => {
		const context: Context = { messages: [] };
		const body = buildCursorRequestBody(model, context);
		const framed = frameConnectRequest(JSON.stringify(body));

		const length = new DataView(framed.buffer, framed.byteOffset).getUint32(1);
		expect(framed[0]).toBe(0);
		expect(length).toBe(framed.length - 5);
		expect(new TextDecoder().decode(framed.subarray(5))).toBe(JSON.stringify(body));
	});
});

describe("buildCursorHeaders", () => {
	it("sends the required Cursor client headers", async () => {
		const headers = await buildCursorHeaders("token123", "composer-1");

		expect(headers.Authorization).toBe("Bearer token123");
		expect(headers["Content-Type"]).toBe("application/connect+json");
		expect(headers["Connect-Protocol-Version"]).toBe("1");
		expect(headers["x-cursor-client-type"]).toBe("ide");
		expect(headers["x-cursor-client-version"]).toBeTruthy();

		const checksum = headers["x-cursor-checksum"];
		const machineId = checksum.slice(13);
		expect(checksum.startsWith(String(Date.now()))).toBe(true);
		// Machine id is a UUID.
		expect(machineId).toMatch(/^[0-9a-f-]{36}$/);

		// Session id is a uuid v5 derived from the token: deterministic.
		const again = await buildCursorHeaders("token123", "composer-1");
		expect(again["x-session-id"]).toBe(headers["x-session-id"]);
		expect(headers["x-session-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

		const otherToken = await buildCursorHeaders("other", "composer-1");
		expect(otherToken["x-session-id"]).not.toBe(headers["x-session-id"]);
	});
});

describe("streamCursorConnect", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mockFetchResponse(frames: Uint8Array[], status = 200): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const frame of frames) {
								controller.enqueue(frame);
							}
							controller.close();
						},
					}),
					{ status },
				);
			}),
		);
	}

	async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
		const result: AssistantMessageEvent[] = [];
		for await (const event of events) {
			result.push(event);
		}
		return result;
	}

	const model = getModel("cursor", "composer-1");

	it("streams text deltas and finishes with the end-of-stream frame", async () => {
		mockFetchResponse([
			frameBytes(0, `{"text":"Hello"}`),
			frameBytes(0, `{"text":{}}`),
			frameBytes(0, `{"text":{"text":" world"}}`),
			frameBytes(2, `{}`),
		]);

		const events = await collect(streamCursorConnect(model, { messages: [] }, { apiKey: "k" }));

		const types = events.map((event) => event.type);
		expect(types).toContain("start");
		expect(types).toContain("text_start");
		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" ? done.message.content : []).toEqual([{ type: "text", text: "Hello world" }]);
		expect(done && done.type === "done" ? done.message.stopReason : "").toBe("stop");
	});

	it("emits tool calls and sets stopReason toolUse", async () => {
		mockFetchResponse([
			frameBytes(0, '{"client_tool_call":{"name":"bash","rawArgs":"{\\"command\\":\\"ls\\"}"}}'),
			frameBytes(2, `{}`),
		]);

		const events = await collect(streamCursorConnect(model, { messages: [] }, { apiKey: "k" }));
		const ended = events.filter((event) => event.type === "toolcall_end");
		expect(ended).toHaveLength(1);
		if (ended[0]?.type !== "toolcall_end") throw new Error("unreachable");
		expect(ended[0].toolCall.name).toBe("bash");
		expect(ended[0].toolCall.arguments).toEqual({ command: "ls" });

		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" ? done.message.stopReason : "").toBe("toolUse");
	});

	it("fails the stream when the end frame carries an in-band error", async () => {
		mockFetchResponse([frameBytes(2, `{"error":{"code":"unauthenticated","message":"nope"}}`)]);

		const events = await collect(streamCursorConnect(model, { messages: [] }, { apiKey: "k" }));
		const failure = events.find((event) => event.type === "error");
		expect(failure && failure.type === "error" ? failure.error.errorMessage : "").toMatch(/nope/);
	});

	it("posts a single framed JSON body to the chat endpoint", async () => {
		let captured: { url: string; contentType: string; body: Uint8Array } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
				captured = {
					url: String(url),
					contentType: String(init?.headers ? new Headers(init.headers).get("Content-Type") : ""),
					body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
				};
				return new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.close();
						},
					}),
					{ status: 200 },
				);
			}),
		);

		await collect(
			streamCursorConnect(model, { messages: [{ role: "user", content: "hey", timestamp: 0 }] }, { apiKey: "k" }),
		);

		expect(captured?.url).toBe(CURSOR_CHAT_ENDPOINT);
		expect(captured?.contentType).toBe("application/connect+json");
		const length = new DataView(captured!.body.buffer, captured!.body.byteOffset).getUint32(1);
		expect(length).toBe(captured!.body.length - 5);
		const parsed = JSON.parse(new TextDecoder().decode(captured!.body.subarray(5)));
		expect(parsed.modelName).toBe("composer-1");
		expect(parsed.messages).toEqual([{ userMessage: { text: "hey" } }]);
	});
});

describe("fetchCursorAvailableModels", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mockAvailableModels(frames: Uint8Array[], status = 200): { url?: string; body?: unknown } {
		const captured: { url?: string; body?: unknown } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
				captured.url = String(url);
				captured.body = JSON.parse(
					new TextDecoder().decode(new Uint8Array(await new Response(init?.body).arrayBuffer()).subarray(5)),
				);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const frame of frames) {
								controller.enqueue(frame);
							}
							controller.close();
						},
					}),
					{ status },
				);
			}),
		);
		return captured;
	}

	it("parses the AvailableModels response into model entries", async () => {
		const payload = {
			modelNames: ["composer-1", "gpt-5"],
			models: [
				{
					name: "composer-1",
					defaultOn: true,
					supportsThinking: true,
					supportsImages: false,
					contextTokenLimit: 272000,
					clientDisplayName: "Composer 1",
				},
				{ name: "gpt-5", supportsImages: true },
			],
		};
		const captured = mockAvailableModels([frameBytes(0, JSON.stringify(payload)), frameBytes(2, "{}")]);

		const models = await fetchCursorAvailableModels("token");

		expect(captured.url).toContain("/aiserver.v1.AiService/AvailableModels");
		expect(captured.body).toEqual({ isNightly: false, includeLongContextModels: true });
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual({
			name: "composer-1",
			defaultOn: true,
			supportsThinking: true,
			supportsImages: false,
			contextTokenLimit: 272000,
			clientDisplayName: "Composer 1",
		});
		expect(models[1]).toEqual({ name: "gpt-5", supportsImages: true });
	});

	it("throws on HTTP errors and invalid payloads", async () => {
		mockAvailableModels([frameBytes(0, "{}")], 401);
		await expect(fetchCursorAvailableModels("token")).rejects.toThrow(/HTTP 401/);

		mockAvailableModels([frameBytes(0, JSON.stringify({ unexpected: true }))]);
		await expect(fetchCursorAvailableModels("token")).rejects.toThrow(/invalid payload/);
	});
});
