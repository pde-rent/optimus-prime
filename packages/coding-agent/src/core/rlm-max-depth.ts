/** Wire-safe types for the immediate /rlm-max-depth state APIs. */

/**
 * "graph" means the graph budget raised the configured value to what its shapes need.
 * "chat" is a user pin the graph must not override; "model" is the model's own
 * `rlm.set_max_depth`, which is a preference the graph floor may still raise.
 */
export type RlmMaxDepthSource = "default" | "env" | "global" | "inherited" | "chat" | "model" | "graph";

export interface RlmMaxDepthStatus {
	maxDepth: number;
	source: RlmMaxDepthSource;
}

export interface SetRlmMaxDepthResult extends RlmMaxDepthStatus {
	globalSaved: boolean;
	globalError?: string;
}
