import { getEnvApiKey } from "../env-api-keys.js";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
} from "../types.js";
import { headersToRecord } from "../utils/headers.js";
import { runProviderStream } from "./stream-runner.js";

const CURSOR_API_BASE_URL = "https://api2.cursor.sh";
// Legacy chat endpoint: best documented of the Cursor wire surfaces. Switch
// paths here if the agent hosts (agent.api5.cursor.sh) become required.
export const CURSOR_CHAT_ENDPOINT = `${CURSOR_API_BASE_URL}/aiserver.v1.ChatService/StreamUnifiedChatWithTools`;
const CURSOR_CLIENT_VERSION = "0.50.7";
const CURSOR_MACHINE_ID = crypto.randomUUID();

/** End-of-stream trailer frame (Connect). */
const FLAGS_END = 0x02;

// ---------------------------------------------------------------------------
// Wire types

export interface CursorUserMessage {
	text: string;
}

export interface CursorAssistantMessage {
	text: string;
}

export interface CursorToolResult {
	toolCallId: string;
	text: string;
}

export type CursorWireMessage =
	| { userMessage: CursorUserMessage }
	| { assistantMessage: CursorAssistantMessage }
	| { toolResult: CursorToolResult };

export interface CursorWireTool {
	name: string;
	description?: string;
	parameters?: unknown;
}

export interface CursorRequestBody {
	requestId: string;
	conversationId: string;
	modelName: string;
	messages: CursorWireMessage[];
	tools: CursorWireTool[];
	maxTokens?: number;
	explicitContext?: string;
}

// ---------------------------------------------------------------------------
// Request building

type Textish = string | { type: string; text?: string }[];

function textOf(content: Textish): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function convertCursorMessages(context: Context): CursorWireMessage[] {
	const messages: CursorWireMessage[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ userMessage: { text: textOf(message.content) } });
		} else if (message.role === "assistant") {
			messages.push({ assistantMessage: { text: textOf(message.content) } });
		} else {
			messages.push({
				toolResult: {
					toolCallId: message.toolCallId,
					text: textOf(message.content),
				},
			});
		}
	}

	return messages;
}

function convertCursorTools(tools: Tool[]): CursorWireTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

export function buildCursorRequestBody(
	model: Model<"cursor-connect">,
	context: Context,
	options?: StreamOptions,
): CursorRequestBody {
	const body: CursorRequestBody = {
		requestId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
		modelName: model.id,
		messages: convertCursorMessages(context),
		tools: context.tools && context.tools.length > 0 ? convertCursorTools(context.tools) : [],
	};

	if (context.systemPrompt) {
		body.explicitContext = context.systemPrompt;
	}
	if (options?.maxTokens) {
		body.maxTokens = options.maxTokens;
	}

	return body;
}

/**
 * Frame a JSON request payload as the single Connect message frame the chat
 * endpoint expects: [flags=0x00][length 4 bytes big-endian][payload].
 */
export function frameConnectRequest(payload: string): Uint8Array {
	const bytes = new TextEncoder().encode(payload);
	const frame = new Uint8Array(5 + bytes.length);
	new DataView(frame.buffer).setUint32(1, bytes.length);
	frame.set(bytes, 5);
	return frame;
}

// ---------------------------------------------------------------------------
// Headers

// RFC 4122 namespace for name-based UUIDs (DNS); used to derive a stable
// session id from the access token without shipping an uuid dependency.
const UUID_NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(uuid: string): Uint8Array {
	return new Uint8Array(
		uuid
			.replace(/-/g, "")
			.match(/../g)!
			.map((byte) => parseInt(byte, 16)),
	);
}

async function uuidV5(name: string, namespace: string = UUID_NAMESPACE_DNS): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-1",
			new Uint8Array([...uuidToBytes(namespace), ...new TextEncoder().encode(name)]),
		),
	);
	digest[6] = (digest[6] & 0x0f) | 0x50;
	digest[8] = (digest[8] & 0x3f) | 0x80;
	const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function buildCursorHeaders(apiKey: string, modelId: string): Promise<Record<string, string>> {
	const sessionId = await uuidV5(apiKey);
	return {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/connect+json",
		"Connect-Protocol-Version": "1",
		"x-cursor-client-version": CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "ide",
		"x-cursor-checksum": `${Date.now()}${CURSOR_MACHINE_ID}`,
		"x-session-id": sessionId,
		"x-request-id": crypto.randomUUID(),
		"x-cursor-model": modelId,
	};
}

// ---------------------------------------------------------------------------
// Response envelope parsing

export interface ConnectFrame {
	flags: number;
	payload: string;
}

/** Incremental parser for Connect envelope frames [flags:1][len:4BE][payload]. */
export class ConnectEnvelopeParser {
	private buffer: Uint8Array = new Uint8Array(0);

	push(chunk: Uint8Array): ConnectFrame[] {
		const merged = new Uint8Array(this.buffer.length + chunk.length);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.length);
		this.buffer = merged;

		const frames: ConnectFrame[] = [];
		while (this.buffer.length >= 5) {
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
			const length = view.getUint32(1);
			if (this.buffer.length < 5 + length) {
				break;
			}
			const flags = this.buffer[0];
			const payload = new TextDecoder().decode(this.buffer.subarray(5, 5 + length));
			this.buffer = this.buffer.subarray(5 + length);
			frames.push({ flags, payload });
		}
		return frames;
	}
}

export interface CursorEnvelopeToolCall {
	name: string;
	argumentsJson: string;
}
export type CursorEnvelopeOutcome =
	| { kind: "delta"; delta: string }
	| { kind: "tool_call"; toolCall: CursorEnvelopeToolCall }
	| { kind: "end" };

type RecordOf = Record<string, unknown>;

function isRecord(value: unknown): value is RecordOf {
	return typeof value === "object" && value !== null;
}

/**
 * Map one decoded envelope JSON object to our stream semantics. Shapes are
 * mapped tolerantly because the Cursor response schema is not publicly stable:
 * - text deltas arrive as "text" (string or nested {text} object)
 * - tool calls arrive under "client_tool_call" / "tool_call"
 * - end-of-stream trailers carry "error" objects that must fail the stream.
 */
export function parseCursorEnvelope(json: unknown, flags: number): CursorEnvelopeOutcome | undefined {
	if (!isRecord(json)) {
		return undefined;
	}

	// In-band errors arrive on the end-of-stream trailer (live verified) but
	// check regardless of framing so nothing slips past.
	if (isRecord(json.error)) {
		const error = json.error;
		const code = typeof error.code === "string" ? error.code : "";
		const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
		throw new Error(`cursor stream error${code ? ` (${code})` : ""}: ${message}`);
	}

	if ((flags & FLAGS_END) !== 0) {
		return { kind: "end" };
	}

	const textDelta = resolveTextDelta(json);
	if (textDelta !== undefined) {
		return { kind: "delta", delta: textDelta };
	}

	const toolCall = resolveToolCall(json);
	if (toolCall) {
		return { kind: "tool_call", toolCall };
	}

	return undefined;
}

function resolveTextDelta(json: RecordOf): string | undefined {
	const direct = json.text;
	if (typeof direct === "string") {
		return direct;
	}
	if (isRecord(direct)) {
		const nested = direct.text ?? direct.start;
		if (typeof nested === "string") {
			return nested;
		}
	}
	if (typeof json.text_delta === "string") {
		return json.text_delta;
	}
	if (isRecord(json.delta) && typeof json.delta.text === "string") {
		return json.delta.text;
	}
	return undefined;
}

function resolveToolCall(json: RecordOf): CursorEnvelopeToolCall | undefined {
	for (const key of ["client_tool_call", "tool_call"] as const) {
		const value = json[key];
		if (isRecord(value) && typeof value.name === "string") {
			const args = value.rawArgs ?? value.arguments ?? value.args;
			return {
				name: value.name,
				argumentsJson: typeof args === "string" && args.length > 0 ? args : "{}",
			};
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Streaming

function safeParseArguments(argumentsJson: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(argumentsJson);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

async function consumeConnectStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal?: AbortSignal,
): Promise<void> {
	const parser = new ConnectEnvelopeParser();
	let currentText: TextContent | null = null;
	let sawToolUse = false;
	let sawEnd = false;

	const applyFrame = (frame: ConnectFrame): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame.payload);
		} catch {
			parsed = undefined;
		}

		const outcome = parseCursorEnvelope(parsed, frame.flags);
		if (!outcome) {
			return;
		}

		if (outcome.kind === "end") {
			sawEnd = true;
			return;
		}

		if (outcome.kind === "delta") {
			if (!currentText) {
				currentText = { type: "text", text: "" };
				output.content.push(currentText);
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			}
			currentText.text += outcome.delta;
			stream.push({
				type: "text_delta",
				contentIndex: output.content.length - 1,
				delta: outcome.delta,
				partial: output,
			});
			return;
		}

		const toolCall: ToolCall = {
			type: "toolCall",
			id: crypto.randomUUID(),
			name: outcome.toolCall.name,
			arguments: safeParseArguments(outcome.toolCall.argumentsJson),
		};
		sawToolUse = true;
		currentText = null;
		output.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
		stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall, partial: output });
	};

	const reader = response.body!.getReader();
	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			for (const frame of parser.push(value)) {
				applyFrame(frame);
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (!sawEnd) {
		throw new Error("cursor stream ended without an end-of-stream frame");
	}
	output.stopReason = sawToolUse ? "toolUse" : "stop";
}

export const streamCursorConnect: StreamFunction<"cursor-connect", StreamOptions> = (
	model: Model<"cursor-connect">,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream => {
	let requestId: string | undefined;

	return runProviderStream(
		model,
		options,
		async (output, stream) => {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			let body = buildCursorRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as CursorRequestBody;
			}

			const headers = {
				...(await buildCursorHeaders(apiKey, model.id)),
				...options?.headers,
			};

			// Plain fetch: the framed binary body is not a string, and blind
			// retries of a streaming POST are not meaningful.
			const response = await fetch(CURSOR_CHAT_ENDPOINT, {
				method: "POST",
				headers,
				body: frameConnectRequest(JSON.stringify(body)),
				signal: options?.signal,
			});

			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			requestId = response.headers.get("x-request-id") ?? undefined;

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`${response.status} ${response.statusText}: ${text}`);
			}

			stream.push({ type: "start", partial: output });

			await consumeConnectStream(response, output, stream, options?.signal);
		},
		{
			getRequestId: () => requestId,
		},
	);
};

export const streamSimpleCursorConnect: StreamFunction<"cursor-connect", SimpleStreamOptions> = (
	model: Model<"cursor-connect">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => streamCursorConnect(model, context, options);
