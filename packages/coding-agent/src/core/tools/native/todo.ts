import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../extensions/types.js";
import { type TodoStatus, TodoStore, todoTreeRows } from "../../todo/store.js";
import { throwIfAborted } from "../abortable.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";

const statusType = Type.Union([Type.Literal("todo"), Type.Literal("ongoing"), Type.Literal("done")], {
	description: "todo = not started; ongoing = claimed work in progress (use a note for blocked); done = finished.",
});

const todoSchema = Type.Union(
	[
		Type.Object(
			{
				op: Type.Literal("add"),
				title: Type.String({ description: "Task title." }),
				parent_id: Type.Optional(
					Type.String({ description: "Create the task under this parent id (nested sublists)." }),
				),
				assignees: Type.Optional(
					Type.Array(Type.String(), { description: "Agents responsible; several may share one task." }),
				),
				priority: Type.Optional(Type.String({ description: 'Free-form priority label, e.g. "P1" or "high".' })),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				op: Type.Literal("update"),
				id: Type.String({ description: "Task id, e.g. t3." }),
				title: Type.Optional(Type.String({ description: "New title." })),
				status: Type.Optional(statusType),
				assignees: Type.Optional(Type.Array(Type.String(), { description: "Replaces the full assignee list." })),
				priority: Type.Optional(Type.String({ description: "New priority label." })),
				note: Type.Optional(Type.String({ description: "Appends a note (use for blockers, context, results)." })),
				coordinator: Type.Optional(
					Type.String({
						description:
							'Reassigns board coordination - who orchestrates overall completion (default "root", the main agent).',
					}),
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				op: Type.Literal("remove"),
				id: Type.String({ description: "Task id; its whole subtree is removed too." }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				op: Type.Literal("claim"),
				id: Type.String({ description: "Task id." }),
				assignee: Type.String({ description: "Agent taking the task; sets status to ongoing." }),
				force: Type.Optional(
					Type.Boolean({
						description: "Take over a task another live agent holds an ongoing claim on.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				op: Type.Literal("done"),
				id: Type.String({ description: "Task id to mark done." }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				op: Type.Literal("list"),
				status: Type.Optional(statusType),
				assignee: Type.Optional(Type.String({ description: "Only tasks this agent is assigned to." })),
			},
			{ additionalProperties: false },
		),
	],
	{ description: "Pick exactly one op object; fields from other ops are rejected." },
);

export type TodoToolInput = Static<typeof todoSchema>;

export interface TodoToolOptions {
	maxLines?: number;
	maxBytes?: number;
}

export interface TodoToolDetails {
	op: "add" | "update" | "remove" | "claim" | "done" | "list";
	/** Tasks listed, or 1 for a successful single-task mutation. */
	count: number;
	truncated: boolean;
}

/**
 * Shared team task board over <cwd>/.optimus-todo.json.
 *
 * Use it as the DEFAULT way to plan, track, and coordinate work across agents:
 * add nested sublists, share tasks between assignees, claim work before
 * starting, and mark done. Every mutation takes a file lock and rewrites the
 * JSON atomically, so sibling sessions in the same workspace stay consistent
 * without any daemon. Do not use it for transient personal scratch notes that
 * nobody else needs to see.
 */
export function createTodoToolDefinition(
	cwd: string,
	options?: TodoToolOptions,
): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	const store = new TodoStore(cwd);
	const definition: ToolDefinition<typeof todoSchema, TodoToolDetails> = {
		name: "todo",
		label: "todo",
		description:
			"Shared team task board - the DEFAULT way to plan and coordinate work across agents; ops add/update/remove/claim/done/list over .optimus-todo.json in the workspace, lock-protected so concurrent agent sessions stay consistent; tasks nest via parent_id and support multiple assignees per task. Not for transient personal scratch notes.",
		promptSnippet: "Shared team task board (add/update/claim/done/list); default planning surface across agents",
		parameters: todoSchema,
		executionMode: "sequential",
		kind: "edit",
		read_only: false,
		renderCall(args, theme) {
			const op = "op" in args ? args.op : "...";
			const detail = "title" in args ? args.title : "id" in args ? args.id : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("todo"))} ${theme.fg("accent", String(op))}${detail ? theme.fg("dim", ` ${String(detail)}`) : ""}`,
				0,
				0,
			);
		},
		async execute(
			_toolCallId,
			input: TodoToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: TodoToolDetails }> {
			throwIfAborted(signal);

			if (input.op === "add") {
				const task = store.add(input.title, {
					parentId: input.parent_id,
					assignees: input.assignees,
					priority: input.priority,
				});
				const scope = task.parent_id ? ` under ${task.parent_id}` : "";
				return {
					content: [{ type: "text", text: `Added ${task.id}${scope}: ${task.title}` }],
					details: { op: "add", count: 1, truncated: false },
				};
			}

			if (input.op === "update") {
				const task = store.update(input.id, {
					title: input.title,
					status: input.status,
					assignees: input.assignees,
					priority: input.priority,
					note: input.note,
					coordinator: input.coordinator,
				});
				let text = `Updated ${task.id}: status=${task.status}, assignees=${task.assignees.join(", ")}`;
				if (input.coordinator !== undefined) text += `; board coordinator is now ${input.coordinator}`;
				return {
					content: [{ type: "text", text }],
					details: { op: "update", count: 1, truncated: false },
				};
			}

			if (input.op === "remove") {
				store.remove(input.id);
				return {
					content: [{ type: "text", text: `Removed ${input.id} and its subtree.` }],
					details: { op: "remove", count: 1, truncated: false },
				};
			}

			if (input.op === "claim") {
				const task = store.claim(input.id, input.assignee, input.force ?? false);
				return {
					content: [
						{
							type: "text",
							text: `Claimed ${task.id} for ${input.assignee} (assignees: ${task.assignees.join(", ")})`,
						},
					],
					details: { op: "claim", count: 1, truncated: false },
				};
			}

			if (input.op === "done") {
				const task = store.done(input.id);
				return {
					content: [{ type: "text", text: `Marked ${task.id} done: ${task.title}` }],
					details: { op: "done", count: 1, truncated: false },
				};
			}

			const board = store.load();
			const match = (status: TodoStatus | undefined, assignee: string | undefined) => {
				return (id: string) => {
					const task = board.tasks.find((candidate) => candidate.id === id);
					if (!task) return false;
					if (status !== undefined && task.status !== status) return false;
					if (assignee !== undefined && !task.assignees.includes(assignee)) return false;
					return true;
				};
			};
			const keep = match(input.status, input.assignee);
			const allRows = todoTreeRows(board.tasks);
			const visible = new Set<string>();
			for (const row of allRows) {
				if (keep(row.task.id)) {
					visible.add(row.task.id);
					let parent = row.task.parent_id;
					while (parent !== null && !visible.has(parent)) {
						visible.add(parent);
						parent = allRows.find((candidate) => candidate.task.id === parent)?.task.parent_id ?? null;
					}
				}
			}
			const lines = [`coordinator: ${board.coordinator}`];
			for (const row of allRows) {
				if (!visible.has(row.task.id)) continue;
				const indent = "  ".repeat(row.depth);
				const people = row.task.assignees.length > 0 ? ` [${row.task.assignees.join(", ")}]` : "";
				const pri = row.task.priority ? ` (${row.task.priority})` : "";
				lines.push(`${indent}[${row.task.id}] ${row.task.status}${people} ${row.task.title}${pri}`);
			}
			const truncation = truncateHead(lines.join("\n"), {
				maxLines: options?.maxLines,
				maxBytes: options?.maxBytes,
			});
			let text = truncation.content;
			if (truncation.truncated) {
				text += "\n\n[Truncated. Narrow the status/assignee filters.]";
			}
			return {
				content: [{ type: "text", text }],
				details: { op: "list", count: Math.max(visible.size, 0), truncated: truncation.truncated },
			};
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "todo" as const });
}

export function createTodoTool(cwd: string, options?: TodoToolOptions): AgentTool<typeof todoSchema> {
	return wrapToolDefinition(createTodoToolDefinition(cwd, options));
}
