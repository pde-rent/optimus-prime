import { getEnvApiKey } from "../env-api-keys.js";
import type { Api, Context, Model, StreamOptions } from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { requestWithRetry } from "../utils/http.js";
import {
	iterateOpenAIStream,
	type OpenAIResponsesStreamOptions,
	processResponsesStream,
} from "./openai-responses-shared.js";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "./openai-wire-types.js";
import { runProviderStream } from "./stream-runner.js";

/** What a provider on the OpenAI Responses wire contributes: where to call, what to send. */
export interface ResponsesWireRequest {
	url: string;
	headers: Record<string, string>;
	params: ResponseCreateParamsStreaming;
	/** Extra normalization handed to the shared responses stream processor. */
	processOptions?: OpenAIResponsesStreamOptions;
}

export interface ResponsesWireProvider<TApi extends Api, TOptions extends StreamOptions> {
	buildRequest: (
		model: Model<TApi>,
		context: Context,
		options: TOptions | undefined,
		apiKey: string,
	) => ResponsesWireRequest;
}

/**
 * One implementation of "POST JSON to an OpenAI Responses endpoint and
 * normalize its SSE into agent events". The onPayload/onResponse hook order,
 * retry, request-id capture, start push, scratch keys and the shared stream
 * processor are identical for every provider on this wire; providers only
 * assemble url/headers/params.
 */
export function createResponsesWireStream<TApi extends Api, TOptions extends StreamOptions>(
	provider: ResponsesWireProvider<TApi, TOptions>,
): (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		let requestId: string | undefined;

		return runProviderStream(
			model,
			options,
			async (output, stream) => {
				const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
				let request = provider.buildRequest(model, context, options, apiKey);
				const nextParams = await options?.onPayload?.(request.params, model);
				if (nextParams !== undefined) {
					request = { ...request, params: nextParams as ResponseCreateParamsStreaming };
				}
				const response = await requestWithRetry({
					url: request.url,
					headers: request.headers,
					body: JSON.stringify(request.params),
					signal: options?.signal,
					timeoutMs: options?.timeoutMs,
					maxRetries: options?.maxRetries,
				});
				const openaiStream = iterateOpenAIStream<ResponseStreamEvent>(response, options?.signal);
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				requestId = response.headers.get("x-request-id") ?? undefined;
				stream.push({ type: "start", partial: output });

				await processResponsesStream(openaiStream, output, stream, model, request.processOptions);
			},
			{
				getRequestId: () => requestId,
				scratchKeys: ["index", "partialJson"],
			},
		);
	};
}
