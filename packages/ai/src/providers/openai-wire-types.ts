/**
 * Wire shapes for the OpenAI Chat Completions and Responses APIs.
 *
 * These were previously imported as types from the `openai` package, which meant carrying the
 * whole SDK as a dependency for declarations alone — the transport has been our own fetch
 * client for a while. Only the fields this codebase builds or reads are declared; anything the
 * API returns and we ignore is intentionally absent, and unions stay open where the server may
 * add members.
 */

// ---------------------------------------------------------------------------
// Chat Completions
// ---------------------------------------------------------------------------

export interface ChatCompletionContentPartText {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral"; ttl?: string } | null;
}

export interface ChatCompletionContentPartImage {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage;

export interface ChatCompletionSystemMessageParam {
	role: "system";
	content: string | ChatCompletionContentPartText[];
	name?: string;
}

export interface ChatCompletionDeveloperMessageParam {
	role: "developer";
	content: string | ChatCompletionContentPartText[];
	name?: string;
}

export interface ChatCompletionUserMessageParam {
	role: "user";
	content: string | ChatCompletionContentPart[];
	name?: string;
}

export interface ChatCompletionMessageToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatCompletionAssistantMessageParam {
	role: "assistant";
	content?: string | ChatCompletionContentPartText[] | null;
	name?: string;
	tool_calls?: ChatCompletionMessageToolCall[];
	reasoning_content?: string | null;
	reasoning?: string | null;
}

export interface ChatCompletionToolMessageParam {
	role: "tool";
	content: string | ChatCompletionContentPartText[];
	tool_call_id: string;
}

export type ChatCompletionMessageParam =
	| ChatCompletionSystemMessageParam
	| ChatCompletionDeveloperMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam
	| ChatCompletionToolMessageParam;

export interface ChatCompletionTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean | null;
	};
}

export interface ChatCompletionUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface ChatCompletionChunk {
	id?: string;
	model?: string;
	choices?: Array<{
		index?: number;
		delta?: {
			role?: string;
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: "function";
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ChatCompletionUsage | null;
}

export declare namespace ChatCompletionChunk {
	interface Choice {
		index?: number;
		delta?: NonNullable<
			NonNullable<import("./openai-wire-types.js").ChatCompletionChunk["choices"]>[number]["delta"]
		>;
		finish_reason?: string | null;
	}
	namespace Choice {
		interface Delta {
			role?: string;
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: "function";
				function?: { name?: string; arguments?: string };
			}>;
		}
	}
}

export interface ChatCompletionCreateParamsStreaming {
	model: string;
	messages: ChatCompletionMessageParam[];
	stream: true;
	stream_options?: { include_usage?: boolean };
	tools?: ChatCompletionTool[];
	tool_choice?: unknown;
	max_tokens?: number | null;
	max_completion_tokens?: number | null;
	temperature?: number | null;
	top_p?: number | null;
	stop?: string | string[] | null;
	reasoning_effort?: string | null;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ResponseInputText {
	type: "input_text";
	text: string;
}

export interface ResponseInputImage {
	type: "input_image";
	image_url: string;
	detail?: "auto" | "low" | "high";
}

export type ResponseInputContent = ResponseInputText | ResponseInputImage;

export interface ResponseOutputText {
	type: "output_text";
	text: string;
	annotations?: unknown[];
}

export interface ResponseOutputRefusal {
	type: "refusal";
	refusal: string;
}

export interface ResponseOutputMessage {
	type: "message";
	/** Identifies the message; used to build the text signature. */
	id: string;
	/** Set by providers that stream a message in phases; absent upstream. */
	phase?: "commentary" | "final_answer";
	role: "assistant";
	status?: string;
	content: Array<ResponseOutputText | ResponseOutputRefusal>;
}

export interface ResponseReasoningItem {
	type: "reasoning";
	id?: string;
	summary?: Array<{ type: "summary_text"; text: string }>;
	content?: Array<{ type: "reasoning_text"; text: string }>;
	encrypted_content?: string | null;
	status?: string;
}

export interface ResponseFunctionToolCall {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
	status?: string;
}

export type ResponseStatus = "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";

export interface ResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number | null } | null;
	output_tokens_details?: { reasoning_tokens?: number | null } | null;
}

/**
 * Server-sent events from the Responses API. Left open-ended: the server adds event types and
 * the reader switches on `type`, so an exhaustive union would reject valid traffic.
 */
export type ResponseOutputItem = ResponseOutputMessage | ResponseReasoningItem | ResponseFunctionToolCall;

export interface ResponseObject {
	id: string;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	status?: ResponseStatus;
	output?: ResponseOutputItem[];
	usage?: ResponseUsage | null;
	error?: { code?: string; message?: string } | null;
	incomplete_details?: { reason?: string } | null;
	[key: string]: unknown;
}

/**
 * Server-sent events from the Responses API, as a discriminated union on `type`.
 *
 * Only the events this codebase narrows on are listed. The union deliberately has no
 * open catch-all member: a member typed `type: string` can never be excluded by a `===` check,
 * which collapses narrowing across the whole union and leaves every payload `unknown`.
 * Unrecognised events still arrive at runtime and fall through the readers' final `else`.
 */
export type ResponseStreamEvent =
	| { type: "response.created"; response: ResponseObject }
	| { type: "response.completed"; response: ResponseObject }
	| { type: "response.failed"; response: ResponseObject }
	| { type: "response.incomplete"; response: ResponseObject }
	| { type: "response.output_item.added"; item: ResponseOutputItem; output_index?: number }
	| { type: "response.output_item.done"; item: ResponseOutputItem; output_index?: number }
	| {
			type: "response.content_part.added";
			part: ResponseOutputText | ResponseOutputRefusal;
			item_id?: string;
			output_index?: number;
			content_index?: number;
	  }
	| { type: "response.output_text.delta"; delta: string; item_id?: string; content_index?: number }
	| { type: "response.refusal.delta"; delta: string; item_id?: string }
	| { type: "response.reasoning_text.delta"; delta: string; item_id?: string }
	| { type: "response.reasoning_summary_text.delta"; delta: string; summary_index?: number }
	| {
			type: "response.reasoning_summary_part.added";
			part: { type: "summary_text"; text: string };
			summary_index?: number;
	  }
	| {
			type: "response.reasoning_summary_part.done";
			part: { type: "summary_text"; text: string };
			summary_index?: number;
	  }
	| { type: "response.function_call_arguments.delta"; delta: string; item_id?: string }
	| { type: "response.function_call_arguments.done"; arguments: string; item_id?: string }
	| { type: "error"; code?: string; message?: string };

/** A tool definition in the Responses API (function tools plus the hosted ones). */
export interface Tool {
	type: string;
	name?: string;
	description?: string | null;
	parameters?: Record<string, unknown> | null;
	strict?: boolean | null;
	[key: string]: unknown;
}

/** Tool output expressed as content parts, which is how images are returned. */
export type ResponseFunctionCallOutputItemList = ResponseInputContent[];

/** Items accepted as `input`: prior messages, tool calls, tool outputs, reasoning. */
export interface ResponseFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	/** A string for text results, or content parts when the tool returned images. */
	output: string | ResponseInputContent[];
	id?: string;
	status?: string;
}

/** A conversational turn supplied as input, as opposed to an item echoed back from output. */
export interface ResponseInputMessage {
	type?: "message";
	role: "user" | "assistant" | "system" | "developer";
	content: string | ResponseInputContent[];
}

/**
 * Items accepted as `input`.
 *
 * Like `ResponseStreamEvent`, this has no open catch-all member: one typed `type?: string`
 * would make every `m.type === "..."` check non-narrowing and leave callers with `{}`.
 */
export type ResponseInputItem =
	| ResponseInputMessage
	| ResponseOutputMessage
	| ResponseReasoningItem
	| ResponseFunctionToolCall
	| ResponseFunctionCallOutput;

export type ResponseInput = ResponseInputItem[];

export interface ResponseCreateParamsStreaming {
	model: string;
	input: unknown;
	stream: true;
	instructions?: string | null;
	tools?: unknown[];
	tool_choice?: unknown;
	max_output_tokens?: number | null;
	temperature?: number | null;
	top_p?: number | null;
	reasoning?: { effort?: string | null; summary?: string | null } | null;
	include?: string[];
	store?: boolean;
	previous_response_id?: string | null;
	[key: string]: unknown;
}
