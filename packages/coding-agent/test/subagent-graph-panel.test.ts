import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { nodesFromChildSnapshots, summarizeChildSnapshots } from "../src/modes/agents-tree/agent-tree-model.js";
import {
	clickToOpenAgent,
	parseOpenAgentTarget,
	setClickTargetsEnabled,
} from "../src/modes/interactive/components/click-target.js";
import {
	formatSubagentGraph,
	SUBAGENT_GRAPH_MAX_ROWS,
	SUBAGENT_GRAPH_MAX_RUNNING,
	SubagentGraphPanel,
	type SubagentGraphRow,
} from "../src/modes/interactive/components/subagent-graph-panel.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import stripAnsi from "../src/utils/ansi.js";

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

const fanOut = [
	child("a", "running", {
		parentId: "root",
		label: "Audit gateway auth token handling end to end",
		sessionName: "subagent-explore-auth-flows-a1b2c3d4",
		tokenCount: 12400,
		tokensIn: 12000,
		tokensOut: 400,
		toolUseCount: 8,
		durationMs: 62_000,
		activeSessionId: "active-a",
		activity: { kind: "executing", toolName: "Read" },
	}),
	child("b", "done", {
		parentId: "root",
		label: "write regression tests for the parser",
		model: "anthropic/claude-sonnet-4-5",
		tokenCount: 9100,
		tokensIn: 8800,
		tokensOut: 300,
		toolUseCount: 14,
		durationMs: 47_000,
	}),
	child("c", "error", {
		parentId: "root",
		label: "bench-runner",
		model: "openai/gpt-5-codex",
		tokenCount: 2000,
		toolUseCount: 1,
		durationMs: 12_000,
		error: "boom",
	}),
];

describe("subagent graph tree assembly (shared agents-tree model)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("builds a two-level tree from a flat snapshot list", () => {
		const rows = nodesFromChildSnapshots(
			[...fanOut, child("d", "running", { parentId: "a", label: "grep-callers" })],
			"root",
		);

		expect(rows.map((row) => [row.node.child.id, row.depth, row.prefix, row.descendants])).toEqual([
			["a", 0, "├─", 1],
			["d", 1, "│ └─", 0],
			["b", 0, "├─", 0],
			["c", 0, "└─", 0],
		]);
	});

	it("counts descendants at every depth, not just direct children", () => {
		const rows = nodesFromChildSnapshots(
			[
				child("a", "running", { parentId: "root" }),
				child("b", "running", { parentId: "a" }),
				child("c", "running", { parentId: "b" }),
				child("d", "running", { parentId: "a" }),
			],
			"root",
		);

		expect(rows.map((row) => [row.node.child.id, row.depth, row.descendants])).toEqual([
			["a", 0, 3],
			["b", 1, 1],
			["c", 2, 0],
			["d", 1, 0],
		]);
	});

	it("keeps children whose parent is unknown as top-level rows", () => {
		const rows = nodesFromChildSnapshots(
			[child("orphan", "running", { parentId: "evicted" }), child("direct", "running", { parentId: "root" })],
			"root",
		);

		expect(rows.map((row) => row.node.child.id).sort()).toEqual(["direct", "orphan"]);
		expect(rows.every((row) => row.depth === 0)).toBe(true);
	});

	it("drops cancelled children and survives a parent cycle", () => {
		const rows = nodesFromChildSnapshots(
			[
				child("gone", "cancelled", { parentId: "root" }),
				child("x", "running", { parentId: "y" }),
				child("y", "running", { parentId: "x" }),
			],
			"root",
		);

		expect(rows.map((row) => row.node.child.id)).toEqual(["x", "y"]);
	});

	it("sums aggregates across the whole tree", () => {
		const rows = nodesFromChildSnapshots(
			[
				...fanOut,
				child("d", "queued", { parentId: "a", tokenCount: 500 }),
				// A terminal child with live activity is a follow-up turn, so it counts as running.
				child("e", "done", { parentId: "root", tokenCount: 100, activity: { kind: "writing" } }),
			],
			"root",
		);

		expect(summarizeChildSnapshots(rows)).toEqual({
			total: 5,
			running: 3,
			done: 1,
			errored: 1,
			tokens: 24_100,
		});
	});
});

describe("subagent graph rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders nothing without children", () => {
		expect(formatSubagentGraph([], 80)).toEqual([]);
		const panel = new SubagentGraphPanel();
		panel.setChildren([], undefined);
		expect(panel.render(80)).toEqual([]);
		expect(panel.isVisible()).toBe(false);
		expect(panel.toggle()).toBe(false);
	});

	it("leads with the root row and renders running children as lean rows", () => {
		const lines = formatSubagentGraph(nodesFromChildSnapshots(fanOut, "root"), 120).map(stripAnsi);

		expect(lines).toHaveLength(3); // root + one running row + done summary
		expect(lines[0]).toMatch(/^● main /);
		expect(lines[0]).toContain("1/3 running · 1 error");
		expect(lines[0]).toContain("↓ 24k");
		// The running row carries only the de-slugged name, never task text.
		expect(lines[1]).toContain("explore auth flows");
		expect(lines[1]).not.toContain("Audit gateway");
		expect(lines[1]?.trimEnd().endsWith("1m 02s ·  ↓ 12k ↑ 400 · 12k")).toBe(true);
		// Finished children collapse into one aggregated branch row.
		expect(lines[2]).toContain("2 agents done (1 succeeded, 1 failed)");
		expect(lines[2]?.trimEnd().endsWith("59s · ↓ 8.8k ↑ 300")).toBe(true);
		// The generated session slug never reaches the user.
		expect(lines.join("\n")).not.toContain("a1b2c3d4");
		expect(lines.join("\n")).not.toContain("subagent-");
	});

	it("renders a context-pressure cell against the child model window", () => {
		const rows = nodesFromChildSnapshots(
			[
				child("a", "running", {
					parentId: "root",
					label: "alpha",
					tokenCount: 5000,
					tokensIn: 4800,
					contextWindow: 100_000,
				}),
				child("b", "running", { parentId: "root", label: "beta", tokenCount: 9100, contextWindow: 200_000 }),
			],
			"root",
		);
		const lines = formatSubagentGraph(rows, 140).map(stripAnsi);
		expect(lines[1]?.trimEnd().endsWith("↓ 4.8k · 5.0k/100k 5%")).toBe(true);
		expect(lines[2]).toContain("9.1k/200k 5%");
	});

	it("keeps the last snapshotted context window when a later snapshot omits it", () => {
		const panel = new SubagentGraphPanel();
		panel.setChildren(
			[child("a", "running", { parentId: "root", label: "alpha", tokenCount: 5000, contextWindow: 100_000 })],
			"root",
		);
		expect(panel.render(140).map(stripAnsi).join("\n")).toContain("5.0k/100k 5%");
		panel.setChildren([child("a", "running", { parentId: "root", label: "alpha", tokenCount: 6000 })], "root");
		expect(panel.render(140).map(stripAnsi).join("\n")).toContain("6.0k/100k 6%");
	});

	it("never shows recaps, prompts, or error text on a row", () => {
		const rows = nodesFromChildSnapshots(
			[{ ...fanOut[0], recap: "Added retry coverage" } as AgentConnectionRlmChildAgentSnapshot],
			"root",
		);
		const joined = formatSubagentGraph(rows, 160).map(stripAnsi).join("\n");
		expect(joined).toContain("explore auth flows");
		expect(joined).not.toContain("Added retry coverage");
		expect(joined).not.toContain("Audit gateway");

		// Failed children surface only through the done-summary counters.
		const failed = formatSubagentGraph(nodesFromChildSnapshots([fanOut[2]], "root"), 120).map(stripAnsi);
		expect(failed.join("\n")).not.toContain("boom");
		expect(failed[1]).toContain("1 agent done (0 succeeded, 1 failed)");
	});

	it("shows the shared spinner on running rows and folds every other status into the summaries", () => {
		const rows = nodesFromChildSnapshots(
			[
				...fanOut,
				child("d", "done", { parentId: "root", activeSessionId: "active-d" }), // idle
				child("e", "queued", { parentId: "root" }), // waiting
			],
			"root",
		);
		const lines = formatSubagentGraph(rows, 160).map(stripAnsi);

		expect(lines).toHaveLength(3);
		// Running uses the shared braille spinner, not a static circle.
		expect(lines[1]).toContain("⠋");
		// Idle counts as a finished success; waiting stays in the root tally only.
		expect(lines[2]).toContain("3 agents done (2 succeeded, 1 failed)");
		expect(lines.join("\n")).not.toContain("bench-runner");
		expect(lines.join("\n")).not.toContain("write regression");
	});

	it("nests running rows at their real depth with the branch glued to the glyph", () => {
		const lines = formatSubagentGraph(
			nodesFromChildSnapshots(
				[
					...fanOut,
					child("d", "running", { parentId: "a", label: "grep-callers" }),
					child("e", "running", { parentId: "d", label: "read-callers" }),
					child("f", "running", { parentId: "a", label: "index-callers" }),
				],
				"root",
			),
			160,
		).map(stripAnsi);

		// Prefixes are recomputed over the visible forest: a closes its bucket.
		expect(lines[1]).toMatch(/^└─⠋ /);
		expect(lines[2]).toMatch(/^ {2}├─⠋ /); // d
		expect(lines[3]).toMatch(/^ {2}│ └─⠋ /); // e, a grandchild at real depth
		expect(lines[4]).toMatch(/^ {2}└─⠋ /); // f
		// No whitespace between a branch and its status glyph.
		for (const line of lines.slice(1, 5)) {
			expect(line).not.toMatch(/─\s+⠋/);
		}
		expect(lines.at(-1)).toContain("2 agents done (1 succeeded, 1 failed)");
	});

	it("caps running rows at six and folds the rest into a summed overflow row", () => {
		const many = Array.from({ length: SUBAGENT_GRAPH_MAX_RUNNING + 2 }, (_unused, index) =>
			child(`w${index}`, "running", {
				parentId: "root",
				label: `worker-${index}`,
				tokensIn: 500,
				tokensOut: 50,
				durationMs: 60_000,
			}),
		);
		const lines = formatSubagentGraph(nodesFromChildSnapshots(many, "root"), 80).map(stripAnsi);

		// root + six capped children + overflow row
		expect(lines).toHaveLength(8);
		// The overflow row names the folded count and carries their summed spend.
		expect(lines.at(-1)?.trim()).toMatch(/^… 2 more running/);
		expect(lines.at(-1)?.trimEnd().endsWith("2m 00s · ↓ 1.0k ↑ 100")).toBe(true);
		expect(lines.join("\n")).not.toContain("worker-6");
	});

	it("prefers shallowest running rows when the cap forces folding", () => {
		const deep = Array.from({ length: SUBAGENT_GRAPH_MAX_RUNNING }, (_unused, index) => [
			child(`p${index}`, "running", { parentId: "root", label: `parent-${index}` }),
			child(`c${index}`, "running", { parentId: `p${index}`, label: `child-${index}` }),
		]).flat();
		const lines = formatSubagentGraph(nodesFromChildSnapshots(deep, "root"), 120).map(stripAnsi);

		// All six budget rows go to the depth-0 parents; their children fold.
		expect(lines).toHaveLength(1 + SUBAGENT_GRAPH_MAX_RUNNING + 1);
		for (const line of lines.slice(1, SUBAGENT_GRAPH_MAX_RUNNING + 1)) {
			expect(line.startsWith("├─⠋ ") || line.startsWith("└─⠋ ")).toBe(true);
		}
		expect(lines.at(-1)?.trim()).toBe("… 6 more running");
		expect(lines.join("\n")).not.toContain("child-");
	});

	it("never exceeds the eight-row contract", () => {
		const busy = [
			...Array.from({ length: 10 }, (_unused, index) =>
				child(`w${index}`, "running", { parentId: "root", label: `worker-${index}` }),
			),
			...Array.from({ length: 3 }, (_unused, index) =>
				child(`f${index}`, index === 0 ? "error" : "done", { parentId: "root", label: `finisher-${index}` }),
			),
		];
		const lines = formatSubagentGraph(nodesFromChildSnapshots(busy, "root"), 120).map(stripAnsi);

		expect(lines).toHaveLength(1 + SUBAGENT_GRAPH_MAX_ROWS);
		expect(lines.at(-2)?.trim()).toBe("… 4 more running");
		expect(lines.at(-1)).toContain("3 agents done (2 succeeded, 1 failed)");
	});

	it("sums finished spend across nested children, not just top-level rows", () => {
		const rows = nodesFromChildSnapshots(
			[
				child("p", "done", {
					parentId: "root",
					label: "parent",
					tokensIn: 800,
					tokensOut: 100,
					durationMs: 30_000,
				}),
				child("q", "error", {
					parentId: "p",
					label: "failed-nested",
					error: "boom",
					tokensIn: 250,
					tokensOut: 25,
					durationMs: 15_000,
				}),
			],
			"root",
		);
		const lines = formatSubagentGraph(rows, 120).map(stripAnsi);

		// Finished children never get individual rows, wherever they sit in the tree.
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("2 agents done (1 succeeded, 1 failed)");
		expect(lines[1]?.trimEnd().endsWith("45s · ↓ 1.1k ↑ 125")).toBe(true);
		expect(lines.join("\n")).not.toContain("failed-nested");
	});

	it("truncates lean names to the name budget and falls back to the label", () => {
		const rows = nodesFromChildSnapshots(
			[
				child("long", "running", {
					parentId: "root",
					label: "Explore the auth token refresh flow across all gateways",
					sessionName: "subagent-explore-the-auth-token-refresh-flow-a1b2c3d4",
				}),
				child("plain", "running", { parentId: "root", label: "bench-runner" }), // no session name: falls back to the de-slugged label
			],
			"root",
		);
		const lines = formatSubagentGraph(rows, 160).map(stripAnsi);
		// The de-slugged stem is capped to the 24-column name budget.
		expect(lines[1]).toContain("explore the auth token…");
		expect(lines.join("\n")).not.toContain("gateways");
		expect(lines.join("\n")).not.toContain("refresh");
		expect(lines[2]).toContain("bench-runner");

		// A collapsing viewport sheds cells before it sheds the name mid-glyph.
		const narrow = formatSubagentGraph(rows, 30).map(stripAnsi);
		expect(narrow[1]).toContain("…");
		expect(stripAnsi(narrow[1]).length).toBe(30);
	});

	it("never wraps: every line fills the viewport exactly", () => {
		const rows = nodesFromChildSnapshots(
			[
				...fanOut,
				child("d", "running", {
					parentId: "a",
					label: "grep-callers-across-the-whole-monorepo-and-beyond",
					activity: { kind: "executing", toolName: "Bash" },
				}),
			],
			"root",
		);
		for (const width of [8, 20, 40, 60, 80, 120]) {
			for (const line of formatSubagentGraph(rows, width)) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	it("truncates without leaking a partial escape", () => {
		const rows = nodesFromChildSnapshots(fanOut, "root");
		for (const width of [30, 45, 60]) {
			for (const line of formatSubagentGraph(rows, width)) {
				// A cut inside an escape sequence would leave a bare ESC in the visible text.
				expect(stripAnsi(line)).not.toContain("\u001b");
				expect(stripAnsi(line).length).toBe(width);
			}
		}
	});

	it("sheds cells rather than the name when the viewport collapses", () => {
		const rows = nodesFromChildSnapshots(fanOut, "root");
		const narrow = formatSubagentGraph(rows, 60).map(stripAnsi);
		expect(narrow[1]).toContain("explore auth flows");

		const tiny = formatSubagentGraph(rows, 24).map(stripAnsi);
		expect(tiny[1]).toContain("expl");
	});
});

describe("subagent graph click targets", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		setClickTargetsEnabled(false);
	});

	it("wraps attachable rows in an open-agent link when clicks are enabled", () => {
		const rows = nodesFromChildSnapshots(
			[
				fanOut[0], // has activeSessionId
				child("offline", "running", { parentId: "root", label: "no-runtime" }),
			],
			"root",
		);
		setClickTargetsEnabled(true);
		const lines = formatSubagentGraph(rows, 120);
		expect(lines[1]).toContain("pi-agent-open://a");
		// A child without a live runtime is not clickable.
		expect(lines[2]).not.toContain("pi-agent-open://");
		expect(parseOpenAgentTarget("pi-agent-open://a")).toBe("a");
		expect(parseOpenAgentTarget("pi-toggle://thinking")).toBeNull();
	});

	it("leaves plain text when clicks are disabled", () => {
		setClickTargetsEnabled(false);
		const lines = formatSubagentGraph(nodesFromChildSnapshots([fanOut[0]], "root"), 120);
		expect(lines[1]).not.toContain("pi-agent-open://");
		// Still equal to what the non-clickable renderer produces.
		expect(lines[1].replace(clickToOpenAgent("", ""), "")).toBe(lines[1]);
	});
});

describe("SubagentGraphPanel visibility", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows itself while a child is active and hides once the fan-out settles", () => {
		const panel = new SubagentGraphPanel();
		panel.setChildren(fanOut, "root");
		expect(panel.isVisible()).toBe(true);
		expect(panel.isAnimating()).toBe(true);

		panel.setChildren(
			fanOut.map((snapshot) => ({ ...snapshot, status: "done" as const, activity: undefined })),
			"root",
		);
		expect(panel.isVisible()).toBe(false);
		expect(panel.isAnimating()).toBe(false);
		expect(panel.render(80)).toEqual([]);
	});

	it("lets the toggle pin a settled fan-out and squelch a live one", () => {
		const panel = new SubagentGraphPanel();
		const settled = fanOut.map((snapshot) => ({ ...snapshot, status: "done" as const, activity: undefined }));
		panel.setChildren(settled, "root");
		expect(panel.toggle()).toBe(true);
		// Pinned settled fan-out: root row plus the aggregated done summary.
		expect(panel.render(80)).toHaveLength(2);

		panel.setChildren(fanOut, "root");
		expect(panel.toggle()).toBe(false);
		expect(panel.render(80)).toEqual([]);

		// A cleared fan-out resets the override so the next one starts from auto.
		panel.setChildren([], "root");
		panel.setChildren(fanOut, "root");
		expect(panel.isVisible()).toBe(true);
	});
});

describe("stopped children in the finished aggregate", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	// nodesFromChildSnapshots drops cancelled rows upstream (shared tree model),
	// so hand-build the position the panel would receive.
	function leafRow(child: AgentConnectionRlmChildAgentSnapshot): SubagentGraphRow {
		return {
			node: { id: child.id, child },
			depth: 0,
			descendants: 0,
			children: [],
			prefix: "\u2514\u2500",
		};
	}

	it("counts a force-stopped child separately, never as succeeded", () => {
		const lines = formatSubagentGraph(
			[
				leafRow(child("done-1", "done", { parentId: "root", label: "finisher" })),
				leafRow(child("killed-1", "cancelled", { parentId: "root", label: "killed" })),
			],
			120,
		).map(stripAnsi);

		expect(lines).toHaveLength(2); // root + done summary
		expect(lines[1]).toContain("2 agents done (1 succeeded, 0 failed, 1 stopped)");
		expect(lines[1]).not.toContain("(2 succeeded");
	});

	it("keeps the legacy summary shape when nothing was stopped", () => {
		const lines = formatSubagentGraph(
			[
				leafRow(child("done-1", "done", { parentId: "root", label: "finisher" })),
				leafRow(child("err-1", "error", { parentId: "root", label: "broken" })),
			],
			120,
		).map(stripAnsi);

		expect(lines[1]).toContain("2 agents done (1 succeeded, 1 failed)");
	});
});
