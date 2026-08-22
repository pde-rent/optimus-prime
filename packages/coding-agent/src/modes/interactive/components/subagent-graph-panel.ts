import { type Component, padEndAnsi } from "@earendil-works/pi-tui";
import { agentDisplayStatus, isChildAgentActive } from "../../agent-connection/agent-status.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import {
	type AgentTreePosition,
	type ChildSnapshotNode,
	nodesFromChildSnapshots,
	summarizeChildSnapshots,
} from "../../agents-tree/agent-tree-model.js";
import { theme } from "../theme/theme.js";
import { getWorkingPulseFrame } from "../theme/working-icon.js";
import { formatTwoSidedRow } from "./row-format.js";
import {
	formatSubagentName,
	formatSubagentRuntime,
	formatSubagentTask,
	formatSubagentTokens,
	renderSubagentRow,
	type SubagentRowModel,
} from "./subagent-row.js";

/** Running children rendered as individual rows before the overflow row folds the rest. */
export const SUBAGENT_GRAPH_MAX_RUNNING = 6;
/** Hard ceiling on rows below the root: six running rows + overflow + done summary. */
export const SUBAGENT_GRAPH_MAX_ROWS = 8;
/** Column budget for a row's lean agent name; task text never renders. */
export const SUBAGENT_GRAPH_NAME_WIDTH = 24;

const GAP = 2;
/** The panel is told the root's id, never its name; see setChildren. */
const ROOT_LABEL = "main";

/** One assembled tree row; prefixes and depths come from the shared assembler. */
export type SubagentGraphRow = AgentTreePosition<ChildSnapshotNode>;

/** Tree assembly lives in the shared agents-tree model; the panel only renders it. */
export function buildSubagentGraphRows(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	rootId: string | undefined,
): SubagentGraphRow[] {
	return nodesFromChildSnapshots(children, rootId);
}

function isRunningRow(row: SubagentGraphRow): boolean {
	return agentDisplayStatus(row.node.child) === "running";
}

/** A run reached a terminal state; idle (finished but still attached) counts as succeeded. */
function isFinishedRow(row: SubagentGraphRow): boolean {
	const status = agentDisplayStatus(row.node.child);
	return status === "completed" || status === "idle" || status === "error";
}

/**
 * Pick which running rows render individually: shallowest-first wins, and a row
 * whose own ancestor lost the cut folds too, so visible nesting always anchors
 * on a visible parent. Everything else lands in the overflow row's count.
 */
function selectRunningRows(rows: readonly SubagentGraphRow[]): {
	visible: SubagentGraphRow[];
	hidden: SubagentGraphRow[];
} {
	const byId = new Map(rows.map((row) => [row.node.child.id, row] as const));
	const chosen = new Set<string>();
	const anchored = (row: SubagentGraphRow): boolean => {
		let cursor = row.node.child.parentId;
		while (cursor !== undefined && byId.has(cursor)) {
			// A known ancestor that missed the cut folds its whole subtree.
			if (!chosen.has(cursor)) return false;
			cursor = byId.get(cursor)?.node.child.parentId;
		}
		// Unknown or root-level parents hang straight off the session.
		return true;
	};

	const visible: SubagentGraphRow[] = [];
	const hidden: SubagentGraphRow[] = [];
	const candidates = rows.filter(isRunningRow).sort((a, b) => a.depth - b.depth);
	for (const row of candidates) {
		if (visible.length < SUBAGENT_GRAPH_MAX_RUNNING && anchored(row)) {
			chosen.add(row.node.child.id);
			visible.push(row);
		} else {
			hidden.push(row);
		}
	}
	return { visible, hidden };
}

/**
 * Re-derive branch prefixes and depth-first order over just the selected rows:
 * hiding a sibling changes which visible row closes its parent bucket.
 */
function layoutVisibleForest(visible: readonly SubagentGraphRow[]): SubagentGraphRow[] {
	const ids = new Set(visible.map((row) => row.node.child.id));
	const byParent = new Map<string | undefined, SubagentGraphRow[]>();
	for (const row of visible) {
		const parent = row.node.child.parentId;
		const key = parent !== undefined && ids.has(parent) ? parent : undefined;
		const bucket = byParent.get(key);
		if (bucket) bucket.push(row);
		else byParent.set(key, [row]);
	}
	const ordered: SubagentGraphRow[] = [];
	const walk = (key: string | undefined, ancestors: string): void => {
		const bucket = byParent.get(key) ?? [];
		for (const [index, row] of bucket.entries()) {
			const isLast = index === bucket.length - 1;
			row.prefix = `${ancestors}${isLast ? "└─" : "├─"}`;
			ordered.push(row);
			walk(row.node.child.id, `${ancestors}${isLast ? "  " : "│ "}`);
		}
	};
	walk(undefined, "");
	return ordered;
}

function sumDefined(values: ReadonlyArray<number | undefined>): number | undefined {
	let total = 0;
	let any = false;
	for (const value of values) {
		if (value !== undefined) {
			total += value;
			any = true;
		}
	}
	return any ? total : undefined;
}

/** Shared right-cell vocabulary: runtime · tokens in/out, dimmed. */
function detailCell(
	durationMs: number | undefined,
	tokensIn: number | undefined,
	tokensOut: number | undefined,
): string {
	return [formatSubagentRuntime(durationMs), formatSubagentTokens(tokensIn, tokensOut, undefined)]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.map((part) => theme.fg("dim", part))
		.join(theme.fg("dim", " · "));
}

/** Lean display name: de-slugged session name, or the label capped to name width. */
function leanName(row: SubagentGraphRow): string {
	const named = formatSubagentName(row.node.child.sessionName);
	return formatSubagentTask(named || row.node.child.label, SUBAGENT_GRAPH_NAME_WIDTH) || "unnamed";
}

function subagentRowModel(row: SubagentGraphRow): SubagentRowModel {
	const { child } = row.node;
	return {
		name: leanName(row),
		task: "",
		status: agentDisplayStatus(child),
		spinnerFrame: getWorkingPulseFrame(),
		tokensIn: child.tokensIn,
		tokensOut: child.tokensOut,
		tokenCount: child.tokenCount,
		durationMs: child.durationMs,
		...(child.activeSessionId !== undefined ? { openTargetId: child.id } : {}),
	};
}

/**
 * Eight-row contract under the root: up to six running agents nested at their
 * real tree depth (branch prefix glued to the spinner glyph, lean name only),
 * then an overflow row summing the folded running agents and a done-summary
 * row aggregating every finished child. Right-aligned cells carry tokens in,
 * tokens out, and runtime throughout.
 */
export function formatSubagentGraph(
	rows: readonly SubagentGraphRow[],
	width: number,
	rootLabel: string = ROOT_LABEL,
): string[] {
	if (rows.length === 0 || width < 8) return [];
	const totals = summarizeChildSnapshots(rows);

	const errors = totals.errored > 0 ? ` · ${totals.errored} error` : "";
	const summary = `${totals.running}/${totals.total} running${errors}`;
	const rootTokens = formatSubagentTokens(undefined, undefined, totals.tokens || undefined);
	const rootLine = `${theme.fg("accent", "●")} ${theme.bold(rootLabel)}`;
	const rootDetail = [summary, rootTokens].filter((part) => part !== undefined && part !== "").join(" · ");
	const lines: string[] = [formatTwoSidedRow(rootLine, theme.fg("dim", rootDetail), width, { gap: GAP })];

	const { visible, hidden } = selectRunningRows(rows);
	for (const row of layoutVisibleForest(visible)) {
		lines.push(renderSubagentRow({ ...subagentRowModel(row), prefix: theme.fg("dim", row.prefix) }, width));
	}

	if (hidden.length > 0) {
		lines.push(
			formatTwoSidedRow(
				theme.fg("muted", `  … ${hidden.length} more running`),
				detailCell(
					sumDefined(hidden.map((row) => row.node.child.durationMs)),
					sumDefined(hidden.map((row) => row.node.child.tokensIn)),
					sumDefined(hidden.map((row) => row.node.child.tokensOut)),
				),
				width,
				{ gap: GAP },
			),
		);
	}

	const finished = rows.filter(isFinishedRow);
	if (finished.length > 0) {
		const failed = finished.filter((row) => row.node.child.status === "error").length;
		const noun = finished.length === 1 ? "agent" : "agents";
		lines.push(
			formatTwoSidedRow(
				theme.fg(
					"muted",
					`  ${finished.length} ${noun} done (${finished.length - failed} succeeded, ${failed} failed)`,
				),
				detailCell(
					sumDefined(finished.map((row) => row.node.child.durationMs)),
					sumDefined(finished.map((row) => row.node.child.tokensIn)),
					sumDefined(finished.map((row) => row.node.child.tokensOut)),
				),
				width,
				{ gap: GAP },
			),
		);
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
		this.anyActive = this.rows.some((row) => isChildAgentActive(row.node.child));
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
		return this.isVisible() && this.rows.some((row) => agentDisplayStatus(row.node.child) === "running");
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
