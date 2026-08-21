import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../models.js";
import type {
	Api,
	CacheRetention,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.js";

export function buildBaseOptions(model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		transport: options?.transport,
		serviceTier: options?.serviceTier,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

/**
 * Resolve the API key for a `streamSimple*` entry point: the explicit option
 * wins, else the provider's environment key. Throws when neither is present.
 */
export function requireApiKey(provider: string, apiKey?: string): string {
	const resolved = apiKey || getEnvApiKey(provider);
	if (!resolved) {
		throw new Error(`No API key for provider: ${provider}`);
	}
	return resolved;
}

/** `buildBaseOptions` plus the API-key requirement shared by all `streamSimple*` wrappers. */
export function buildSimpleBaseOptions(model: Model<Api>, options?: SimpleStreamOptions): StreamOptions {
	return buildBaseOptions(model, options, requireApiKey(model.provider, options?.apiKey));
}

/**
 * Clamp the user-requested reasoning level to what the model supports and map
 * it to the effort value providers pass through (`off` becomes `undefined`).
 */
export function clampSimpleReasoning(
	model: Model<Api>,
	options?: SimpleStreamOptions,
): { clampedReasoning: ModelThinkingLevel | undefined; reasoningEffort: ThinkingLevel | undefined } {
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return { clampedReasoning, reasoningEffort };
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	baseMaxTokens: number,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
