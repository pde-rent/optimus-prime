import type * as NodeOs from "node:os";

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
let _os: typeof NodeOs | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_os = m as typeof NodeOs;
	});
}

import { getEnvApiKey } from "../env-api-keys.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { requestWithRetry } from "../utils/http.js";
import { sanitizeGrokPayload } from "./grok-payload.js";
import {
	applyResponsesReasoningParams,
	convertResponsesMessages,
	convertResponsesTools,
	iterateOpenAIStream,
	processResponsesStream,
} from "./openai-responses-shared.js";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "./openai-wire-types.js";
import { buildSimpleBaseOptions, clampSimpleReasoning } from "./simple-options.js";
import { runProviderStream } from "./stream-runner.js";

const GROK_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLIENT_IDENTIFIER = "grok-shell";
const GROK_CLIENT_VERSION = "0.2.101";
// The proxy only accepts reasoning effort for these model families.
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface GrokStreamOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

function resolvePlatformName(): string {
	if (_os) {
		return _os.platform() === "darwin" ? "macos" : _os.platform();
	}
	return "unknown";
}

function buildGrokHeaders(model: Model<"grok-responses">, apiKey: string): Record<string, string> {
	const arch = _os?.arch() ?? "unknown";
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": `${GROK_CLIENT_IDENTIFIER}/${GROK_CLIENT_VERSION} (${resolvePlatformName()}; ${arch})`,
		"x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
		"x-grok-client-version": GROK_CLIENT_VERSION,
		"x-grok-client-mode": "interactive",
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
		"x-grok-model-override": model.id,
	};
}

function resolveProxyUrl(model: Model<"grok-responses">): string {
	const raw = model.baseUrl?.trim() || GROK_PROXY_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function buildParams(
	model: Model<"grok-responses">,
	context: Context,
	options?: GrokStreamOptions,
): ResponseCreateParamsStreaming {
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS),
		stream: true,
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options.maxTokens;
	}
	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	applyResponsesReasoningParams(params, model, options ?? {}, false);

	return params;
}

export const streamGrok: StreamFunction<"grok-responses", GrokStreamOptions> = (
	model: Model<"grok-responses">,
	context: Context,
	options?: GrokStreamOptions,
): AssistantMessageEventStream => {
	let requestId: string | undefined;

	return runProviderStream(
		model,
		options,
		async (output, stream) => {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			let params = sanitizeGrokPayload(buildParams(model, context, options), model.id);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const response = await requestWithRetry({
				url: resolveProxyUrl(model),
				headers: { ...buildGrokHeaders(model, apiKey), ...options?.headers },
				body: JSON.stringify(params),
				signal: options?.signal,
				timeoutMs: options?.timeoutMs,
				maxRetries: options?.maxRetries,
			});
			const openaiStream = iterateOpenAIStream<ResponseStreamEvent>(response, options?.signal);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			requestId = response.headers.get("x-request-id") ?? undefined;
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model);
		},
		{
			getRequestId: () => requestId,
			scratchKeys: ["index", "partialJson"],
		},
	);
};

export const streamSimpleGrok: StreamFunction<"grok-responses", SimpleStreamOptions> = (
	model: Model<"grok-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildSimpleBaseOptions(model, options);
	const { reasoningEffort } = clampSimpleReasoning(model, options);

	return streamGrok(model, context, {
		...base,
		reasoningEffort,
	} satisfies GrokStreamOptions);
};
