/**
 * Minimal HTTP layer shared by the provider clients.
 *
 * Replaces the transport parts of the `openai` / `@anthropic-ai/sdk` /
 * `@mistralai/mistralai` / `@google/genai` SDKs: URL joining, header merging
 * (including the `null`-means-delete convention), retry/backoff, timeouts,
 * error typing and SSE decoding. Everything provider-specific (endpoint path,
 * auth scheme, body shape, SSE grammar, error mapping) stays in the provider
 * modules.
 *
 * Retry semantics intentionally mirror the Stainless-generated SDKs
 * (`openai`, `@anthropic-ai/sdk`) so behaviour is unchanged: `x-should-retry`
 * wins, then 408/409/429/5xx, `retry-after-ms` / `retry-after`
 * (seconds or HTTP-date) is honoured when it lands in (0, 60s], otherwise
 * exponential backoff from 0.5s capped at 8s with up-to-25% negative jitter.
 */

/** Headers as callers express them: `null` deletes a header set by an earlier source. */
export type HeaderInput = Record<string, string | null | undefined> | undefined;

/** Default request timeout, matching the OpenAI/Anthropic SDK default of 10 minutes. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Default retry count, matching the OpenAI/Anthropic SDK default. */
const DEFAULT_MAX_RETRIES = 2;

const INITIAL_RETRY_DELAY_SECONDS = 0.5;
const MAX_RETRY_DELAY_SECONDS = 8;
const MAX_RETRY_AFTER_MS = 60 * 1000;

/**
 * Merge header sources left-to-right. A `null` value deletes any value set by
 * an earlier source and is not sent; `undefined` is skipped entirely. Header
 * names are compared case-insensitively, like `Headers`.
 */
export function mergeHeaders(...sources: HeaderInput[]): Record<string, string> {
	const values = new Map<string, { name: string; value: string }>();
	for (const source of sources) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) {
			if (value === undefined) continue;
			const key = name.toLowerCase();
			if (value === null) {
				values.delete(key);
			} else {
				values.set(key, { name, value });
			}
		}
	}
	const merged: Record<string, string> = {};
	for (const { name, value } of values.values()) {
		merged[name] = value;
	}
	return merged;
}

/** Join a base URL and a path the way the OpenAI/Anthropic SDKs do. */
export function joinUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
	const url = /^https?:\/\//i.test(path)
		? new URL(path)
		: new URL(baseUrl + (baseUrl.endsWith("/") && path.startsWith("/") ? path.slice(1) : path));
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

/**
 * Error thrown for non-2xx provider responses.
 *
 * The field layout is duck-typed by `utils/stream-failure.ts` (and by
 * `providers/mistral.ts`), so it deliberately carries the union of the shapes
 * the SDKs exposed: `status`/`statusCode`, `headers`, `error` (parsed body),
 * `body` (raw text) and `requestID`.
 */
export class ProviderApiError extends Error {
	readonly status: number;
	/** Alias of {@link status}; some call sites duck-type SDK errors on `statusCode`. */
	readonly statusCode: number;
	readonly headers: Headers;
	/** Parsed error body when it was JSON, otherwise `undefined`. */
	readonly error: unknown;
	/** Raw error body text. */
	readonly body: string;
	readonly requestID?: string;

	constructor(status: number, statusText: string, body: string, headers: Headers) {
		let parsed: unknown;
		try {
			parsed = body ? JSON.parse(body) : undefined;
		} catch {
			parsed = undefined;
		}
		const nested = (parsed as { error?: unknown } | undefined)?.error ?? parsed;
		super(makeErrorMessage(status, nested, body || statusText));
		this.name = "ProviderApiError";
		this.status = status;
		this.statusCode = status;
		this.headers = headers;
		this.error = nested;
		this.body = body;
		this.requestID = headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;
	}
}

function makeErrorMessage(status: number, error: unknown, fallback: string): string {
	const message = (error as { message?: unknown } | undefined)?.message;
	let text: string | undefined;
	if (typeof message === "string") {
		text = message;
	} else if (message !== undefined) {
		text = JSON.stringify(message);
	} else if (error !== undefined) {
		text = JSON.stringify(error);
	} else {
		text = fallback || undefined;
	}
	if (status && text) return `${status} ${text}`;
	if (status) return `${status} status code (no body)`;
	return text ?? "(no status code or body)";
}

/** Thrown when the request exceeded its timeout; retried like a connection error. */
class ProviderTimeoutError extends Error {
	constructor(message = "Request timed out.") {
		super(message);
		this.name = "ProviderTimeoutError";
	}
}

/** Thrown when the connection failed; retried like the SDKs do. */
class ProviderConnectionError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ProviderConnectionError";
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Stainless `shouldRetry`: header override first, then the retryable status codes. */
function shouldRetryResponse(response: Response): boolean {
	const shouldRetryHeader = response.headers.get("x-should-retry");
	if (shouldRetryHeader === "true") return true;
	if (shouldRetryHeader === "false") return false;
	if (response.status === 408 || response.status === 409 || response.status === 429) return true;
	return response.status >= 500;
}

/** Stainless retry delay: honour `retry-after(-ms)` when sane, else jittered exponential backoff. */
function retryDelayMs(headers: Headers | undefined, attempt: number): number {
	let timeoutMs: number | undefined;
	const retryAfterMs = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
	if (!Number.isNaN(retryAfterMs)) {
		timeoutMs = retryAfterMs;
	} else {
		const retryAfter = headers?.get("retry-after");
		if (retryAfter) {
			const seconds = Number.parseFloat(retryAfter);
			timeoutMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		}
	}
	if (timeoutMs !== undefined && timeoutMs > 0 && timeoutMs < MAX_RETRY_AFTER_MS) {
		return timeoutMs;
	}
	const sleepSeconds = Math.min(INITIAL_RETRY_DELAY_SECONDS * 2 ** attempt, MAX_RETRY_DELAY_SECONDS);
	const jitter = 1 - Math.random() * 0.25;
	return sleepSeconds * jitter * 1000;
}

/** Abortable sleep. Rejects with `Request was aborted` when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface RequestOptions {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	/** Per-request timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Retry budget; defaults to {@link DEFAULT_MAX_RETRIES}. */
	maxRetries?: number;
	/** Injectable for tests. Defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Perform a request with SDK-equivalent retry/backoff and timeout handling.
 *
 * Returns the successful `Response` with its body untouched so the caller can
 * stream it. Throws {@link ProviderApiError} for a final non-2xx response and
 * {@link ProviderConnectionError} / {@link ProviderTimeoutError} for transport
 * failures. Retries only ever happen before the body is consumed, so a
 * partially-read stream is never replayed.
 */
export async function requestWithRetry(options: RequestOptions): Promise<Response> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch = options.fetchImpl ?? fetch;
	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (options.signal?.aborted) {
			throw new Error("Request was aborted");
		}

		const timeoutController = new AbortController();
		const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
		const onCallerAbort = () => timeoutController.abort();
		options.signal?.addEventListener("abort", onCallerAbort, { once: true });

		let response: Response;
		try {
			response = await doFetch(options.url, {
				method: options.method ?? "POST",
				headers: {
					...options.headers,
					...(maxRetries > 0 ? { "x-stainless-retry-count": String(attempt) } : {}),
				},
				body: options.body,
				signal: timeoutController.signal,
			});
		} catch (error) {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onCallerAbort);
			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			lastError = isAbortError(error)
				? new ProviderTimeoutError()
				: new ProviderConnectionError("Connection error.", { cause: error });
			if (attempt < maxRetries) {
				await sleep(retryDelayMs(undefined, attempt), options.signal);
				continue;
			}
			throw lastError;
		}

		// The response headers are in; the timeout no longer applies to body streaming,
		// matching the SDKs, which only time out the request/response headers exchange.
		clearTimeout(timer);

		if (response.ok) {
			// Deliberately keep the caller's abort wired to this request's controller for the
			// lifetime of the body: aborting mid-stream must cancel the connection immediately,
			// as the SDKs did, rather than waiting for the next chunk to arrive.
			return response;
		}

		options.signal?.removeEventListener("abort", onCallerAbort);
		const errorBody = await response.text().catch(() => "");
		const apiError = new ProviderApiError(response.status, response.statusText, errorBody, response.headers);
		if (attempt < maxRetries && shouldRetryResponse(response)) {
			lastError = apiError;
			await sleep(retryDelayMs(response.headers, attempt), options.signal);
			continue;
		}
		throw apiError;
	}

	throw lastError ?? new ProviderConnectionError("Request failed after retries.");
}

/** A decoded server-sent event. */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	/** Raw lines that produced this event, kept for error messages. */
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}
	const event: ServerSentEvent = { event: state.event, data: state.data.join("\n"), raw: [...state.raw] };
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) return newlineIndex;
	if (newlineIndex === -1) return carriageReturnIndex;
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) return null;
	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}
	return { line: text.slice(0, lineBreakIndex), rest: text.slice(nextIndex) };
}

/**
 * Decode an SSE body into events. Handles CR, LF and CRLF line endings,
 * comment lines, multi-line `data:` fields and a trailing event with no
 * terminating blank line.
 */
export async function* iterateSse(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	const drain = function* (): Generator<ServerSentEvent> {
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) yield event;
			consumed = consumeLine(buffer);
		}
	};

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			yield* drain();
		}

		buffer += decoder.decode();
		yield* drain();

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) yield event;
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) yield trailingEvent;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Decode an SSE body and yield the JSON payload of every `data:` line,
 * skipping the OpenAI-style `[DONE]` sentinel. `onParseError` lets a provider
 * raise its own protocol error instead of the default.
 */
export async function* iterateSseJson<T>(
	response: Response,
	options?: { signal?: AbortSignal; onParseError?: (data: string, cause: unknown) => Error },
): AsyncGenerator<T> {
	if (!response.body) return;
	for await (const sse of iterateSse(response.body, options?.signal)) {
		const data = sse.data.trim();
		if (!data || data === "[DONE]") continue;
		let parsed: T;
		try {
			parsed = JSON.parse(data) as T;
		} catch (cause) {
			throw (
				options?.onParseError?.(data, cause) ??
				new Error(`Invalid SSE JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
			);
		}
		yield parsed;
	}
}
