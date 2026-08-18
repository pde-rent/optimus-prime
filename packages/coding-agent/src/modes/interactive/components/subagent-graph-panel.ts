import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";

/** Rows rendered before the overflow indicator takes over. */
export const SUBAGENT_GRAPH_MAX_ROWS = 8;

const GAP = 2;
/** Prefix + status icon + a readable stub of the label. */
const MIN_LABEL_CELL = 16;
const MAX_MODEL_WIDTH = 18;

export interface SubagentGraphRow {
	child: AgentConnectionRlmChildAgentSnapshot;
	/** Tree-drawing prefix, e.g. "│  └─ ". */
	prefix: string;
	depth: number;
}

export interface SubagentGraphTotals {
	total: number;
	running: number;
	done: number;
	errored: number;
	tokens: number;
}

/**
 * `effort` is populated by the RLM spawn handle and is not part of the daemon
 * snapshot on every build, so it stays an optional read.
 */
function childEffort(child: AgentConnectionRlmChildAgentSnapshot): string | undefined {
	const effort = child.effort?.trim();
	return effort ? effort : undefined;
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
			rows.push({ child, prefix: `${ancestors}${isLast ? "└─ " : "├─ "}`, depth });
			walk(child.id, `${ancestors}${isLast ? "   " : "│  "}`, depth + 1);
		}
	};
	walk(TOP, "", 0);
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

function statusIcon(child: AgentConnectionRlmChildAgentSnapshot): string {
	switch (child.status) {
		case "queued":
			return theme.fg("dim", "◇");
		case "running":
			return theme.fg("accent", "◆");
		case "done":
			return child.activity ? theme.fg("accent", "◆") : theme.fg("success", "✓");
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

/** Drop the provider prefix: the family is what identifies the run at a glance. */
function modelCell(model: string | undefined): string {
	if (!model) return "-";
	const parts = model.split("/");
	return parts[parts.length - 1] || model;
}

function elapsedCell(durationMs: number | undefined): string {
	if (durationMs === undefined) return "-";
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

interface GraphColumn {
	header: string;
	cells: string[];
	width: number;
	/** Higher drops first when the viewport cannot fit every column. */
	dropOrder: number;
	color: "dim" | "muted" | "text";
}

function buildColumns(rows: readonly SubagentGraphRow[]): GraphColumn[] {
	const columns: GraphColumn[] = [];
	const add = (header: string, cells: string[], dropOrder: number, color: GraphColumn["color"]): void => {
		columns.push({
			header,
			cells,
			width: Math.max(header.length, ...cells.map((cell) => visibleWidth(cell))),
			dropOrder,
			color,
		});
	};
	add(
		"model",
		rows.map((row) => truncateToWidth(modelCell(row.child.model), MAX_MODEL_WIDTH, "…")),
		4,
		"dim",
	);
	if (rows.some((row) => childEffort(row.child) !== undefined)) {
		add(
			"effort",
			rows.map((row) => childEffort(row.child) ?? "-"),
			2,
			"muted",
		);
	}
	add(
		"tokens",
		rows.map((row) => formatTokenCount(row.child.tokenCount ?? 0)),
		0,
		"text",
	);
	add(
		"tools",
		rows.map((row) => String(row.child.toolUseCount ?? 0)),
		3,
		"dim",
	);
	add(
		"time",
		rows.map((row) => elapsedCell(row.child.durationMs)),
		1,
		"dim",
	);
	return columns;
}

function padEndAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartAnsi(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function fitColumns(columns: GraphColumn[], width: number): GraphColumn[] {
	const kept = [...columns];
	const rightWidth = (): number => kept.reduce((sum, column) => sum + column.width + GAP, 0);
	while (kept.length > 0 && width - rightWidth() < MIN_LABEL_CELL) {
		let dropIndex = 0;
		for (let index = 1; index < kept.length; index++) {
			const candidate = kept[index];
			const current = kept[dropIndex];
			if (candidate && current && candidate.dropOrder > current.dropOrder) dropIndex = index;
		}
		kept.splice(dropIndex, 1);
	}
	return kept;
}

export function formatSubagentGraph(rows: readonly SubagentGraphRow[], width: number): string[] {
	if (rows.length === 0 || width < 8) return [];
	const visible = rows.slice(0, SUBAGENT_GRAPH_MAX_ROWS);
	const hidden = rows.length - visible.length;
	const totals = summarizeSubagentGraph(rows);
	const columns = fitColumns(buildColumns(visible), width);
	const labelWidth = Math.max(1, width - columns.reduce((sum, column) => sum + column.width + GAP, 0));

	const lines: string[] = [];
	const summary = ` ${totals.total} · ${totals.running} running · ${totals.done} done · ${totals.errored} error · ${formatTokenCount(totals.tokens)} tokens`;
	const head = truncateToWidth("Subagents", width, "…");
	const tail = truncateToWidth(summary, Math.max(0, width - visibleWidth(head)), "…");
	lines.push(padEndAnsi(theme.fg("muted", head) + theme.fg("dim", tail), width));

	let header = padEndAnsi("agent", labelWidth);
	for (const column of columns) {
		header += " ".repeat(GAP) + padStartAnsi(column.header, column.width);
	}
	lines.push(theme.fg("dim", header));

	for (const [index, row] of visible.entries()) {
		const labelSpace = Math.max(1, labelWidth - row.prefix.length - 2);
		const label = truncateToWidth(row.child.label, labelSpace, "…");
		let line = padEndAnsi(`${theme.fg("dim", row.prefix)}${statusIcon(row.child)} ${label}`, labelWidth);
		for (const column of columns) {
			line += " ".repeat(GAP) + padStartAnsi(theme.fg(column.color, column.cells[index] ?? ""), column.width);
		}
		lines.push(line);
	}

	if (hidden > 0) {
		lines.push(padEndAnsi(theme.fg("muted", truncateToWidth(`   … ${hidden} more`, width, "…")), width));
	}
	return lines;
}

/**
 * Live tree of the RLM fan-out below the current session. Auto-shows while any
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
