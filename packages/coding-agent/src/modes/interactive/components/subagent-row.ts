import { padStartAnsi, SPINNER_FRAMES, visibleWidth } from "@earendil-works/pi-tui";
import {
	type AgentDisplayStatus,
	type AgentStatusIndicator,
	agentStatusIndicator,
} from "../../agent-connection/agent-status.js";
import type { SessionSummary } from "../../daemon/daemon-session-list.js";
import { formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";
import { clickToOpenAgent } from "./click-target.js";
import { formatTwoSidedRow } from "./row-format.js";

export interface SubagentRowModel {
	/** Human-facing agent name; never a raw session slug or id. Empty falls back to task text. */
	name: string;
	/** One-line task summary; truncated before the name is. */
	task: string;
	status: AgentDisplayStatus;
	/** Global spinner frame for running rows; read once per render. */
	spinnerFrame?: number;
	tokensIn?: number;
	tokensOut?: number;
	tokenCount?: number;
	/** Child model's context window; turns the context cell into "12.3k/1.0M 34%". */
	contextWindow?: number;
	durationMs?: number;
	/** Extra right-cell note (e.g. the agents view's age), rendered last. */
	note?: string;
	/** Category-specific detail cell (e.g. an exit reason), rendered before the note. */
	reason?: string;
	/** Tree or indent prefix drawn before the status icon. */
	prefix?: string;
	/** Small note appended after the task cell, already styled by the caller. */
	badge?: string;
	/** Set when clicking the row should open this agent's session (its child id). */
	openTargetId?: string;
}

/** Fixed right-cell column order shared by every surface that renders roster rows. */
const CELL_SEPARATOR = " · ";
const CELL_SLOTS = 5;

/**
 * One assembled roster row handed to {@link renderSubagentRowsAligned}; also
 * what {@link subagentRowSpec} produces from a {@link SubagentRowModel}.
 */
export interface SubagentAlignedRowSpec {
	/** Fully composed left side: prefix, glyph, name, task, badge. */
	left: string;
	/** Right metric cells in fixed column order; gaps keep their slot width. */
	cells: ReadonlyArray<string | undefined>;
	openTargetId?: string;
}

/** "↓ 12k ↑ 400" from the split counts, or "↓ 2.0k" from a single total. */
export function formatSubagentTokens(
	tokensIn: number | undefined,
	tokensOut: number | undefined,
	tokenCount: number | undefined,
): string | undefined {
	if (tokensIn !== undefined || tokensOut !== undefined) {
		const parts = [
			tokensIn ? `↓ ${formatTokenCount(tokensIn)}` : undefined,
			tokensOut ? `↑ ${formatTokenCount(tokensOut)}` : undefined,
		].filter((part) => part !== undefined);
		if (parts.length > 0) return parts.join(" ");
	}
	return tokenCount ? `↓ ${formatTokenCount(tokenCount)}` : undefined;
}

/**
 * Context-pressure cell: "12.3k/1.0M 34%" against the child's window, else the
 * bare token count, else nothing.
 */
export function formatSubagentContextCell(
	tokenCount: number | undefined,
	contextWindow: number | undefined,
): string | undefined {
	if (tokenCount === undefined) return undefined;
	if (contextWindow === undefined || contextWindow <= 0) return formatTokenCount(tokenCount);
	const percent = Math.round((tokenCount / contextWindow) * 100);
	return `${formatTokenCount(tokenCount)}/${formatTokenCount(contextWindow)} ${percent}%`;
}

/** Right metric cells for one row, in fixed column order. */
export function subagentMetricCells(model: SubagentRowModel): ReadonlyArray<string | undefined> {
	const hasTokenSplit = model.tokensIn !== undefined || model.tokensOut !== undefined;
	return [
		formatSubagentRuntime(model.durationMs),
		formatSubagentTokens(model.tokensIn, model.tokensOut, model.tokenCount),
		// Without a split the bare count would only repeat the tokens cell.
		model.contextWindow !== undefined || hasTokenSplit
			? formatSubagentContextCell(model.tokenCount, model.contextWindow)
			: undefined,
		model.reason,
		model.note,
	];
}

/** Max visible width per metric column across every row that renders one. */
export function subagentColumnWidths(models: readonly SubagentRowModel[]): number[] {
	return columnWidthsFromCells(models.map((model) => subagentMetricCells(model)));
}

function columnWidthsFromCells(cellRows: ReadonlyArray<ReadonlyArray<string | undefined>>): number[] {
	const widths = Array.from({ length: CELL_SLOTS }, () => 0);
	for (const cells of cellRows) {
		cells.forEach((cell, index) => {
			if (cell !== undefined && cell.length > 0) {
				widths[index] = Math.max(widths[index] ?? 0, visibleWidth(cell));
			}
		});
	}
	return widths;
}

/** "47s", "1m 02s", or "3h 12m" of total runtime. */
export function formatSubagentRuntime(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Display name for a child session. Default daemon names are generated slugs
 * ("subagent-explore-auth-flows-a1b2c3d4") that mean nothing to users, so the
 * mechanical prefix and id suffix are stripped and dashes become spaces.
 * User-chosen names pass through untouched.
 */
export function formatSubagentName(sessionName: string | undefined): string {
	const raw = sessionName?.trim();
	if (!raw) return "";
	const match = /^subagent-(.+)-[a-z0-9]{4,}$/i.exec(raw);
	if (!match) return raw;
	const stem = match[1]?.replace(/-/g, " ").trim();
	return stem || raw;
}

/** Collapse whitespace and cap the length so a long prompt stays one row. */
export function formatSubagentTask(text: string | undefined, maxLength = 120): string {
	const compact = text?.replace(/\s+/g, " ").trim() ?? "";
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Live status for a listed session summary, using the shared vocabulary. */
export function subagentStatusForSummary(
	summary: Pick<SessionSummary, "activity" | "isStreaming" | "activeSessionId">,
): AgentDisplayStatus {
	if (summary.isStreaming || summary.activity === "working") return "running";
	return summary.activeSessionId !== undefined ? "idle" : "completed";
}

function joinAlignedCells(cells: ReadonlyArray<string | undefined>, widths: readonly number[]): string {
	let first = -1;
	let last = -1;
	cells.forEach((cell, index) => {
		if (cell !== undefined && cell.length > 0) {
			if (first < 0) first = index;
			last = index;
		}
	});
	if (first < 0) return "";
	const parts: string[] = [];
	for (let index = first; index <= last; index += 1) {
		const cell = cells[index];
		const column = Math.max(widths[index] ?? 0, cell === undefined ? 0 : visibleWidth(cell));
		parts.push(cell === undefined || cell.length === 0 ? " ".repeat(column) : padStartAnsi(cell, column));
	}
	return parts.join(CELL_SEPARATOR);
}

function renderAlignedSpec(spec: SubagentAlignedRowSpec, right: string, width: number): string {
	const line = formatTwoSidedRow(spec.left, right, width, { gap: 2, minLeftWidth: 16 });
	return spec.openTargetId === undefined ? line : clickToOpenAgent(line, spec.openTargetId);
}

/**
 * Render aligned roster rows: per-column widths are computed across every spec
 * so runtime, tokens, context, reason, and note read as table columns.
 */
export function renderSubagentRowsAligned(specs: readonly SubagentAlignedRowSpec[], width: number): string[] {
	const widths = columnWidthsFromCells(specs.map((spec) => spec.cells));
	return specs.map((spec) => renderAlignedSpec(spec, theme.fg("dim", joinAlignedCells(spec.cells, widths)), width));
}

/** A force-stopped child is user-interrupted, not a success; the halt marker reads in warning tone. */
const STOPPED_INDICATOR: AgentStatusIndicator = { color: "warning", glyph: "\u25a0", label: "Stopped" };

function statusIndicator(status: AgentDisplayStatus): AgentStatusIndicator {
	// The shared map still reads cancelled as a dim cross; a killed child must
	// not share a visual family with quiet terminal states.
	return status === "cancelled" ? STOPPED_INDICATOR : agentStatusIndicator(status);
}

function composeSubagentLeft(model: SubagentRowModel): string {
	let glyph: string;
	if (model.status === "running") {
		const frames = SPINNER_FRAMES;
		const frame =
			model.spinnerFrame === undefined ? 0 : ((model.spinnerFrame % frames.length) + frames.length) % frames.length;
		glyph = theme.fg("accent", frames[frame] ?? frames[0]);
	} else {
		const indicator = statusIndicator(model.status);
		glyph = theme.fg(indicator.color, indicator.glyph);
	}
	// Without a session name the task excerpt doubles as the name.
	const named = model.name.length > 0;
	const name = named ? model.name : formatSubagentTask(model.task, 40);
	const task = named ? model.task : "";
	const badge = model.badge ?? "";
	// The prefix glues straight onto the glyph so tree branches read as one
	// mark; callers wanting separation include it in their prefix string.
	return `${model.prefix ?? ""}${[glyph, name, task]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join(" ")}${badge}`;
}

/** The row as an aligned spec, shared by single-row and batch rendering. */
export function subagentRowSpec(model: SubagentRowModel): SubagentAlignedRowSpec {
	return {
		left: composeSubagentLeft(model),
		cells: subagentMetricCells(model),
		...(model.openTargetId !== undefined ? { openTargetId: model.openTargetId } : {}),
	};
}

/**
 * One row of the live subagent roster, shared by the chat graph panel and the
 * agents view: status icon + name + truncated task on the left, runtime and
 * token spend right-aligned in columns shared across sibling rows (pass the
 * caller's {@link subagentColumnWidths} result to line up a whole table).
 * Always exactly `width` columns wide.
 */
export function renderSubagentRow(model: SubagentRowModel, width: number, columnWidths?: readonly number[]): string {
	const spec = subagentRowSpec(model);
	if (columnWidths === undefined) {
		return renderSubagentRowsAligned([spec], width)[0] ?? "";
	}
	const right = theme.fg("dim", joinAlignedCells(spec.cells, columnWidths));
	return renderAlignedSpec(spec, right, width);
}
