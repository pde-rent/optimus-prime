import type {
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ServiceTier,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
	applyCopilotRequestHeaders,
	applyResponsesReasoningParams,
	applyServiceTierCostMultiplier,
	convertResponsesMessages,
	convertResponsesTools,
	finalizeOpenAIRequest,
	resolveOpenAIApiKey,
} from "./openai-responses-shared.js";
import type { ResponseCreateParamsStreaming } from "./openai-wire-types.js";
import { createResponsesWireStream } from "./responses-wire.js";
import { buildSimpleBaseOptions, clampSimpleReasoning, resolveCacheRetention } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
}

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> =
	createResponsesWireStream({
		buildRequest: (model, context, options, apiKey) => {
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const { url, headers } = createClient(model, context, apiKey, options?.headers, cacheSessionId);
			return {
				url,
				headers,
				params: buildParams(model, context, options),
				processOptions: {
					serviceTier: options?.serviceTier,
					applyServiceTierPricing: (usage, serviceTier) =>
						applyServiceTierCostMultiplier(usage, serviceTier, getServiceTierCostMultiplier(model, serviceTier)),
				},
			};
		},
	});

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildSimpleBaseOptions(model, options);
	const { reasoningEffort } = clampSimpleReasoning(model, options);

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
) {
	const key = resolveOpenAIApiKey(apiKey);

	const compat = getCompat(model);
	const headers = { ...model.headers };
	applyCopilotRequestHeaders(model, context, headers);

	if (sessionId) {
		if (compat.sendSessionIdHeader) {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}

	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return finalizeOpenAIRequest(model, key, headers, "/responses");
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const compat = getCompat(model);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	applyResponsesReasoningParams(params, model, options ?? {}, model.provider !== "github-copilot");

	return params;
}

// Multipliers per https://developers.openai.com/api/docs/pricing (retrieved 2026-08-21)
function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ServiceTier | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}
