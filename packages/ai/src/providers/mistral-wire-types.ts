/**
 * Wire shapes for the Mistral chat completions API.
 *
 * Vendored for the same reason as the OpenAI and Anthropic ones: the transport is our own
 * fetch client, so the SDK was carried for declarations alone. The SDK renames several fields
 * on the way out (see `encodeChatRequest`), so these describe the camelCase shape the code
 * builds, not the snake_case JSON that goes over the wire.
 */

export interface TextChunk {
	type: "text";
	text: string;
}

export interface ImageURLChunk {
	type: "image_url";
	imageUrl: string | { url: string; detail?: string };
}

/** Magistral reasoning content: a chunk whose parts carry the thinking text. */
export interface ThinkingChunk {
	type: "thinking";
	thinking: TextChunk[];
}

export type ContentChunk = TextChunk | ImageURLChunk | ThinkingChunk;

export interface FunctionTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean;
	};
}

export interface ToolCall {
	id?: string;
	type?: "function";
	index?: number;
	function: { name: string; arguments: string | Record<string, unknown> };
}

export interface SystemMessage {
	role: "system";
	content: string | ContentChunk[];
}

export interface UserMessage {
	role: "user";
	content: string | ContentChunk[];
}

export interface AssistantMessage {
	role: "assistant";
	content?: string | ContentChunk[] | null;
	toolCalls?: ToolCall[] | null;
	prefix?: boolean;
}

export interface ToolMessage {
	role: "tool";
	content: string | ContentChunk[];
	toolCallId?: string | null;
	name?: string | null;
}

export type ChatCompletionStreamRequestMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ChatCompletionStreamRequest {
	model: string;
	messages: ChatCompletionStreamRequestMessage[];
	tools?: FunctionTool[] | null;
	toolChoice?: unknown;
	maxTokens?: number | null;
	temperature?: number | null;
	topP?: number | null;
	stop?: string | string[];
	randomSeed?: number | null;
	[key: string]: unknown;
}

export interface UsageInfo {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}

export interface DeltaMessage {
	role?: string | null;
	content?: string | ContentChunk[] | null;
	toolCalls?: ToolCall[] | null;
}

/** One `text/event-stream` frame: the SDK wraps each chunk in a `data` property. */
export interface CompletionEvent {
	data: {
		id?: string;
		model?: string;
		usage?: UsageInfo | null;
		choices: Array<{
			index?: number;
			delta: DeltaMessage;
			finishReason?: string | null;
		}>;
	};
}
