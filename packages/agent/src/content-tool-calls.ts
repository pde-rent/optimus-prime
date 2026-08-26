/**
 * Recovery of tool calls that models trained for tool calling sometimes emit as
 * plain text instead of using the native tool-call channel (degraded output).
 *
 * Recognition is deliberately narrow. Only well-known degraded dialects are
 * scanned - fenced ```json/```js blocks, Qwen-style <tool_call> tags and
 * Mistral-style [TOOL_CALLS] prefixes - and inside them only exact tool-call
 * shapes are accepted. Ordinary code blocks, prose and malformed JSON never
 * produce calls.
 */

export interface ExtractedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ExtractToolCallsOptions {
	/**
	 * Per-dialect switches. Every dialect is enabled unless explicitly turned off.
	 */
	dialects?: {
		/** Fenced ```json / ```js code blocks holding a tool-call object or array. */
		fencedBlocks?: boolean;
		/** Qwen-style `<tool_call>...</tool_call>` tags. */
		toolCallTags?: boolean;
		/** Mistral-style `[TOOL_CALLS]` prefixes followed by JSON. */
		toolCallsPrefix?: boolean;
	};
}

const FENCE_REGEX = /```(?:json|js|javascript)[ \t]*\r?\n([\s\S]*?)```/gi;
const TOOL_CALL_TAG_REGEX = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const TOOL_CALLS_PREFIX = "[TOOL_CALLS]";

const NAME_KEYS = ["name", "tool", "tool_name"] as const;
const ARGUMENT_KEYS = ["arguments", "args", "parameters", "params"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** Arguments arrive either as a JSON object or as a JSON string wrapping one. */
function coerceArguments(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		const parsed = parseJson(value);
		return isPlainObject(parsed) ? parsed : undefined;
	}
	return isPlainObject(value) ? value : undefined;
}

/** OpenAI-degraded shape: {"function": {"name": ..., "arguments": ...}}. */
function validateFunctionForm(candidate: Record<string, unknown>): ExtractedToolCall | undefined {
	const fn = candidate.function;
	if (!isPlainObject(fn)) {
		return undefined;
	}
	if (typeof fn.name !== "string" || fn.name.trim().length === 0) {
		return undefined;
	}
	const args = coerceArguments(fn.arguments);
	if (!args) {
		return undefined;
	}
	return { name: fn.name.trim(), arguments: args };
}

/** Flat shape: {name|tool|tool_name: string, arguments|args|parameters|params: ...}. */
function validateFlatForm(candidate: Record<string, unknown>): ExtractedToolCall | undefined {
	const nameKey = NAME_KEYS.find((key) => key in candidate);
	if (!nameKey) {
		return undefined;
	}
	const name = candidate[nameKey];
	if (typeof name !== "string" || name.trim().length === 0) {
		return undefined;
	}
	const argsKey = ARGUMENT_KEYS.find((key) => key in candidate);
	if (!argsKey) {
		return undefined;
	}
	const args = coerceArguments(candidate[argsKey]);
	if (!args) {
		return undefined;
	}
	return { name: name.trim(), arguments: args };
}

function validateToolCall(candidate: unknown): ExtractedToolCall | undefined {
	if (!isPlainObject(candidate)) {
		return undefined;
	}
	return "function" in candidate ? validateFunctionForm(candidate) : validateFlatForm(candidate);
}

function collectFromJsonText(payload: string, out: ExtractedToolCall[]): void {
	const parsed = parseJson(payload);
	if (Array.isArray(parsed)) {
		for (const entry of parsed) {
			const call = validateToolCall(entry);
			if (call) {
				out.push(call);
			}
		}
		return;
	}
	const call = validateToolCall(parsed);
	if (call) {
		out.push(call);
	}
}

/**
 * Return the first balanced JSON array or object in `text`, ignoring any prose
 * around it. Used after `[TOOL_CALLS]`, where models trail the payload with text.
 */
function sliceBalancedJson(text: string): string | undefined {
	const start = text.search(/\S/);
	if (start === -1) {
		return undefined;
	}
	const open = text[start];
	if (open !== "{" && open !== "[") {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{" || ch === "[") {
			depth += 1;
		} else if (ch === "}" || ch === "]") {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

/**
 * Extract tool calls from degraded plain-text assistant output.
 *
 * Only fenced json/js code blocks, `<tool_call>` tags and `[TOOL_CALLS]`
 * prefixes are scanned; within them only recognized tool-call shapes validate.
 * Anything else yields an empty array.
 */
export function extractToolCallsFromText(text: string, opts?: ExtractToolCallsOptions): ExtractedToolCall[] {
	const dialects = opts?.dialects ?? {};
	const calls: ExtractedToolCall[] = [];

	if (dialects.fencedBlocks !== false) {
		for (const match of text.matchAll(FENCE_REGEX)) {
			collectFromJsonText(match[1] ?? "", calls);
		}
	}
	if (dialects.toolCallTags !== false) {
		for (const match of text.matchAll(TOOL_CALL_TAG_REGEX)) {
			collectFromJsonText(match[1] ?? "", calls);
		}
	}
	if (dialects.toolCallsPrefix !== false) {
		let rest = text;
		let index = rest.indexOf(TOOL_CALLS_PREFIX);
		while (index !== -1) {
			rest = rest.slice(index + TOOL_CALLS_PREFIX.length);
			const payload = sliceBalancedJson(rest);
			if (payload) {
				collectFromJsonText(payload, calls);
			}
			index = rest.indexOf(TOOL_CALLS_PREFIX);
		}
	}

	return calls;
}
