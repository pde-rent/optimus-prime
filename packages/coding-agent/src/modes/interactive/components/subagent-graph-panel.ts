import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { AGENT_ACTIVITY_LABELS, formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";

/** Rows rendered before the overflow indicator takes over. */
export const SUBAGENT_GRAPH_MAX_ROWS = 8;

const GAP = 2;
const MIN_NAME_CELL = 14;
const MAX_NAME_CELL = 34;
/** Activity is the primary cell, so it claims width from the name before it shrinks. */
const MIN_ACTIVITY_CELL = 16;
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

function isActive(child: AgentConnectionRlmChildAgentSnapshot): boolean {
	return child.status === "running" || child.status === "queued" || child.activity !== undefined;
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
		else if (isActive(child)) totals.running += 1;
		else if (child.status === "done") totals.done += 1;
	}
	return totals;
}

/**
 * Status rides on colour so the roster keeps one glyph shape per role, except
 * for errors: a failure must still read as a failure on a monochrome or
 * low-contrast terminal.
 */
function markerGlyph(child: AgentConnectionRlmChildAgentSnapshot): string {
	switch (child.status) {
		case "queued":
			return theme.fg("dim", "○");
		case "running":
			return theme.fg("accent", "○");
		case "done":
			return child.activity ? theme.fg("accent", "○") : theme.fg("success", "○");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("dim", "✗");
		default: {
			const _exhaustive: never = child.status;
			return _exhaustive;
		}
	}
}

function firstLine(text: string | undefined): string {
	return text?.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * `hidden` is the part of this row's subtree the row cap elided; visible
 * descendants already speak for themselves as their own tree rows.
 */
function nameCell(row: SubagentGraphRow, hidden: number): string {
	const elided = hidden > 0 ? theme.fg("dim", ` (+${hidden})`) : "";
	return `${theme.fg("dim", row.prefix)}${markerGlyph(row.child)} ${row.child.label}${elided}`;
}

function activityCell(child: AgentConnectionRlmChildAgentSnapshot): string {
	const activity = child.activity;
	if (activity) {
		const label = AGENT_ACTIVITY_LABELS[activity.kind];
		return activity.toolName ? `${label} ${activity.toolName}` : label;
	}
	if (child.status === "error") return firstLine(child.error) || "Failed";
	if (child.status === "queued") return "Queued";
	return firstLine(child.recap) || firstLine(child.answerPreview);
}

function elapsedCell(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function metricsCell(child: AgentConnectionRlmChildAgentSnapshot): string {
	const tokens = child.tokenCount ? `↓ ${formatTokenCount(child.tokenCount)} tokens` : undefined;
	return [elapsedCell(child.durationMs), tokens].filter((part) => part !== undefined).join(" · ");
}

// ponytail: local width-aware padding, adopt the canonical pair in packages/tui/src/utils.ts once it lands.
function padEndAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartAnsi(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function cellWidth(cells: readonly string[]): number {
	return Math.max(0, ...cells.map((cell) => visibleWidth(cell)));
}

/** Depth-first order puts a row's subtree right behind it, so the cap cuts a tail. */
function elidedDescendants(row: SubagentGraphRow, index: number, visibleCount: number): number {
	return Math.max(0, Math.min(row.descendants, index + row.descendants + 1 - visibleCount));
}

export function formatSubagentGraph(
	rows: readonly SubagentGraphRow[],
	width: number,
	rootLabel: string = ROOT_LABEL,
): string[] {
	if (rows.length === 0 || width < 8) return [];
	const visible = rows.slice(0, SUBAGENT_GRAPH_MAX_ROWS);
	const hidden = rows.length - visible.length;
	const totals = summarizeSubagentGraph(rows);

	// The root row carries the fan-out aggregates, which is why the roster needs
	// no separate summary header.
	const errors = totals.errored > 0 ? ` · ${totals.errored} error` : "";
	const names = [
		`${theme.fg("accent", "●")} ${theme.bold(rootLabel)}`,
		...visible.map((row, index) => nameCell(row, elidedDescendants(row, index, visible.length))),
	];
	const activities = [
		`${totals.running}/${totals.total} running${errors}`,
		...visible.map((row) => activityCell(row.child)),
	];
	const metrics = [
		totals.tokens > 0 ? `↓ ${formatTokenCount(totals.tokens)} tokens` : "",
		...visible.map((row) => metricsCell(row.child)),
	];

	let nameWidth = Math.min(MAX_NAME_CELL, cellWidth(names));
	let metricsWidth = cellWidth(metrics);
	let activityWidth = width - nameWidth - metricsWidth - GAP * 2;
	if (activityWidth < MIN_ACTIVITY_CELL) {
		nameWidth = Math.max(MIN_NAME_CELL, nameWidth + activityWidth - MIN_ACTIVITY_CELL);
		activityWidth = width - nameWidth - metricsWidth - GAP * 2;
	}
	if (activityWidth < MIN_ACTIVITY_CELL) {
		metricsWidth = 0;
		activityWidth = width - nameWidth - GAP;
	}
	if (activityWidth < MIN_ACTIVITY_CELL) {
		activityWidth = 0;
		nameWidth = width;
	}

	const lines: string[] = [];
	for (const [index, name] of names.entries()) {
		const cells = [padEndAnsi(truncateToWidth(name, nameWidth, "…"), nameWidth)];
		if (activityWidth > 0) {
			const activity = truncateToWidth(activities[index] ?? "", activityWidth, "…");
			cells.push(padEndAnsi(theme.fg(index === 0 ? "dim" : "muted", activity), activityWidth));
		}
		if (metricsWidth > 0) {
			const cell = truncateToWidth(metrics[index] ?? "", metricsWidth, "…");
			cells.push(padStartAnsi(theme.fg("dim", cell), metricsWidth));
		}
		lines.push(padEndAnsi(cells.join(" ".repeat(GAP)), width));
	}

	if (hidden > 0) {
		lines.push(padEndAnsi(theme.fg("muted", truncateToWidth(`  … ${hidden} more`, width, "…")), width));
	}
	return lines;
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
		this.anyActive = this.rows.some((row) => isActive(row.child));
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
