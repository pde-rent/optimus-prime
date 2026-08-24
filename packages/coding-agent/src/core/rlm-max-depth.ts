/** Wire-safe types for the immediate /rlm-max-depth state APIs. */

/**
 * Configured recursion ceiling. "unlimited" removes the ceiling entirely; numbers are the usual
 * non-negative depths. JSON-safe by construction: it is persisted and sent over the daemon wire.
 */
export type RlmMaxDepthValue = number | "unlimited";

export function isRlmMaxDepthValue(value: unknown): value is RlmMaxDepthValue {
	return value === "unlimited" || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/** Whether one more spawn level is below the configured ceiling. */
export function admitsRlmDepth(depth: number, maxDepth: RlmMaxDepthValue): boolean {
	return maxDepth === "unlimited" || depth < maxDepth;
}

/**
 * "graph" means the graph budget raised the configured value to what its shapes need.
 * "chat" is a user pin the graph must not override; "model" is the model's own
 * `rlm.set_max_depth`, which is a preference the graph floor may still raise.
 */
export type RlmMaxDepthSource = "default" | "env" | "global" | "inherited" | "chat" | "model" | "graph";

export interface RlmMaxDepthStatus {
	maxDepth: RlmMaxDepthValue;
	source: RlmMaxDepthSource;
}

export interface SetRlmMaxDepthResult extends RlmMaxDepthStatus {
	globalSaved: boolean;
	globalError?: string;
}

/** One remedy a host may offer when a spawn hits the recursion ceiling. */
export type DepthLimitExhaustedChoice = "raise" | "unlimited" | "cancel";

export interface DepthLimitExhaustedInfo {
	depth: number;
	maxDepth: RlmMaxDepthValue;
}

/**
 * Host-injected prompt shown when a spawn hits the ceiling. Absent means non-interactive: the
 * caller applies its own default (usually "raise") instead of asking.
 */
export type DepthLimitExhaustedCallback = (info: DepthLimitExhaustedInfo) => Promise<DepthLimitExhaustedChoice>;
