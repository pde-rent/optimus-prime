import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import {
	buildSubagentGraphRows,
	formatSubagentGraph,
	SUBAGENT_GRAPH_MAX_CHILDREN,
	SubagentGraphPanel,
	summarizeSubagentGraph,
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
		label: "explore-auth-flows",
		model: "anthropic/claude-opus-4-1",
		effort: "high",
		tokenCount: 12400,
		tokensIn: 12000,
		tokensOut: 400,
		toolUseCount: 8,
		durationMs: 62_000,
		activity: { kind: "executing", toolName: "Read" },
	}),
	child("b", "done", {
		parentId: "root",
		label: "write-regression-tests",
		model: "anthropic/claude-sonnet-4-5",
		effort: "medium",
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

const twoLineCount = (children: number) => 1 + children * 2;

describe("subagent graph tree assembly", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("builds a two-level tree from a flat snapshot list", () => {
		const rows = buildSubagentGraphRows(
			[...fanOut, child("d", "running", { parentId: "a", label: "grep-callers" })],
			"root",
		);

		expect(rows.map((row) => [row.child.id, row.depth, row.prefix, row.descendants])).toEqual([
			["a", 0, "├─ ", 1],
			["d", 1, "│  └─ ", 0],
			["b", 0, "├─ ", 0],
			["c", 0, "└─ ", 0],
		]);
	});

	it("counts descendants at every depth, not just direct children", () => {
		const rows = buildSubagentGraphRows(
			[
				child("a", "running", { parentId: "root" }),
				child("b", "running", { parentId: "a" }),
				child("c", "running", { parentId: "b" }),
				child("d", "running", { parentId: "a" }),
			],
			"root",
		);

		expect(rows.map((row) => [row.child.id, row.depth, row.descendants])).toEqual([
			["a", 0, 3],
			["b", 1, 1],
			["c", 2, 0],
			["d", 1, 0],
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

	it("leads with the session's own row and marks each child with its status", () => {
		const lines = formatSubagentGraph(buildSubagentGraphRows(fanOut, "root"), 120).map(stripAnsi);

		expect(lines).toHaveLength(twoLineCount(3));
		expect(lines[0]).toMatch(/^● main /);
		expect(lines[0]).toContain("1/3 running · 1 error");
		expect(lines[0]).toContain("↓ 24k");
		// Status glyph and label come from the shared status vocabulary.
		expect(lines[1]).toMatch(/^├─ ● explore-auth-flows /);
		expect(lines[1]).toContain("Running");
		expect(lines[3]).toMatch(/^├─ ✓ write-regression-tests /);
		expect(lines[3]).toContain("Done");
		// Colour alone is too weak for a failure, so the error keeps its own glyph.
		expect(lines[5]).toMatch(/^└─ ✗ bench-runner /);
		expect(lines[5]).toContain("Failed");
	});

	it("shows model, effort, activity, and spend on the two lines", () => {
		const lines = formatSubagentGraph(buildSubagentGraphRows(fanOut, "root"), 120).map(stripAnsi);

		expect(lines[1]).toContain("claude-opus-4-1 · high");
		expect(lines[2]).toContain("Executing Read");
		expect(lines[3]).toContain("claude-sonnet-4-5 · medium");
		expect(lines[5]).toContain("gpt-5-codex");
		// Tokens in and out, not just a single figure.
		expect(lines[2]).toContain("↓ 12k ↑ 400");
		expect(lines[4]).toContain("↓ 8.8k ↑ 300");
		// A child without a split falls back to the single token figure.
		expect(lines[6]).toContain("↓ 2.0k");
	});

	it("shows live activity, recap, and error text on the work line", () => {
		const lines = formatSubagentGraph(
			buildSubagentGraphRows(
				[
					fanOut[0] as AgentConnectionRlmChildAgentSnapshot,
					{ ...(fanOut[1] as AgentConnectionRlmChildAgentSnapshot), recap: "Added retry coverage" },
					fanOut[2] as AgentConnectionRlmChildAgentSnapshot,
					child("d", "queued", { parentId: "root", label: "waiting-worker" }),
				],
				"root",
			),
			120,
		).map(stripAnsi);

		expect(lines[2]).toContain("Executing Read");
		expect(lines[4]).toContain("Added retry coverage");
		expect(lines[6]).toContain("boom");
		expect(lines[7]).toContain("Queued");
	});

	it("draws nesting with tree prefixes and leaves visible descendants uncounted", () => {
		const lines = formatSubagentGraph(
			buildSubagentGraphRows(
				[
					...fanOut,
					child("d", "running", { parentId: "a", label: "grep-callers" }),
					child("e", "running", { parentId: "d", label: "read-callers" }),
				],
				"root",
			),
			120,
		).map(stripAnsi);

		expect(lines[1]).toMatch(/^├─ ● explore-auth-flows /);
		expect(lines[3]).toMatch(/^│ {2}└─ ● grep-callers /);
		// Every descendant is on screen, so nothing is summarized as `(+N)`.
		expect(lines.join("\n")).not.toContain("(+");
	});

	it("counts only the descendants the row cap elided", () => {
		const rows = buildSubagentGraphRows(
			[
				child("a", "running", { parentId: "root", label: "fan-out" }),
				...Array.from({ length: SUBAGENT_GRAPH_MAX_CHILDREN }, (_unused, index) =>
					child(`w${index}`, "running", { parentId: "a", label: `worker-${index}` }),
				),
			],
			"root",
		);
		const lines = formatSubagentGraph(rows, 120).map(stripAnsi);

		// Visible rows: a + w0..w2. The cap elides 6 of a's 9 descendants... a's own
		// subtree count is capped at what is not on screen.
		expect(lines[1]).toContain("fan-out (+");
		expect(lines.at(-1)?.trim()).toMatch(/^… \d+ more$/);
	});

	it("right-aligns the elapsed and token cell on the work line", () => {
		const lines = formatSubagentGraph(buildSubagentGraphRows(fanOut, "root"), 120).map(stripAnsi);

		expect(lines[2]?.trimEnd().endsWith("1m 02s · ↓ 12k ↑ 400")).toBe(true);
		expect(lines[4]?.trimEnd().endsWith("47s · ↓ 8.8k ↑ 300")).toBe(true);
		expect(lines[6]?.trimEnd().endsWith("12s · ↓ 2.0k")).toBe(true);
	});

	it("caps a wide fan-out and reports the overflow", () => {
		const many = Array.from({ length: SUBAGENT_GRAPH_MAX_CHILDREN + 4 }, (_unused, index) =>
			child(`w${index}`, "running", { parentId: "root", tokenCount: 1000 }),
		);
		const lines = formatSubagentGraph(buildSubagentGraphRows(many, "root"), 80).map(stripAnsi);

		// root + capped children (two lines each) + overflow
		expect(lines).toHaveLength(twoLineCount(SUBAGENT_GRAPH_MAX_CHILDREN) + 1);
		expect(lines[0]).toContain(`/${many.length} running`);
		expect(lines.at(-1)?.trim()).toBe("… 4 more");
		expect(lines.join("\n")).not.toContain("w8");
	});

	it("never wraps: every line fills the viewport exactly", () => {
		const rows = buildSubagentGraphRows(
			[
				...fanOut,
				child("d", "running", {
					parentId: "a",
					label: "grep-callers-across-the-whole-monorepo",
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

	it("truncates the activity cell without leaking a partial escape", () => {
		const rows = buildSubagentGraphRows(fanOut, "root");
		for (const width of [30, 45, 60]) {
			for (const line of formatSubagentGraph(rows, width)) {
				// A cut inside an escape sequence would leave a bare ESC in the visible text.
				expect(stripAnsi(line)).not.toContain("\u001b");
				expect(stripAnsi(line).length).toBe(width);
			}
		}
		expect(formatSubagentGraph(rows, 45).map(stripAnsi)[1]).toContain("…");
	});

	it("sheds cells rather than the name when the viewport collapses", () => {
		const rows = buildSubagentGraphRows(fanOut, "root");
		const narrow = formatSubagentGraph(rows, 60).map(stripAnsi);
		expect(narrow[1]).toContain("explore");

		const tiny = formatSubagentGraph(rows, 20).map(stripAnsi);
		expect(tiny[1]).toContain("expl");

		expect(formatSubagentGraph(rows, 7)).toEqual([]);
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
		expect(panel.render(80)).toHaveLength(twoLineCount(3));

		panel.setChildren(fanOut, "root");
		expect(panel.toggle()).toBe(false);
		expect(panel.render(80)).toEqual([]);

		// A cleared fan-out resets the override so the next one starts from auto.
		panel.setChildren([], "root");
		panel.setChildren(fanOut, "root");
		expect(panel.isVisible()).toBe(true);
	});
});
