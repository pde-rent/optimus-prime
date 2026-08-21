import { SPINNER_FRAMES } from "@earendil-works/pi-tui";
import { type AgentDisplayStatus, agentStatusIndicator } from "../../agent-connection/agent-status.js";
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
	durationMs?: number;
	/** Extra right-cell note (e.g. the agents view's age), rendered last. */
	note?: string;
	/** Tree or indent prefix drawn before the status icon. */
	prefix?: string;
	/** Small note appended after the task cell, e.g. an elided-descendant count. */
	badge?: string;
	/** Set when clicking the row should open this agent's session (its child id). */
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

/**
 * One row of the live subagent roster, shared by the chat graph panel and the
 * agents view: status icon + name + truncated task on the left, runtime and
 * token spend right-aligned. Always exactly `width` columns wide.
 */
export function renderSubagentRow(model: SubagentRowModel, width: number): string {
	let glyph: string;
	if (model.status === "running") {
		const frames = SPINNER_FRAMES;
		const frame =
			model.spinnerFrame === undefined ? 0 : ((model.spinnerFrame % frames.length) + frames.length) % frames.length;
		glyph = theme.fg("accent", frames[frame] ?? frames[0]);
	} else {
		const indicator = agentStatusIndicator(model.status);
		glyph = theme.fg(indicator.color, indicator.glyph);
	}
	// Without a session name the task excerpt doubles as the name.
	const named = model.name.length > 0;
	const name = named ? model.name : formatSubagentTask(model.task, 40);
	const task = named ? model.task : "";
	const badge = model.badge ? theme.fg("dim", model.badge) : "";
	const left = [model.prefix, glyph, name, task]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join(" ");
	const right = [
		formatSubagentRuntime(model.durationMs),
		formatSubagentTokens(model.tokensIn, model.tokensOut, model.tokenCount),
		model.note,
	]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.map((part) => theme.fg("dim", part))
		.join(theme.fg("dim", " · "));
	const line = formatTwoSidedRow(`${left}${badge}`, right, width, { gap: 2, minLeftWidth: 16 });
	return model.openTargetId === undefined ? line : clickToOpenAgent(line, model.openTargetId);
}
