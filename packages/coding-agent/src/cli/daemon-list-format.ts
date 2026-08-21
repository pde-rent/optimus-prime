import { formatSessionDisplayId } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { color as chalk } from "../utils/ansi.js";
import { formatElapsedDuration, formatTable } from "../utils/shared.js";

// Display status derived from the lifecycle + activity axes.
type ListStatus = "working" | "idle" | "archived";

const LIST_STATUS_ORDER: Record<ListStatus, number> = {
	working: 0,
	idle: 1,
	archived: 2,
};

function listStatusForSummary(summary: SessionSummary): ListStatus {
	if (summary.lifecycle === "archived") {
		return "archived";
	}
	return summary.activity === "working" ? "working" : "idle";
}

type ListRow = {
	name: string;
	id: string;
	status: ListStatus;
	age: string;
	model: string;
	messages: string;
	clients: string;
};

export function formatSessionListTable(sessions: readonly SessionSummary[], nowMs = Date.now()): string {
	const rows = sortSessionsForList(sessions).map((session) => ({
		name: session.sessionName ?? "",
		id: formatSessionDisplayId(session.id),
		status: listStatusForSummary(session),
		age: formatSessionAge(session.modified, nowMs),
		model: formatSessionModel(session.model),
		messages: String(session.messageCount),
		clients: String(session.attachedClients),
	}));
	return formatTable(["name", "id", "status", "age", "model", "messages", "clients"], rows, formatListCell);
}

function sortSessionsForList(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((left, right) => {
			const statusDelta =
				LIST_STATUS_ORDER[listStatusForSummary(left.session)] -
				LIST_STATUS_ORDER[listStatusForSummary(right.session)];
			return statusDelta || left.index - right.index;
		})
		.map(({ session }) => session);
}

function formatListCell(row: ListRow, column: keyof ListRow, value: string): string {
	if (column !== "status") {
		return value;
	}

	switch (row.status) {
		case "working":
			return chalk.red(value);
		case "idle":
			return chalk.blue(value);
		case "archived":
			return chalk.dim(value);
	}
}

function formatSessionAge(modified: string | undefined, nowMs: number): string {
	if (!modified) {
		return "";
	}
	const modifiedMs = new Date(modified).getTime();
	if (Number.isNaN(modifiedMs)) {
		return "";
	}
	return formatElapsedDuration(Math.max(0, Math.floor((nowMs - modifiedMs) / 1000)), "year");
}

function formatSessionModel(model: SessionSummary["model"]): string {
	return model ? `${model.provider}/${model.id}` : "";
}
