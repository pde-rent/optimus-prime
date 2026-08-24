import { describe, expect, it } from "bun:test";
import {
	admitsGraphNode,
	DEFAULT_GRAPH_RESOLVER_LEVEL,
	GRAPH_RESOLVER_LEVELS,
	graphMinDepth,
	graphResolverBudget,
	isGraphResolverLevel,
} from "../src/core/graph-resolver.js";
import { buildSubagentGuidance } from "../src/core/prompts/rlm.js";

describe("graph resolver budget", () => {
	it("defaults to off, and off has no budget", () => {
		expect(DEFAULT_GRAPH_RESOLVER_LEVEL).toBe("off");
		expect(graphResolverBudget("off")).toBeUndefined();
	});

	it("raises ceiling and width monotonically with the dial", () => {
		const levels = GRAPH_RESOLVER_LEVELS.filter((l) => l !== "off");
		const budgets = levels.map((l) => graphResolverBudget(l)!);
		for (let i = 1; i < budgets.length; i++) {
			expect(budgets[i]!.ceilingTokens).toBeGreaterThan(budgets[i - 1]!.ceilingTokens);
			expect(budgets[i]!.maxNodes).toBeGreaterThan(budgets[i - 1]!.maxNodes);
		}
		expect(budgets[0]!.ceilingTokens).toBeGreaterThan(0);
	});

	it("treats graphMaxTokens as a clamp that can only lower the ceiling", () => {
		const uncapped = graphResolverBudget("max")!;
		const clamped = graphResolverBudget("max", 1000)!;
		expect(clamped.ceilingTokens).toBe(1000);
		// A clamp above the level's own ceiling must not raise it.
		const low = graphResolverBudget("low")!;
		const raised = graphResolverBudget("low", uncapped.ceilingTokens * 10)!;
		expect(raised.ceilingTokens).toBe(low.ceilingTokens);
	});

	it("unlimited admits always and ignores the clamp", () => {
		const budget = graphResolverBudget("unlimited", 1)!;
		expect(admitsGraphNode(Number.MAX_SAFE_INTEGER, budget, Number.MAX_SAFE_INTEGER - 1)).toBe(true);
		expect(graphMinDepth("unlimited")).toBe(2);
	});

	it("validates levels", () => {
		expect(isGraphResolverLevel("high")).toBe(true);
		expect(isGraphResolverLevel("aggressive")).toBe(false);
		expect(isGraphResolverLevel(3)).toBe(false);
	});
});

describe("depth reconciliation", () => {
	it("requires no depth when off", () => {
		expect(graphMinDepth("off")).toBe(0);
	});

	it("requires at least one level wherever a cohort can run", () => {
		// A flat fan-out puts children one level below whoever spawned them, so a max depth of 0
		// would make every worker spawn throw and the dial would silently do nothing.
		for (const level of GRAPH_RESOLVER_LEVELS.filter((l) => l !== "off")) {
			expect(graphMinDepth(level)).toBeGreaterThanOrEqual(1);
		}
	});

	it("never lowers depth as the dial rises", () => {
		const depths = GRAPH_RESOLVER_LEVELS.map(graphMinDepth);
		for (let i = 1; i < depths.length; i++) {
			expect(depths[i]!).toBeGreaterThanOrEqual(depths[i - 1]!);
		}
	});

	it("asks for a second tier only where the cohort is wide enough to nest", () => {
		expect(graphMinDepth("low")).toBe(1);
		expect(graphMinDepth("max")).toBe(2);
	});
});

describe("admission", () => {
	const budget = graphResolverBudget("medium")!;

	it("stops at the node cap", () => {
		expect(admitsGraphNode(0, budget, budget.maxNodes - 1)).toBe(true);
		expect(admitsGraphNode(0, budget, budget.maxNodes)).toBe(false);
	});

	it("stops at the token ceiling", () => {
		expect(admitsGraphNode(budget.ceilingTokens - 1, budget, 0)).toBe(true);
		expect(admitsGraphNode(budget.ceilingTokens, budget, 0)).toBe(false);
	});
});

describe("prompt", () => {
	it("renders no graph block by default, so the default path pays no prefix tokens", () => {
		const off = buildSubagentGuidance({});
		expect(off).not.toContain("Fan-out budget");
		expect(off).toContain("Never spawn to get more opinions on one problem");
	});

	it("replaces the absolute no-cohort rule when the dial is raised", () => {
		const on = buildSubagentGuidance({ graphResolver: "medium" });
		expect(on).toContain("Fan-out budget: medium");
		expect(on).not.toContain("Never spawn to get more opinions on one problem");
	});

	it("defaults a cohort to no sibling traffic, matching the message layer", () => {
		expect(buildSubagentGuidance({ graphResolver: "max" })).toContain("Default to `peers: []`");
	});
});

describe("cli flags", () => {
	it("accepts --effort as an alias for --thinking", async () => {
		const { parseArgs } = await import("../src/cli/args.js");
		expect(parseArgs(["--effort", "high"]).thinking).toBe("high");
		expect(parseArgs(["--thinking", "high"]).thinking).toBe("high");
	});

	it("parses the graph dial and its clamp", async () => {
		const { parseArgs } = await import("../src/cli/args.js");
		expect(parseArgs(["--graph", "high"]).graphResolver).toBe("high");
		expect(parseArgs(["--graph-max-tokens", "50000"]).graphMaxTokens).toBe(50_000);
	});

	it("warns rather than throwing on an invalid level", async () => {
		const { parseArgs } = await import("../src/cli/args.js");
		const parsed = parseArgs(["--graph", "aggressive"]);
		expect(parsed.graphResolver).toBeUndefined();
		expect(parsed.diagnostics.some((d) => d.type === "warning" && d.message.includes("aggressive"))).toBe(true);
	});

	it("parses the paired boolean settings flags", async () => {
		const { parseArgs } = await import("../src/cli/args.js");
		expect(parseArgs(["--no-dynamic-depth"]).dynamicDepth).toBe(false);
		expect(parseArgs(["--dynamic-depth"]).dynamicDepth).toBe(true);
		expect(parseArgs(["--no-compact"]).compaction).toBe(false);
		expect(parseArgs(["--no-retry"]).retry).toBe(false);
		expect(parseArgs(["--dynamic-effort", "banded"]).dynamicEffort).toBe("banded");
		expect(parseArgs(["--service-tier", "priority"]).serviceTier).toBe("priority");
		expect(parseArgs(["--rlm-max-depth", "3"]).rlmMaxDepth).toBe(3);
	});
});

describe("flag plumbing", () => {
	// The parser filling a field proves nothing: the field has to survive the hop into the runtime
	// config, and an earlier version of this feature parsed all of these and dropped every one.
	// Driven by the table so a new flag is covered the moment it is declared.
	it("carries every settings flag into the runtime config", async () => {
		const { parseArgs } = await import("../src/cli/args.js");
		const { runtimeConfigFromArgs } = await import("../src/main.js");
		const { SETTINGS_FLAGS } = await import("../src/cli/settings-flags.js");

		const argv: string[] = [];
		const expected = new Map<string, string | number | boolean>();
		for (const entry of SETTINGS_FLAGS) {
			if (entry.kind === "bool") {
				argv.push(`--no-${entry.flag.slice(2)}`);
				expected.set(entry.field, false);
				continue;
			}
			const value = entry.kind === "enum" ? entry.values[entry.values.length - 1]! : 3;
			argv.push(entry.flag, String(value));
			expected.set(entry.field, value);
		}

		const parsed = parseArgs(argv);
		expect(parsed.diagnostics).toEqual([]);
		const config = runtimeConfigFromArgs(parsed, "/tmp", "/tmp/agent", undefined, "interactive");
		for (const [field, value] of expected) {
			expect(config[field as keyof typeof config]).toBe(value);
		}
	});

	it("accepts the alias spellings", async () => {
		const { parseArgs } = await import("../src/cli/args.js");
		expect(parseArgs(["--effort", "high"]).thinking).toBe("high");
		expect(parseArgs(["--dynamic-depth"]).dynamicDepth).toBe(true);
	});
});
