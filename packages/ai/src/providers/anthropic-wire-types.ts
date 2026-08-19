/**
 * Wire shapes for the Anthropic Messages API.
 *
 * Vendored for the same reason as the OpenAI ones: the transport is our own fetch client, so
 * the SDK was being carried for declarations alone. Only the fields this codebase builds or
 * reads are declared.
 */

import type { AnthropicCacheCreationUsage } from "../cache-pricing.js";

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null;

export interface CacheControlEphemeral {
	type: "ephemeral";
	ttl?: "5m" | "1h";
}

export interface TextBlockParam {
	type: "text";
	text: string;
	cache_control?: CacheControlEphemeral | null;
}

export interface ImageBlockParam {
	type: "image";
	source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
	cache_control?: CacheControlEphemeral | null;
}

export interface ThinkingBlockParam {
	type: "thinking";
	thinking: string;
	signature: string;
}

export interface RedactedThinkingBlockParam {
	type: "redacted_thinking";
	data: string;
}

export interface ToolUseBlockParam {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
	cache_control?: CacheControlEphemeral | null;
}

export interface ToolResultBlockParam {
	type: "tool_result";
	tool_use_id: string;
	content?: string | Array<TextBlockParam | ImageBlockParam>;
	is_error?: boolean;
	cache_control?: CacheControlEphemeral | null;
}

export type ContentBlockParam =
	| TextBlockParam
	| ImageBlockParam
	| ThinkingBlockParam
	| RedactedThinkingBlockParam
	| ToolUseBlockParam
	| ToolResultBlockParam;

export interface MessageParam {
	role: "user" | "assistant";
	content: string | ContentBlockParam[];
}

export interface Tool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
	cache_control?: CacheControlEphemeral | null;
	type?: string;
}

export interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	/** Per-TTL breakdown of cache writes, sent when 1h caching is in use. */
	cache_creation?: AnthropicCacheCreationUsage | null;
}

export interface MessageCreateParamsStreaming {
	model: string;
	messages: MessageParam[];
	max_tokens: number;
	stream: true;
	system?: string | TextBlockParam[];
	tools?: Tool[];
	tool_choice?: unknown;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	thinking?:
		| { type: "enabled"; budget_tokens: number; display?: "summarized" | "omitted" }
		| { type: "adaptive"; display?: "summarized" | "omitted" }
		| { type: "disabled" };
	/** Newer effort control; values here can outpace what the published SDK types allow. */
	output_config?: { effort?: string } | null;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * Streaming events. Like the Responses union this has no open catch-all member: one typed
 * `type: string` would stop every `event.type === "..."` check from narrowing.
 */
export type RawMessageStreamEvent =
	| {
			type: "message_start";
			message: {
				id?: string;
				model?: string;
				role?: "assistant";
				usage: Usage;
				stop_reason?: StopReason;
			};
	  }
	| {
			type: "content_block_start";
			index: number;
			content_block:
				| { type: "text"; text: string }
				| { type: "thinking"; thinking: string; signature?: string }
				| { type: "redacted_thinking"; data: string }
				| { type: "tool_use"; id: string; name: string; input?: unknown };
	  }
	| {
			type: "content_block_delta";
			index: number;
			delta:
				| { type: "text_delta"; text: string }
				| { type: "thinking_delta"; thinking: string }
				| { type: "signature_delta"; signature: string }
				| { type: "input_json_delta"; partial_json: string };
	  }
	| { type: "content_block_stop"; index: number }
	| {
			type: "message_delta";
			delta: { stop_reason?: StopReason; stop_sequence?: string | null };
			usage: Usage;
	  }
	| { type: "message_stop" }
	| { type: "ping" }
	| { type: "error"; error: { type?: string; message?: string } };
