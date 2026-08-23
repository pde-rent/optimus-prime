import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLockSyncWithRetry } from "../file-lock.js";

export const TODO_FILENAME = ".optimus-todo.json";

export type TodoStatus = "todo" | "ongoing" | "done";
export const TODO_STATUSES: readonly TodoStatus[] = ["todo", "ongoing", "done"];

export interface TodoTask {
	id: string;
	title: string;
	status: TodoStatus;
	/** Agents responsible for the task; several agents may share one task. */
	assignees: string[];
	/** Parent task id, or null for a root-level task. */
	parent_id: string | null;
	priority?: string;
	notes: string[];
	created_at: string;
	updated_at: string;
}

export interface TodoBoard {
	version: 1;
	/** Agent in charge of overall completion of the board (default "root"). */
	coordinator: string;
	tasks: TodoTask[];
}

export function todoStorePath(cwd: string): string {
	return join(cwd, TODO_FILENAME);
}

function emptyBoard(): TodoBoard {
	return { version: 1, coordinator: "root", tasks: [] };
}

function nowIso(): string {
	return new Date().toISOString();
}

function parseBoard(raw: string): TodoBoard {
	const parsed = JSON.parse(raw) as Partial<TodoBoard>;
	if (parsed.version !== 1) {
		throw new Error(`Unsupported ${TODO_FILENAME} version: ${String(parsed.version)}.`);
	}
	if (!Array.isArray(parsed.tasks)) {
		throw new Error(`Corrupt ${TODO_FILENAME}: tasks must be an array.`);
	}
	return { version: 1, coordinator: parsed.coordinator ?? "root", tasks: parsed.tasks };
}

/** Reads the board without locking; returns an empty board when the file does not exist. */
export function readTodoBoard(cwd: string): TodoBoard {
	const path = todoStorePath(cwd);
	if (!existsSync(path)) return emptyBoard();
	return parseBoard(readFileSync(path, "utf-8"));
}

function writeAtomic(path: string, data: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, data, "utf-8");
	renameSync(tmp, path);
}

/** Depth-first tree order over flat parent_id rows; orphans are treated as roots. */
export function todoTreeRows(tasks: TodoTask[]): Array<{ task: TodoTask; depth: number }> {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const childrenOf = new Map<string | null, TodoTask[]>();
	for (const task of tasks) {
		const parent = task.parent_id !== null && byId.has(task.parent_id) ? task.parent_id : null;
		const siblings = childrenOf.get(parent) ?? [];
		siblings.push(task);
		childrenOf.set(parent, siblings);
	}
	const rows: Array<{ task: TodoTask; depth: number }> = [];
	const walk = (parent: string | null, depth: number): void => {
		for (const task of childrenOf.get(parent) ?? []) {
			rows.push({ task, depth });
			walk(task.id, depth + 1);
		}
	};
	walk(null, 0);
	return rows;
}

function findTask(tasks: TodoTask[], id: string): TodoTask | undefined {
	return tasks.find((task) => task.id === id);
}

/**
 * Shared TODO workbench storage.
 *
 * The JSON file at <cwd>/.optimus-todo.json is the only truth: every mutation
 * takes a file lock, reads the board, applies the change, and writes it back
 * atomically (tmp + rename), so concurrent agent sessions in one workspace
 * stay consistent without any daemon.
 */
export class TodoStore {
	readonly path: string;

	constructor(readonly cwd: string) {
		this.path = todoStorePath(cwd);
	}

	/** Reads the current board (unlocked read). */
	load(): TodoBoard {
		return readTodoBoard(this.cwd);
	}

	private mutate<T>(fn: (board: TodoBoard) => T): T {
		mkdirSync(dirname(this.path), { recursive: true });
		if (!existsSync(this.path)) {
			writeAtomic(this.path, `${JSON.stringify(emptyBoard(), null, 2)}\n`);
		}
		const release = acquireLockSyncWithRetry(`${this.path}.lock`, "todo");
		try {
			const board = readTodoBoard(this.cwd);
			const result = fn(board);
			writeAtomic(this.path, `${JSON.stringify(board, null, 2)}\n`);
			return result;
		} finally {
			release();
		}
	}

	private nextId(tasks: TodoTask[]): string {
		let max = 0;
		for (const task of tasks) {
			const match = /^t(\d+)$/.exec(task.id);
			if (match) max = Math.max(max, Number(match[1]));
		}
		return `t${max + 1}`;
	}

	add(title: string, options?: { parentId?: string; assignees?: string[]; priority?: string }): TodoTask {
		const trimmed = title.trim();
		if (!trimmed) throw new Error("Task title must not be empty.");
		return this.mutate((board) => {
			const parentId = options?.parentId ?? null;
			if (parentId !== null && !findTask(board.tasks, parentId)) {
				throw new Error(`Parent task not found: ${parentId}.`);
			}
			const now = nowIso();
			const task: TodoTask = {
				id: this.nextId(board.tasks),
				title: trimmed,
				status: "todo",
				assignees: options?.assignees ?? [],
				parent_id: parentId,
				priority: options?.priority,
				notes: [],
				created_at: now,
				updated_at: now,
			};
			board.tasks.push(task);
			return task;
		});
	}

	update(
		id: string,
		patch: {
			title?: string;
			status?: TodoStatus;
			assignees?: string[];
			priority?: string;
			note?: string;
			coordinator?: string;
		},
	): TodoTask {
		return this.mutate((board) => {
			const task = findTask(board.tasks, id);
			if (!task) throw new Error(`Task not found: ${id}.`);
			if (patch.title !== undefined) {
				const trimmed = patch.title.trim();
				if (!trimmed) throw new Error("Task title must not be empty.");
				task.title = trimmed;
			}
			if (patch.status !== undefined) task.status = patch.status;
			if (patch.assignees !== undefined) task.assignees = [...patch.assignees];
			if (patch.priority !== undefined) task.priority = patch.priority;
			if (patch.note !== undefined && patch.note.trim()) task.notes.push(patch.note.trim());
			if (patch.coordinator !== undefined) board.coordinator = patch.coordinator;
			task.updated_at = nowIso();
			return task;
		});
	}

	/** Removes a task and its whole subtree (all descendants at any depth). */
	remove(id: string): void {
		this.mutate((board) => {
			const doomed = new Set<string>([id]);
			let grew = true;
			while (grew) {
				grew = false;
				for (const task of board.tasks) {
					if (task.parent_id !== null && doomed.has(task.parent_id) && !doomed.has(task.id)) {
						doomed.add(task.id);
						grew = true;
					}
				}
			}
			const before = board.tasks.length;
			board.tasks = board.tasks.filter((task) => !doomed.has(task.id));
			if (board.tasks.length === before) throw new Error(`Task not found: ${id}.`);
		});
	}

	/**
	 * Claims a task for an assignee: sets status to ongoing and adds the
	 * assignee. Refuses when another live agent holds an ongoing claim unless
	 * force is set.
	 */
	claim(id: string, assignee: string, force = false): TodoTask {
		return this.mutate((board) => {
			const task = findTask(board.tasks, id);
			if (!task) throw new Error(`Task not found: ${id}.`);
			if (task.status === "ongoing" && task.assignees.length > 0 && !task.assignees.includes(assignee) && !force) {
				throw new Error(`Task ${id} is claimed by ${task.assignees.join(", ")}; pass force to take over.`);
			}
			if (!task.assignees.includes(assignee)) task.assignees.push(assignee);
			task.status = "ongoing";
			task.updated_at = nowIso();
			return task;
		});
	}

	done(id: string): TodoTask {
		return this.update(id, { status: "done" });
	}

	setCoordinator(name: string): void {
		this.mutate((board) => {
			board.coordinator = name;
		});
	}
}
