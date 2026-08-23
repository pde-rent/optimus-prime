/**
 * One status vocabulary for RLM children, shared by every surface that lists
 * them — the interactive graph panel and the agents view render the same
 * glyphs, colors and labels so a status means the same thing everywhere.
 */

import type { AgentConnectionRlmChildAgentSnapshot } from "./types.js";

export type AgentDisplayStatus = "waiting" | "running" | "idle" | "completed" | "error" | "cancelled";

export interface AgentStatusIndicator {
	/** Theme color name; render through theme.fg(color, glyph). */
	color: "accent" | "success" | "error" | "warning" | "dim";
	glyph: string;
	label: string;
}

// Shape encodes state class (circle = in flight, check = finished, cross = not
// finishing), color encodes polarity. A done child that still reports activity
// is rendering its answer, so it reads as running. A resident finished child
// (still attached) idles; an evicted one completed. Waiting is the pre-start
// queue state.
const INDICATORS: Record<AgentDisplayStatus, AgentStatusIndicator> = {
	waiting: { color: "dim", glyph: "○", label: "Waiting" },
	running: { color: "accent", glyph: "●", label: "Running" },
	idle: { color: "warning", glyph: "◐", label: "Idle" },
	completed: { color: "success", glyph: "✓", label: "Completed" },
	error: { color: "error", glyph: "✗", label: "Failed" },
	cancelled: { color: "dim", glyph: "✕", label: "Cancelled" },
};

/**
 * Display status for a child snapshot. A child whose run finished but that is
 * still emitting its final answer shows as running, never as idle mid-stream;
 * a finished child that keeps its runtime shows as idle.
 */
export function agentDisplayStatus(
	child: Pick<AgentConnectionRlmChildAgentSnapshot, "status" | "activity" | "activeSessionId">,
): AgentDisplayStatus {
	if (child.status === "done") {
		if (child.activity) return "running";
		return child.activeSessionId !== undefined ? "idle" : "completed";
	}
	if (child.status === "queued") return "waiting";
	return child.status;
}

export function agentStatusIndicator(status: AgentDisplayStatus): AgentStatusIndicator {
	return INDICATORS[status];
}

/**
 * True while a child still needs the fan-out panel visible: in flight, queued,
 * or streaming a follow-up turn after its run finished.
 */
export function isChildAgentActive(child: Pick<AgentConnectionRlmChildAgentSnapshot, "status" | "activity">): boolean {
	return child.status === "running" || child.status === "queued" || child.activity !== undefined;
}
