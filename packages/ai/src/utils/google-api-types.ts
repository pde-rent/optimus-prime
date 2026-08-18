/**
 * Wire types for the Gemini `generateContent` REST API.
 *
 * Replaces the type-only `@google/genai` dependency. The SDK itself was dropped
 * when the provider moved to `utils/http.ts`, but its types still appeared in
 * emitted declarations (`dist/providers/google-shared.d.ts`), so any consumer
 * typechecking `@earendil-works/pi-ai/google` needed `@google/genai` installed
 * to resolve them. These declarations cover exactly the fields this provider
 * reads or writes — they are intentionally a subset, not a mirror of the SDK.
 *
 * Reference: https://ai.google.dev/api/generate-content
 */

/** Inline base64 media, used for images we send and receive. */
export interface GoogleInlineData {
	mimeType?: string;
	data?: string;
}

/** A single function call requested by the model. */
export interface GoogleFunctionCall {
	id?: string;
	name?: string;
	args?: unknown;
}

/** The result we hand back for a function call. */
export interface GoogleFunctionResponse {
	id?: string;
	name?: string;
	response?: Record<string, unknown>;
	/** Gemini 3+ allows media nested inside a function response. */
	parts?: GooglePart[];
}

/**
 * One piece of a `Content`. Exactly one payload field is set in practice, but
 * the API models them as independent optionals and `thoughtSignature` can ride
 * along with any of them.
 */
export interface GooglePart {
	text?: string;
	/** `true` marks the part as a thought summary rather than user-visible text. */
	thought?: boolean;
	/** Opaque encrypted reasoning context, replayed verbatim on the next turn. */
	thoughtSignature?: string;
	inlineData?: GoogleInlineData;
	functionCall?: GoogleFunctionCall;
	functionResponse?: GoogleFunctionResponse;
}

/** One conversation turn. `role` is "user" or "model". */
export interface GoogleContent {
	role?: string;
	parts?: GooglePart[];
}

/** Values of the API's `FunctionCallingConfigMode` enum. */
export type GoogleFunctionCallingConfigMode = "MODE_UNSPECIFIED" | "AUTO" | "ANY" | "NONE" | "VALIDATED";

/**
 * Values of the API's `FinishReason` enum. Kept open (`| (string & {})`) on
 * purpose: Google adds members without warning and `mapStopReason` must keep
 * a live stream alive when it meets one.
 */
export type GoogleFinishReason =
	| "FINISH_REASON_UNSPECIFIED"
	| "STOP"
	| "MAX_TOKENS"
	| "SAFETY"
	| "RECITATION"
	| "LANGUAGE"
	| "OTHER"
	| "BLOCKLIST"
	| "PROHIBITED_CONTENT"
	| "SPII"
	| "MALFORMED_FUNCTION_CALL"
	| "IMAGE_SAFETY"
	| "UNEXPECTED_TOOL_CALL"
	| "IMAGE_PROHIBITED_CONTENT"
	| "NO_IMAGE"
	| "IMAGE_RECITATION"
	| "IMAGE_OTHER"
	| (string & {});

/** Values of the API's `ThinkingLevel` enum. */
export type GoogleThinkingLevelValue = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface GoogleThinkingConfig {
	includeThoughts?: boolean;
	thinkingBudget?: number;
	thinkingLevel?: GoogleThinkingLevelValue;
}

export interface GoogleToolConfig {
	functionCallingConfig?: {
		mode?: GoogleFunctionCallingConfigMode;
		allowedFunctionNames?: string[];
	};
}

/** A tool declaration; we only ever emit `functionDeclarations`. */
export interface GoogleTool {
	functionDeclarations?: Record<string, unknown>[];
}

/**
 * Request config. `systemInstruction` accepts the same loose shapes the SDK's
 * `tContent` helper accepted, and `abortSignal` / `httpOptions` are client-only
 * keys that `buildRequestBody` strips before serialising.
 */
export interface GoogleGenerateContentConfig {
	temperature?: number;
	maxOutputTokens?: number;
	systemInstruction?: string | GoogleContent | GooglePart | (string | GooglePart)[];
	tools?: GoogleTool[];
	toolConfig?: GoogleToolConfig;
	thinkingConfig?: GoogleThinkingConfig;
	safetySettings?: unknown[];
	cachedContent?: string;
	abortSignal?: AbortSignal;
	httpOptions?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface GoogleGenerateContentParameters {
	model: string;
	contents: GoogleContent[];
	config?: GoogleGenerateContentConfig;
}

export interface GoogleUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	cachedContentTokenCount?: number;
	thoughtsTokenCount?: number;
	totalTokenCount?: number;
}

export interface GoogleCandidate {
	content?: GoogleContent;
	finishReason?: GoogleFinishReason;
}

export interface GoogleGenerateContentResponse {
	responseId?: string;
	candidates?: GoogleCandidate[];
	usageMetadata?: GoogleUsageMetadata;
}
