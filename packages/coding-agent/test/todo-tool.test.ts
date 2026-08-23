import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLockSyncWithRetry } from "../src/core/file-lock.js";
import { readTodoBoard, TodoStore, todoStorePath } from "../src/core/todo/store.js";
import { createAllTools } from "../src/core/tools/index.js";
import { createTodoTool } from "../src/core/tools/native/todo.js";
import { getTextOutput } from "./helpers/render.js";
import { makeTempDirs } from "./helpers/temp.js";

describe("todo store", () => {
	const temps = makeTempDirs("todo-store-test-");
	let dir: string;
	let store: TodoStore;

	const setup = () => {
		dir = temps.create();
		store = new TodoStore(dir);
	};

	it("adds, updates and removes tasks with fresh ids", () => {
		setup();
		const task = store.add("Write spec", { assignees: ["alice"], priority: "P1" });
		expect(task.id).toBe("t1");
		expect(task.status).toBe("todo");
		expect(task.parent_id).toBeNull();

		const updated = store.update(task.id, {
			title: "Write spec v2",
			status: "ongoing",
			note: "waiting on review",
			priority: "P0",
		});
		expect(updated.title).toBe("Write spec v2");
		expect(updated.status).toBe("ongoing");
		expect(updated.notes).toEqual(["waiting on review"]);
		expect(updated.priority).toBe("P0");

		store.done(task.id);
		expect(store.load().tasks[0]?.status).toBe("done");

		store.remove(task.id);
		expect(store.load().tasks).toHaveLength(0);
	});

	it("reuses id numbers after removal (max + 1)", () => {
		setup();
		store.add("a");
		store.add("b");
		store.remove("t1");
		expect(store.add("c").id).toBe("t3");
	});

	it("nests via parent_id and removes whole subtrees", () => {
		setup();
		const parent = store.add("Team alpha");
		store.add("Subtask 1", { parentId: parent.id });
		store.add("Subtask 2", { parentId: parent.id });
		const child = store.add("Grandchild", { parentId: "t2" });

		const rows = store.load().tasks;
		expect(rows).toHaveLength(4);
		expect(child.parent_id).toBe("t2");

		store.remove(parent.id);
		expect(store.load().tasks).toHaveLength(0);

		store.add("orphan-parent");
		expect(() => store.add("bad", { parentId: "t99" })).toThrow(/Parent task not found/);
	});

	it("refuses a second live claim unless forced", () => {
		setup();
		store.add("shared task");
		store.claim("t1", "alice");
		expect(() => store.claim("t1", "bob")).toThrow(/claimed by alice/);

		const stolen = store.claim("t1", "bob", true);
		expect(stolen.assignees).toEqual(["alice", "bob"]);
		expect(stolen.status).toBe("ongoing");

		const again = store.claim("t1", "bob");
		expect(again.assignees).toEqual(["alice", "bob"]);
	});

	it("serialises concurrent mutations and stays atomic across a crashed write", () => {
		setup();
		store.add("first");
		// Simulate a crash mid-write: stale tmp file left behind, json intact.
		writeFileSync(join(dir, ".optimus-todo.json.tmp-999-1"), "{garbage", "utf-8");

		store.add("second");
		store.setCoordinator("worker-7");

		const board = readTodoBoard(dir);
		expect(board.version).toBe(2);
		expect(board.coordinator).toBe("worker-7");
		expect(board.tasks.map((task) => task.title)).toEqual(["first", "second"]);
		// The stale tmp file is untouched; the json itself is always valid.
		expect(existsSync(join(dir, ".optimus-todo.json.tmp-999-1"))).toBe(true);
		expect(JSON.parse(readFileSync(todoStorePath(dir), "utf-8"))).toHaveProperty("version", 2);
	});

	it("waits on the file lock: second acquirer fails while held, succeeds after release", async () => {
		setup();
		store.add("locked task");
		const release = acquireLockSyncWithRetry(`${todoStorePath(dir)}.lock`, "test");
		let failed = false;
		try {
			store.add("during lock");
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		release();
		expect(store.add("after release").title).toBe("after release");
	});
});

describe("todo tool", () => {
	const temps = makeTempDirs("todo-tool-test-");
	let dir: string;
	let tool: ReturnType<typeof createTodoTool>;

	const setup = () => {
		dir = temps.create();
		tool = createTodoTool(dir);
	};

	it("adds, claims, lists and removes through the tool surface", async () => {
		setup();
		await tool.execute("c1", { op: "add", title: "Plan release", assignees: ["alice"], priority: "P1" });
		await tool.execute("c2", { op: "add", title: "Subtask", parent_id: "t1" });
		await tool.execute("c3", { op: "claim", id: "t2", assignee: "bob" });

		const listed = await tool.execute("c4", { op: "list" });
		const text = getTextOutput(listed);
		expect(text).toContain("coordinator: root");
		expect(text).toContain("[t1] todo [alice] Plan release (P1)");
		expect(text).toContain("  [t2] ongoing [bob] Subtask");
		expect(listed.details.count).toBe(2);

		const filtered = await tool.execute("c5", { op: "list", assignee: "bob" });
		const filteredText = getTextOutput(filtered);
		expect(filteredText).toContain("[t2]");
		expect(filteredText).toContain("[t1]"); // ancestor kept as context

		await tool.execute("c6", { op: "update", id: "t1", status: "done", note: "shipped" });
		expect(readTodoBoard(dir).tasks[0]?.status).toBe("done");

		await tool.execute("c7", { op: "remove", id: "t1" });
		expect(readTodoBoard(dir).tasks).toHaveLength(0);
	});

	it("rejects a conflicting claim with a clear error", async () => {
		setup();
		await tool.execute("d1", { op: "add", title: "contested" });
		await tool.execute("d2", { op: "claim", id: "t1", assignee: "alice" });
		await expect(tool.execute("d3", { op: "claim", id: "t1", assignee: "carol" })).rejects.toThrow(
			/claimed by alice/,
		);
	});

	it("truncates list output within byte budgets", async () => {
		setup();
		for (let i = 0; i < 50; i++) {
			await tool.execute(`e${i}`, { op: "add", title: `task number ${i} with padding` });
		}
		const full = await tool.execute("e-full", { op: "list" });
		expect(full.details.truncated).toBe(false);
		expect(full.details.count).toBe(50);

		const capped = createTodoTool(dir, { maxLines: 5, maxBytes: 4096 });
		const cut = await capped.execute("e-capped", { op: "list" });
		expect(cut.details.truncated).toBe(true);
		expect(getTextOutput(cut)).toContain("[Truncated");
	});

	it("is registered as a built-in tool", () => {
		setup();
		const tools = createAllTools(dir);
		expect(tools.todo?.name).toBe("todo");
	});
});
