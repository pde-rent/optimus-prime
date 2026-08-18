import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import {
	buildSubagentGraphRows,
	formatSubagentGraph,
	SUBAGENT_GRAPH_MAX_ROWS,
	SubagentGraphPanel,
	summarizeSubagentGraph,
} from "../src/modes/interactive/components/subagent-graph-panel.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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
		label: "explore-auth-flows",
		model: "anthropic/claude-opus-4-1",
		effort: "high",
		tokenCount: 12400,
		toolUseCount: 8,
		durationMs: 62_000,
	}),
	child("b", "done", {
		parentId: "root",
		label: "write-regression-tests",
		model: "anthropic/claude-sonnet-4-5",
		effort: "medium",
		tokenCount: 9100,
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

describe("subagent graph tree assembly", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("builds a two-level tree from a flat snapshot list", () => {
		const rows = buildSubagentGraphRows(
			[...fanOut, child("d", "running", { parentId: "a", label: "grep-callers" })],
			"root",
		);

		expect(rows.map((row) => [row.child.id, row.depth, row.prefix])).toEqual([
			["a", 0, "├─ "],
			["d", 1, "│  └─ "],
			["b", 0, "├─ "],
			["c", 0, "└─ "],
		]);
	});

	it("keeps children whose parent is unknown as top-level rows", () => {
		const rows = buildSubagentGraphRows(
			[child("orphan", "running", { parentId: "evicted" }), child("direct", "running", { parentId: "root" })],
			"root",
		);

		expect(rows.map((row) => row.child.id).sort()).toEqual(["direct", "orphan"]);
		expect(rows.every((row) => row.depth === 0)).toBe(true);
	});

	it("drops cancelled children and survives a parent cycle", () => {
		const rows = buildSubagentGraphRows(
			[
				child("gone", "cancelled", { parentId: "root" }),
				child("x", "running", { parentId: "y" }),
				child("y", "running", { parentId: "x" }),
			],
			"root",
		);

		expect(rows.map((row) => row.child.id)).toEqual(["x", "y"]);
	});

	it("sums aggregates across the whole tree", () => {
		const rows = buildSubagentGraphRows(
			[
				...fanOut,
				child("d", "queued", { parentId: "a", tokenCount: 500 }),
				// A terminal child with live activity is a follow-up turn, so it counts as running.
				child("e", "done", { parentId: "root", tokenCount: 100, activity: { kind: "writing" } }),
			],
			"root",
		);

		expect(summarizeSubagentGraph(rows)).toEqual({
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

	it("renders a root fan-out with running, done, and errored children", () => {
		const lines = formatSubagentGraph(buildSubagentGraphRows(fanOut, "root"), 80).map(stripAnsi);

		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("Subagents 3 · 1 running · 1 done · 1 error · 24k tokens");
		expect(lines[1]).toContain("agent");
		expect(lines[1]).toContain("model");
		expect(lines[1]).toContain("tokens");
		expect(lines[2]).toContain("├─ ◆ explore-auth-flows");
		expect(lines[2]).toContain("claude-opus-4-1");
		expect(lines[2]).toContain("12k");
		expect(lines[2]).toContain("1m02s");
		expect(lines[3]).toContain("├─ ✓ write-regression-tests");
		expect(lines[4]).toContain("└─ ✗ bench-runner");
	});

	it("renders the effort column only when a child reports one", () => {
		const withEffort = formatSubagentGraph(buildSubagentGraphRows(fanOut, "root"), 80).map(stripAnsi);
		expect(withEffort[1]).toContain("effort");
		expect(withEffort[2]).toContain("high");
		expect(withEffort[3]).toContain("medium");
		// The errored child has no effort, so its cell degrades to a placeholder.
		expect(withEffort[4]).toMatch(/\s-\s/);

		const withoutEffort = formatSubagentGraph(
			buildSubagentGraphRows(
				fanOut.map(({ effort: _effort, ...rest }) => rest),
				"root",
			),
			80,
		).map(stripAnsi);
		expect(withoutEffort[1]).not.toContain("effort");
		expect(withoutEffort[2]).not.toContain("high");
	});

	it("caps a wide fan-out and reports the overflow", () => {
		const many = Array.from({ length: SUBAGENT_GRAPH_MAX_ROWS + 4 }, (_unused, index) =>
			child(`w${index}`, "running", { parentId: "root", tokenCount: 1000 }),
		);
		const lines = formatSubagentGraph(buildSubagentGraphRows(many, "root"), 80).map(stripAnsi);

		// summary + header + capped rows + overflow
		expect(lines).toHaveLength(SUBAGENT_GRAPH_MAX_ROWS + 3);
		expect(lines[0]).toContain(`Subagents ${many.length} ·`);
		expect(lines.at(-1)?.trim()).toBe("… 4 more");
		expect(lines.join("\n")).not.toContain("w8");
	});

	it("never wraps: every line fills the viewport exactly", () => {
		const rows = buildSubagentGraphRows(
			[
				...fanOut,
				child("d", "running", { parentId: "a", label: "grep-callers", model: "anthropic/claude-haiku-4-5" }),
			],
			"root",
		);
		for (const width of [60, 80, 120]) {
			for (const line of formatSubagentGraph(rows, width)) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	it("drops low-priority columns before squeezing the label", () => {
		const rows = buildSubagentGraphRows(fanOut, "root");
		const narrow = formatSubagentGraph(rows, 60).map(stripAnsi);

		expect(narrow[1]).not.toContain("model");
		expect(narrow[1]).toContain("tokens");
		expect(narrow[2]).toContain("explore-auth-flows");
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

		panel.setChildren(
			fanOut.map((snapshot) => ({ ...snapshot, status: "done" as const, activity: undefined })),
			"root",
		);
		expect(panel.isVisible()).toBe(false);
		expect(panel.render(80)).toEqual([]);
	});

	it("lets the toggle pin a settled fan-out and squelch a live one", () => {
		const panel = new SubagentGraphPanel();
		const settled = fanOut.map((snapshot) => ({ ...snapshot, status: "done" as const, activity: undefined }));
		panel.setChildren(settled, "root");
		expect(panel.toggle()).toBe(true);
		expect(panel.render(80)).toHaveLength(5);

		panel.setChildren(fanOut, "root");
		expect(panel.toggle()).toBe(false);
		expect(panel.render(80)).toEqual([]);

		// A cleared fan-out resets the override so the next one starts from auto.
		panel.setChildren([], "root");
		panel.setChildren(fanOut, "root");
		expect(panel.isVisible()).toBe(true);
	});
});
