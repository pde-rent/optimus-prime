import { type Component, padEndAnsi } from "@earendil-works/pi-tui";
import { agentDisplayStatus, isChildAgentActive } from "../../agent-connection/agent-status.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { theme } from "../theme/theme.js";
import { getWorkingPulseFrame } from "../theme/working-icon.js";
import { formatCell, formatTwoSidedRow } from "./row-format.js";
import {
	formatSubagentName,
	formatSubagentTask,
	formatSubagentTokens,
	renderSubagentRow,
	type SubagentRowModel,
} from "./subagent-row.js";

/** Children rendered before the overflow indicator takes over. One line each. */
export const SUBAGENT_GRAPH_MAX_CHILDREN = 8;

const GAP = 2;
/** The panel is told the root's id, never its name; see setChildren. */
const ROOT_LABEL = "main";

export interface SubagentGraphRow {
	child: AgentConnectionRlmChildAgentSnapshot;
	/** Tree-drawing prefix, e.g. "│  └─ ". */
	prefix: string;
	/** Rows nested under this one, at any depth. */
	descendants: number;
	depth: number;
}

export interface SubagentGraphTotals {
	total: number;
	running: number;
	done: number;
	errored: number;
	tokens: number;
}

/** Bucket key for rows that hang directly off the current session. */
const TOP = Symbol("subagent-graph-top");
type BucketKey = string | typeof TOP;

/**
 * Flatten the `parentId` graph rooted at `rootId` into render order. Children
 * whose parent is unknown (an early live update, or an evicted ancestor) are
 * kept as top-level rows so live work is never silently dropped.
 */
export function buildSubagentGraphRows(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	rootId: string | undefined,
): SubagentGraphRow[] {
	const known = new Map<string, AgentConnectionRlmChildAgentSnapshot>();
	for (const child of children) {
		if (child.status !== "cancelled") known.set(child.id, child);
	}

	const parentKey = new Map<string, BucketKey>();
	for (const child of known.values()) {
		const parent = child.parentId;
		const nested = parent !== undefined && parent !== rootId && known.has(parent);
		parentKey.set(child.id, nested ? parent : TOP);
	}
	// A parentId cycle has no root, so re-root the node that closes it.
	for (const child of known.values()) {
		const guard = new Set<string>();
		let cursor: BucketKey = child.id;
		while (typeof cursor === "string") {
			if (guard.has(cursor)) {
				parentKey.set(child.id, TOP);
				break;
			}
			guard.add(cursor);
			cursor = parentKey.get(cursor) ?? TOP;
		}
	}

	const byParent = new Map<BucketKey, AgentConnectionRlmChildAgentSnapshot[]>();
	for (const child of known.values()) {
		const key = parentKey.get(child.id) ?? TOP;
		const bucket = byParent.get(key);
		if (bucket) bucket.push(child);
		else byParent.set(key, [child]);
	}

	const rows: SubagentGraphRow[] = [];
	const walk = (key: BucketKey, ancestors: string, depth: number): void => {
		const bucket = byParent.get(key) ?? [];
		for (const [index, child] of bucket.entries()) {
			const isLast = index === bucket.length - 1;
			rows.push({ child, prefix: `${ancestors}${isLast ? "└─ " : "├─ "}`, descendants: 0, depth });
			walk(child.id, `${ancestors}${isLast ? "   " : "│  "}`, depth + 1);
		}
	};
	walk(TOP, "", 0);
	// Depth-first order puts a node's whole subtree in the rows right behind it.
	for (const [index, row] of rows.entries()) {
		let count = 0;
		let next = rows[index + 1];
		while (next !== undefined && next.depth > row.depth) {
			count += 1;
			next = rows[index + 1 + count];
		}
		row.descendants = count;
	}
	return rows;
}

export function summarizeSubagentGraph(rows: readonly SubagentGraphRow[]): SubagentGraphTotals {
	const totals: SubagentGraphTotals = { total: 0, running: 0, done: 0, errored: 0, tokens: 0 };
	for (const { child } of rows) {
		totals.total += 1;
		totals.tokens += child.tokenCount ?? 0;
		if (child.status === "error") totals.errored += 1;
		else if (isChildAgentActive(child)) totals.running += 1;
		else if (child.status === "done") totals.done += 1;
	}
	return totals;
}

function firstLine(text: string | undefined): string {
	return text?.split("\n", 1)[0]?.trim() ?? "";
}

/** Task summary for a child row: recap, the error, or the prompt that spawned it. */
function taskCell(child: AgentConnectionRlmChildAgentSnapshot): string {
	if (child.status === "error") return firstLine(child.error) || "Failed";
	return firstLine(child.recap) || formatSubagentTask(child.label);
}

function subagentRowModel(row: SubagentGraphRow): SubagentRowModel {
	const { child } = row;
	return {
		// No session name: fall back to a short prompt excerpt, never the error text.
		name: formatSubagentName(child.sessionName) || formatSubagentTask(child.label, 32),
		task: taskCell(child),
		status: agentDisplayStatus(child),
		spinnerFrame: getWorkingPulseFrame(),
		tokensIn: child.tokensIn,
		tokensOut: child.tokensOut,
		tokenCount: child.tokenCount,
		durationMs: child.durationMs,
		...(child.activeSessionId !== undefined ? { openTargetId: child.id } : {}),
	};
}

/** Depth-first order puts a row's subtree right behind it, so the cap cuts a tail. */
function elidedDescendants(row: SubagentGraphRow, index: number, visibleCount: number): number {
	return Math.max(0, Math.min(row.descendants, index + row.descendants + 1 - visibleCount));
}

/**
 * One line per child: tree prefix + status icon + name + truncated task summary,
 * with runtime and token spend right-aligned. Rows with a live runtime are
 * click targets that open the session.
 */
function childLine(row: SubagentGraphRow, hidden: number, width: number): string {
	return renderSubagentRow(
		{
			...subagentRowModel(row),
			prefix: theme.fg("dim", row.prefix),
			...(hidden > 0 ? { badge: ` (+${hidden})` } : {}),
		},
		width,
	);
}

export function formatSubagentGraph(
	rows: readonly SubagentGraphRow[],
	width: number,
	rootLabel: string = ROOT_LABEL,
): string[] {
	if (rows.length === 0 || width < 8) return [];
	const visible = rows.slice(0, SUBAGENT_GRAPH_MAX_CHILDREN);
	const totals = summarizeSubagentGraph(rows);

	const errors = totals.errored > 0 ? ` · ${totals.errored} error` : "";
	const summary = `${totals.running}/${totals.total} running${errors}`;
	const rootTokens = formatSubagentTokens(undefined, undefined, totals.tokens || undefined);
	const rootLine = `${theme.fg("accent", "●")} ${theme.bold(rootLabel)}`;
	const rootDetail = [summary, rootTokens].filter((part) => part !== undefined && part !== "").join(" · ");
	const lines: string[] = [formatTwoSidedRow(rootLine, theme.fg("dim", rootDetail), width, { gap: GAP })];

	for (const [index, row] of visible.entries()) {
		const hidden = elidedDescendants(row, index, visible.length);
		lines.push(childLine(row, hidden, width));
	}

	const hiddenCount = rows.length - visible.length;
	if (hiddenCount > 0) {
		lines.push(formatCell(theme.fg("muted", `  … ${hiddenCount} more`), width));
	}
	return lines.map((line) => padEndAnsi(line, width));
}

/**
 * Live roster of the RLM fan-out below the current session. Auto-shows while any
 * child is active and auto-hides once the fan-out settles, so an idle session
 * pays nothing; `toggle()` pins or squelches it explicitly.
 */
export class SubagentGraphPanel implements Component {
	private rows: SubagentGraphRow[] = [];
	private anyActive = false;
	private override: boolean | undefined;

	setChildren(children: Iterable<AgentConnectionRlmChildAgentSnapshot>, rootId: string | undefined): void {
		this.rows = buildSubagentGraphRows(children, rootId);
		this.anyActive = this.rows.some((row) => isChildAgentActive(row.child));
		// A cleared fan-out ends the override so the next one starts from auto.
		if (this.rows.length === 0) this.override = undefined;
	}

	getRows(): readonly SubagentGraphRow[] {
		return this.rows;
	}

	isVisible(): boolean {
		if (this.rows.length === 0) return false;
		return this.override ?? this.anyActive;
	}

	/** True while a visible row is running and the spinner needs ticks. */
	isAnimating(): boolean {
		return this.isVisible() && this.rows.some((row) => agentDisplayStatus(row.child) === "running");
	}

	/** Flip the current visibility; returns the new state. */
	toggle(): boolean {
		if (this.rows.length === 0) return false;
		this.override = !this.isVisible();
		return this.override;
	}

	render(width: number): string[] {
		if (!this.isVisible()) return [];
		return formatSubagentGraph(this.rows, width);
	}

	invalidate(): void {
		// Render output is derived entirely from the snapshots and the theme.
	}
}
