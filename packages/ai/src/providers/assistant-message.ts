import type { Api, AssistantMessage, Model } from "../types.js";

/**
 * Zero-initialized assistant message every provider stream starts from.
 * `overrides` lets callers adjust fields (e.g. an initial error stop reason).
 */
export function createAssistantMessage<TApi extends Api>(
	model: Model<TApi>,
	overrides?: Partial<AssistantMessage>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}
