/** Wire-safe types for the immediate /rlm-max-depth state APIs. */

/** "graph" means the graph budget raised the configured value to what its shapes need. */
export type RlmMaxDepthSource = "default" | "env" | "global" | "inherited" | "chat" | "graph";

export interface RlmMaxDepthStatus {
	maxDepth: number;
	source: RlmMaxDepthSource;
}

export interface SetRlmMaxDepthResult extends RlmMaxDepthStatus {
	globalSaved: boolean;
	globalError?: string;
}
