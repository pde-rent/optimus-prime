import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatGoalUsage, type GoalState } from "../../core/goals.js";

export type GoalAnnouncementSnapshot = {
	goalId?: string;
	status: GoalState["status"];
	objective?: string;
	lastReason?: string;
	lastError?: string;
};

export function goalAnnouncementSnapshot(goal: GoalState): GoalAnnouncementSnapshot {
	return {
		goalId: goal.goalId,
		status: goal.status,
		objective: goal.objective,
		lastReason: goal.lastReason,
		lastError: goal.lastError,
	};
}

export function formatGoalStatus(goal: GoalState, terminalColumns: number): string {
	const usage = formatGoalUsage(goal);
	const usageText = usage ? ` (${usage})` : "";
	switch (goal.status) {
		case "idle":
			return "No active goal";
		case "active":
			return goal.objective
				? `Goal${formatGoalDetailSuffix(goal.objective, visibleWidth("Goal"), terminalColumns)}`
				: "Pursuing goal";
		case "paused":
			return goal.lastReason
				? `Goal paused${formatGoalDetailSuffix(goal.lastReason, visibleWidth("Goal paused"), terminalColumns)}`
				: "Goal paused (/goal resume)";
		case "budget_limited":
			if (goal.lastReason) {
				const prefix = `Goal budget limited${usageText}`;
				return prefix + formatGoalDetailSuffix(goal.lastReason, visibleWidth(prefix), terminalColumns);
			}
			return `Goal budget limited${usageText}`;
		case "complete":
			return goal.lastReason
				? `Goal complete${formatGoalDetailSuffix(goal.lastReason, visibleWidth("Goal complete"), terminalColumns)}`
				: "Goal complete";
		case "error":
			return goal.lastError
				? `Goal error${formatGoalDetailSuffix(goal.lastError, visibleWidth("Goal error"), terminalColumns)}`
				: "Goal error";
		default: {
			const _exhaustive: never = goal.status;
			return _exhaustive;
		}
	}
}

export function formatGoalDetailSuffix(
	value: string | undefined,
	prefixWidth: number,
	terminalColumns: number,
): string {
	const detail = value?.replace(/\s+/g, " ").trim();
	if (!detail) {
		return "";
	}
	const availableWidth = Math.min(120, Math.max(1, terminalColumns - prefixWidth - 2));
	if (availableWidth < 8) {
		return "";
	}
	return `: ${truncateToWidth(detail, availableWidth)}`;
}
