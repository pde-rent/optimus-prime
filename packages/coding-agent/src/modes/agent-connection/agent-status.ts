/**
 * One status vocabulary for RLM children, shared by every surface that lists
 * them — the interactive graph panel and the agents view render the same
 * glyphs, colors and labels so a status means the same thing everywhere.
 */

import type { AgentConnectionRlmChildAgentSnapshot } from "./types.js";

export type AgentDisplayStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface AgentStatusIndicator {
	/** Theme color name; render through theme.fg(color, glyph). */
	color: "accent" | "success" | "error" | "dim";
	glyph: string;
	label: string;
}

// Shape encodes state class (circle = in flight, check = finished, cross = not
// finishing), color encodes polarity. A done child that still reports activity
// is rendering its answer, so it reads as running.
const INDICATORS: Record<AgentDisplayStatus, AgentStatusIndicator> = {
	queued: { color: "dim", glyph: "○", label: "Queued" },
	running: { color: "accent", glyph: "●", label: "Running" },
	done: { color: "success", glyph: "✓", label: "Done" },
	error: { color: "error", glyph: "✗", label: "Failed" },
	cancelled: { color: "dim", glyph: "✕", label: "Cancelled" },
};

/**
 * Display status for a child snapshot. A child whose run finished but that is
 * still emitting its final answer shows as running, never as idle or done
 * mid-stream.
 */
export function agentDisplayStatus(
	child: Pick<AgentConnectionRlmChildAgentSnapshot, "status" | "activity">,
): AgentDisplayStatus {
	if (child.status === "done" && child.activity) return "running";
	return child.status;
}

export function agentStatusIndicator(status: AgentDisplayStatus): AgentStatusIndicator {
	return INDICATORS[status];
}

export function agentStatusIndicatorFor(
	child: Pick<AgentConnectionRlmChildAgentSnapshot, "status" | "activity">,
): AgentStatusIndicator {
	return INDICATORS[agentDisplayStatus(child)];
}
