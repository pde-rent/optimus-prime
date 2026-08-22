import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { createAssistantMessage } from "./assistant-message.js";

/**
 * A lazily loaded provider module, normalized to the two entry points the
 * registry needs. Each provider's dynamic import maps its concrete exported
 * names onto this shape; option types stay concrete at that boundary.
 */
interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options?: StreamOptions) => AsyncIterable<AssistantMessageEvent>;
	streamSimple: (
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AsyncIterable<AssistantMessageEvent>;
}

function forwardEvents(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return createAssistantMessage(model, {
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
	});
}

/**
 * Forward one call into the lazily imported provider module; module load
 * failures surface as an `error` event on the returned stream.
 */
function lazyCall<TApi extends Api>(
	load: () => Promise<LazyProviderModule<TApi>>,
	start: (module: LazyProviderModule<TApi>) => AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	load()
		.then((module) => forwardEvents(outer, start(module)))
		.catch((error) => {
			const message = createLazyLoadErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/** Cache a dynamic provider-module import so each module loads at most once. */
function cachedLoader<TApi extends Api>(
	load: () => Promise<LazyProviderModule<TApi>>,
): () => Promise<LazyProviderModule<TApi>> {
	let promise: Promise<LazyProviderModule<TApi>> | undefined;
	return () => (promise ??= load());
}

/**
 * Lazily load one built-in provider module and expose its `stream` /
 * `streamSimple` pair under the given API id.
 */
function lazyProvider<TApi extends Api>(
	api: TApi,
	load: () => Promise<LazyProviderModule<TApi>>,
): { api: TApi; stream: StreamFunction<TApi, StreamOptions>; streamSimple: StreamFunction<TApi, SimpleStreamOptions> } {
	const loader = cachedLoader(load);
	return {
		api,
		stream: (model, context, options) => lazyCall(loader, (module) => module.stream(model, context, options), model),
		streamSimple: (model, context, options) =>
			lazyCall(loader, (module) => module.streamSimple(model, context, options), model),
	};
}

export const { stream: streamAnthropic, streamSimple: streamSimpleAnthropic } = lazyProvider(
	"anthropic-messages",
	async () => {
		const module = await import("./anthropic.js");
		return { stream: module.streamAnthropic, streamSimple: module.streamSimpleAnthropic };
	},
);

export const { stream: streamAzureOpenAIResponses, streamSimple: streamSimpleAzureOpenAIResponses } = lazyProvider(
	"azure-openai-responses",
	async () => {
		const module = await import("./azure-openai-responses.js");
		return { stream: module.streamAzureOpenAIResponses, streamSimple: module.streamSimpleAzureOpenAIResponses };
	},
);

export const { stream: streamGrok, streamSimple: streamSimpleGrok } = lazyProvider("grok-responses", async () => {
	const module = await import("./grok.js");
	return { stream: module.streamGrok, streamSimple: module.streamSimpleGrok };
});

export const { stream: streamGoogle, streamSimple: streamSimpleGoogle } = lazyProvider(
	"google-generative-ai",
	async () => {
		const module = await import("./google.js");
		return { stream: module.streamGoogle, streamSimple: module.streamSimpleGoogle };
	},
);

export const { stream: streamMistral, streamSimple: streamSimpleMistral } = lazyProvider(
	"mistral-conversations",
	async () => {
		const module = await import("./mistral.js");
		return { stream: module.streamMistral, streamSimple: module.streamSimpleMistral };
	},
);

export const { stream: streamOpenAICodexResponses, streamSimple: streamSimpleOpenAICodexResponses } = lazyProvider(
	"openai-codex-responses",
	async () => {
		const module = await import("./openai-codex-responses.js");
		return { stream: module.streamOpenAICodexResponses, streamSimple: module.streamSimpleOpenAICodexResponses };
	},
);

export const { stream: streamOpenAICompletions, streamSimple: streamSimpleOpenAICompletions } = lazyProvider(
	"openai-completions",
	async () => {
		const module = await import("./openai-completions.js");
		return { stream: module.streamOpenAICompletions, streamSimple: module.streamSimpleOpenAICompletions };
	},
);

export const { stream: streamOpenAIResponses, streamSimple: streamSimpleOpenAIResponses } = lazyProvider(
	"openai-responses",
	async () => {
		const module = await import("./openai-responses.js");
		return { stream: module.streamOpenAIResponses, streamSimple: module.streamSimpleOpenAIResponses };
	},
);

// One concrete-typed registrar per API keeps StreamFunction generics intact.
const REGISTER_BUILTIN_APIS: readonly (() => void)[] = [
	() =>
		registerApiProvider({ api: "anthropic-messages", stream: streamAnthropic, streamSimple: streamSimpleAnthropic }),
	() =>
		registerApiProvider({
			api: "openai-completions",
			stream: streamOpenAICompletions,
			streamSimple: streamSimpleOpenAICompletions,
		}),
	() =>
		registerApiProvider({ api: "mistral-conversations", stream: streamMistral, streamSimple: streamSimpleMistral }),
	() =>
		registerApiProvider({
			api: "openai-responses",
			stream: streamOpenAIResponses,
			streamSimple: streamSimpleOpenAIResponses,
		}),
	() =>
		registerApiProvider({
			api: "azure-openai-responses",
			stream: streamAzureOpenAIResponses,
			streamSimple: streamSimpleAzureOpenAIResponses,
		}),
	() =>
		registerApiProvider({
			api: "openai-codex-responses",
			stream: streamOpenAICodexResponses,
			streamSimple: streamSimpleOpenAICodexResponses,
		}),
	() => registerApiProvider({ api: "grok-responses", stream: streamGrok, streamSimple: streamSimpleGrok }),
	() => registerApiProvider({ api: "google-generative-ai", stream: streamGoogle, streamSimple: streamSimpleGoogle }),
];

export function registerBuiltInApiProviders(): void {
	for (const register of REGISTER_BUILTIN_APIS) {
		register();
	}
}

export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
