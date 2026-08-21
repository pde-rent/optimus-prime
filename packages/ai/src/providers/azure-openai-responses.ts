import { getEnvApiKey } from "../env-api-keys.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { joinUrl, mergeHeaders, requestWithRetry } from "../utils/http.js";
import { failAssistantStream, streamFailureFromStopReason } from "../utils/stream-failure.js";
import { createAssistantMessage } from "./assistant-message.js";
import {
	applyResponsesReasoningParams,
	convertResponsesMessages,
	convertResponsesTools,
	iterateOpenAIStream,
	openaiDefaultHeaders,
	processResponsesStream,
} from "./openai-responses-shared.js";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "./openai-wire-types.js";
import { buildSimpleBaseOptions, clampSimpleReasoning } from "./simple-options.js";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]);

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap(process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id);
	return mappedDeployment || model.id;
}

export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const deploymentName = resolveDeploymentName(model, options);
		const output = createAssistantMessage(model);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { url, headers } = createClient(model, apiKey, options);
			let params = buildParams(model, context, options, deploymentName);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const response = await requestWithRetry({
				url,
				headers,
				body: JSON.stringify(params),
				signal: options?.signal,
				timeoutMs: options?.timeoutMs,
				maxRetries: options?.maxRetries,
			});
			const openaiStream = iterateOpenAIStream<ResponseStreamEvent>(response, options?.signal);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			const requestId = response.headers.get("x-request-id") ?? undefined;
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw streamFailureFromStopReason(output.stopReasonRaw, { requestId });
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			failAssistantStream(model, output, stream, error, {
				aborted: options?.signal?.aborted === true,
				scratchKeys: ["index", "partialJson"],
			});
		}
	})();

	return stream;
};

export const streamSimpleAzureOpenAIResponses: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildSimpleBaseOptions(model, options);
	const { reasoningEffort } = clampSimpleReasoning(model, options);

	return streamAzureOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".cognitiveservices.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
	// can append /deployments/<model>/... and ?api-version=v1 correctly.
	if (isAzureHost && (normalizedPath === "" || normalizedPath === "/" || normalizedPath === "/openai")) {
		url.pathname = "/openai/v1";
		url.search = "";
	}

	return url.toString().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || process.env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
		apiVersion,
	};
}

function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	if (!apiKey) {
		if (!process.env.AZURE_OPENAI_API_KEY) {
			throw new Error(
				"Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.AZURE_OPENAI_API_KEY;
	}

	const headers = { ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	// `/responses` is not in the AzureOpenAI SDK's `_deployments_endpoints`, so
	// unlike `/chat/completions` it gets no `/deployments/<model>` path segment;
	// the deployment travels in the body's `model` field instead. `api-version`
	// is the SDK's `defaultQuery`, and `api-key` its Azure auth header.
	return {
		url: joinUrl(baseUrl, "/responses", { "api-version": apiVersion }),
		headers: mergeHeaders(openaiDefaultHeaders("AzureOpenAI"), { "api-key": apiKey }, headers),
	};
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
) {
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS);

	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: options?.sessionId,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	applyResponsesReasoningParams(params, model, options ?? {}, true);

	return params;
}
