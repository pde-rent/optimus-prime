import type {
	AnthropicMessagesCompat,
	Api,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	ThinkingLevelMap,
} from "./types.js";

/** Shape of a generated `compat` constant: one of the per-API compat interfaces. */
export type CompatData = OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

/** Shape of a generated `thinkingLevelMap` constant. */
export type ThinkingLevelMapData = ThinkingLevelMap;

/**
 * Runtime expander for the compact generated-models data in `models.generated.ts`.
 *
 * The generated file stores one terse record per model and hoists fields shared by a provider
 * (api, baseUrl, compat) to the provider level. `expandModels` reconstructs the full
 * `Model` objects lazily at import time. The compact shape is bit-for-bit equivalent to
 * emitting every `Model` as a literal; it only exists to keep the generated file small.
 */

/** Per-model overrides applied on top of the provider-level defaults. */
export interface ModelOverrides {
	/** Overrides the provider-level `api`. */
	a?: Api;
	/** Overrides the provider-level `baseUrl`. */
	u?: string;
	/** Static request headers for this model. */
	h?: Record<string, string>;
	/** Compatibility overrides; `null` clears the provider-level default (shape depends on the resolved `api`). */
	c?: unknown;
	/** Maps pi thinking levels to provider/model-specific values. */
	t?: unknown;
	/** Flagship model surfaced above non-featured models of the same provider in pickers. */
	f?: 1;
}

/**
 * A generated model: [name, reasoning, input, contextWindow, maxTokens], optionally followed by a
 * cost tuple [input, output, cacheRead, cacheWrite] in $/million tokens (omitted when all four
 * are zero) and/or a provider-default overrides object.
 */
export type ModelCost = readonly [input: number, output: number, cacheRead: number, cacheWrite: number];

type ModelTail =
	| readonly []
	| readonly [cost: ModelCost]
	| readonly [cost: ModelCost, o: ModelOverrides]
	| readonly [o: ModelOverrides];

export type ModelRecord = readonly [
	name: string,
	reasoning: boolean,
	input: 0 | 1,
	contextWindow: number,
	maxTokens: number,
	...tail: ModelTail,
];

/** Provider-level defaults shared by all models under the same provider key. */
export interface ProviderRecord {
	api: Api;
	baseUrl?: string;
	compat?: unknown;
	m: { readonly [id: string]: ModelRecord };
}

type OverridesOf<R> = R extends readonly [...unknown[], infer Last]
	? Last extends readonly unknown[]
		? unknown // trailing element is a cost tuple, not overrides
		: Last
	: unknown;

type ApiOf<Provider, R> =
	OverridesOf<R> extends { a: infer TApi }
		? TApi extends Api
			? TApi
			: Api
		: Provider extends { api: infer TApi }
			? TApi extends Api
				? TApi
				: Api
			: Api;

export type ExpandedModels<D extends Readonly<Record<string, ProviderRecord>>> = {
	readonly [P in keyof D]: {
		readonly [M in keyof D[P]["m"]]: Model<ApiOf<D[P], D[P]["m"][M]>>;
	};
};

/** Rebuilds full `Model` objects from compact provider/model records. */
export function expandModels<const D extends Readonly<Record<string, ProviderRecord>>>(data: D): ExpandedModels<D> {
	const providers: Record<string, Record<string, Model<Api>>> = {};
	for (const [providerId, pdata] of Object.entries(data)) {
		const models: Record<string, Model<Api>> = {};
		for (const [id, record] of Object.entries(pdata.m)) {
			const [name, reasoning, inputFlag, contextWindow, maxTokens] = record;
			// With cost omitted, the trailing element is the overrides object; tell them apart by shape.
			const tail = record.slice(5);
			const cost = tail.find((entry): entry is ModelCost => Array.isArray(entry));
			const o = tail.find(
				(entry): entry is ModelOverrides => entry != null && typeof entry === "object" && !Array.isArray(entry),
			);
			const api = o?.a ?? pdata.api;
			const baseUrl = o?.u ?? pdata.baseUrl;
			const headers = o?.h;
			const compat = o == null ? pdata.compat : "c" in o ? o.c : pdata.compat;
			const thinkingLevelMap = o?.t;
			const input = inputFlag === 1 ? ["text", "image"] : ["text"];
			const costFull = {
				input: cost?.[0] ?? 0,
				output: cost?.[1] ?? 0,
				cacheRead: cost?.[2] ?? 0,
				cacheWrite: cost?.[3] ?? 0,
			};
			// Property order mirrors the field order of the previous literal-based generated file.
			const model = { id, name, api, provider: providerId } as Record<string, unknown>;
			if (baseUrl !== undefined) {
				model.baseUrl = baseUrl;
			}
			if (headers) {
				model.headers = headers;
			}
			if (compat !== undefined) {
				model.compat = compat;
			}
			model.reasoning = reasoning;
			if (thinkingLevelMap) {
				model.thinkingLevelMap = thinkingLevelMap;
			}
			model.input = input;
			model.cost = costFull;
			model.contextWindow = contextWindow;
			model.maxTokens = maxTokens;
			if (o?.f) {
				model.featured = true;
			}
			models[id] = model as unknown as Model<Api>;
		}
		providers[providerId] = models;
	}
	return providers as ExpandedModels<D>;
}
