/**
 * Budget dial for resolving one task with several agents instead of one.
 *
 * Off by default: the agent spawns children as it always has, up to `rlmMaxDepth`. Raising the
 * dial grants a spend multiple deliberately, and tasks become eligible for a cohort.
 *
 * One dial, not two. A strategy enum plus a spend multiplier would contradict each other —
 * "aggressive at 2x" has no meaning — and the intent moves both together, so it is one degree of
 * freedom. `graphMaxTokens` is a clamp: it only ever lowers a level's ceiling.
 */

export type GraphResolverLevel = "off" | "min" | "low" | "medium" | "high" | "max" | "unlimited";

export const DEFAULT_GRAPH_RESOLVER_LEVEL: GraphResolverLevel = "off";

export const GRAPH_RESOLVER_LEVELS: readonly GraphResolverLevel[] = [
	"off",
	"low",
	"medium",
	"high",
	"max",
	"unlimited",
] as const;

/**
 * Reference cost of one solo run, in tokens. A fixed constant, not a measurement: the ceiling is a
 * multiple of what one agent would have cost, and that run never happens.
 */
const GRAPH_BASELINE_TOKENS = 250_000;

interface GraphResolverBudget {
	ceilingTokens: number;
	maxNodes: number;
}

const LEVEL_BUDGETS: Record<
	Exclude<GraphResolverLevel, "off" | "unlimited">,
	{ multiplier: number; maxNodes: number }
> = {
	min: { multiplier: 3, maxNodes: 2 },
	low: { multiplier: 6, maxNodes: 4 },
	medium: { multiplier: 20, maxNodes: 6 },
	high: { multiplier: 50, maxNodes: 10 },
	max: { multiplier: 200, maxNodes: 16 },
};

export function graphResolverBudget(
	level: GraphResolverLevel,
	maxTokensClamp?: number,
): GraphResolverBudget | undefined {
	if (level === "off") return undefined;
	if (level === "unlimited") return { ceilingTokens: Number.POSITIVE_INFINITY, maxNodes: Number.POSITIVE_INFINITY };
	const { multiplier, maxNodes } = LEVEL_BUDGETS[level];
	const ceiling = multiplier * GRAPH_BASELINE_TOKENS;
	return {
		ceilingTokens: maxTokensClamp !== undefined ? Math.min(ceiling, maxTokensClamp) : ceiling,
		maxNodes,
	};
}

export function isGraphResolverLevel(value: unknown): value is GraphResolverLevel {
	return typeof value === "string" && (GRAPH_RESOLVER_LEVELS as readonly string[]).includes(value);
}

/**
 * Recursion depth the level's shapes need, or 0 when off. Children sit one level below their
 * spawner, so any level needs 1 or every spawn throws and the dial is silently inert; wide levels
 * need 2 because their prompt lets a worker split its own unit again.
 *
 * Folded into the depth setting rather than raised and restored per graph: raising mid-run voids
 * the prompt cache, and a child captures its depth at spawn so a restore cannot reach it.
 */
export function graphMinDepth(level: GraphResolverLevel): number {
	if (level === "off") return 0;
	if (level === "unlimited") return 2;
	return LEVEL_BUDGETS[level].maxNodes >= 6 ? 2 : 1;
}

/**
 * Whether one more child may be admitted. Admission is the only synchronous chokepoint — `rlm()`
 * returns before a child has done anything — so the ceiling is soft by the work already in flight.
 *
 * Counters are per-agent: a worker that splits again draws on its own ceiling, not its parent's, so
 * the reachable worst case is the ceiling times the number of spawners.
 */
export function admitsGraphNode(spentTokens: number, budget: GraphResolverBudget, admittedNodes: number): boolean {
	return admittedNodes < budget.maxNodes && spentTokens < budget.ceilingTokens;
}

/**
 * The spend ladder in rising order, used to promote a session one tier when an exhausted budget
 * prompts for a remedy. "off" has nothing to raise.
 */
const TIER_LADDER: readonly GraphResolverLevel[] = [
	...(Object.keys(LEVEL_BUDGETS) as Array<Exclude<GraphResolverLevel, "off" | "unlimited">>),
	"unlimited",
];

/** The next tier up, or "unlimited" past the top. "off" and unknown levels promote to the lowest tier. */
export function raiseGraphResolverLevel(level: GraphResolverLevel): GraphResolverLevel {
	if (level === "off") return TIER_LADDER[0] ?? "unlimited";
	const index = (TIER_LADDER as readonly string[]).indexOf(level);
	if (index === -1) return TIER_LADDER[0] ?? "unlimited";
	return TIER_LADDER[index + 1] ?? "unlimited";
}

/** One remedy a host may offer when the graph budget refuses another child. */
export type GraphBudgetExhaustedChoice = "reset" | "tier" | "unlimited" | "cancel";

export interface GraphBudgetExhaustedInfo {
	level: GraphResolverLevel;
	spentTokens: number;
	ceilingTokens: number;
	nodes: number;
	maxNodes: number;
}

/**
 * Host-injected prompt shown when admission refuses. Absent means non-interactive: the caller
 * applies its own default (usually "reset") instead of asking.
 */
export type GraphBudgetExhaustedCallback = (info: GraphBudgetExhaustedInfo) => Promise<GraphBudgetExhaustedChoice>;
