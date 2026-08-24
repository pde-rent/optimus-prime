import type { CustomMessage } from "../messages.js";
import { openTodoTasks, type TodoTask } from "./store.js";

export const TODO_WATCHDOG_CUSTOM_TYPE = "todo_watchdog";

interface TodoWatchdogDetails {
	kind: "continuation";
	/** Open (not done) task count at fire time. */
	openCount: number;
	/** Other agents still holding ongoing tasks when this session idled. */
	idleAssignees: string[];
}

function idleAssigneesFor(selfName: string, open: TodoTask[]): string[] {
	return [
		...new Set(
			open
				.filter((task) => task.status === "ongoing")
				.flatMap((task) => task.assignees)
				.filter((assignee) => assignee !== selfName && assignee !== "root"),
		),
	];
}

/**
 * Continuation prompt plus custom message for a session that went idle while
 * its todo board still has open work. When ongoing tasks belong to other
 * agents, the coordinator is told to re-delegate or finish them inline.
 */
export function buildTodoWatchdogContinuation(
	selfName: string,
	tasks: TodoTask[],
): { prompt: string; message: CustomMessage<TodoWatchdogDetails> } {
	const open = openTodoTasks(tasks);
	const idleAssignees = idleAssigneesFor(selfName, open);
	const lines = [
		"<todo_watchdog>",
		"This session went idle while the shared task board (.optimus-todo.json) still has open work.",
		"",
		"Report progress against the board, then continue with the next item:",
		...open.map((task) => {
			const holders = task.assignees.length > 0 ? ` (assignees: ${task.assignees.join(", ")})` : "";
			return `- [${task.status}] ${task.id}: ${task.title}${holders}`;
		}),
		"",
	];
	if (idleAssignees.length > 0) {
		lines.push(`Children ${idleAssignees.join(", ")} idle with ongoing tasks - re-delegate or do it inline.`, "");
	}
	lines.push(
		"If the board is actually finished, mark remaining tasks done so the watchdog stops firing.",
		"If you are blocked, say so in a task note; the watchdog keeps re-prompting otherwise.",
		"</todo_watchdog>",
	);
	const prompt = lines.join("\n");
	return {
		prompt,
		message: {
			role: "custom",
			customType: TODO_WATCHDOG_CUSTOM_TYPE,
			content: prompt,
			display: true,
			details: { kind: "continuation", openCount: open.length, idleAssignees },
			timestamp: Date.now(),
		},
	};
}
