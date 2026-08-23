import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir } from "../src/config.js";
import { AgentSession } from "../src/core/agent-session.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { type TodoBoard, TodoStore, todoStorePath } from "../src/core/todo/store.js";
import { buildTodoWatchdogContinuation, TODO_WATCHDOG_CUSTOM_TYPE } from "../src/core/todo/watchdog.js";
import { makeTempDirs } from "./helpers/temp.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { waitFor } from "./suite/helpers.js";

const WATCHDOG_SETTINGS = { todoWatchdogEnabled: true, todoWatchdogDelaySeconds: 0.05 };

const temps = makeTempDirs("todo-watchdog-test-");

function watchdogMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === TODO_WATCHDOG_CUSTOM_TYPE,
	);
}

function seedBoard(cwd: string, tasks: Array<Partial<TodoBoard["tasks"][number]>>): void {
	writeFileSync(
		todoStorePath(cwd),
		`${JSON.stringify(
			{
				version: 2,
				coordinator: "root",
				tasks: tasks.map((task, index) => ({
					id: `t${index + 1}`,
					title: "task",
					status: "todo",
					assignees: [],
					parent_id: null,
					notes: [],
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-01T00:00:00.000Z",
					...task,
				})),
			},
			null,
			2,
		)}\n`,
	);
}

describe("todo store schema v2", () => {
	const v1Board = {
		version: 1,
		coordinator: "root",
		tasks: [
			{
				id: "t1",
				title: "legacy task",
				status: "todo",
				assignees: ["alice"],
				parent_id: null,
				notes: [],
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			},
		],
	};

	it("loads a v1 board and upgrades it to v2 on the next write", () => {
		const dir = temps.create();
		writeFileSync(todoStorePath(dir), JSON.stringify(v1Board));
		const store = new TodoStore(dir);
		// Back-compat defaults: v1 tasks read fine without v2 timestamps.
		expect(store.load().version).toBe(2);
		expect(store.load().tasks[0]?.started_at).toBeUndefined();
		expect(store.load().tasks[0]?.completed_at).toBeUndefined();
		store.update("t1", { note: "touched" });
		const raw = JSON.parse(readFileSync(todoStorePath(dir), "utf-8")) as TodoBoard;
		expect(raw.version).toBe(2);
	});

	it("rejects unknown schema versions", () => {
		const dir = temps.create();
		writeFileSync(todoStorePath(dir), JSON.stringify({ ...v1Board, version: 99 }));
		expect(() => new TodoStore(dir).load()).toThrow(/Unsupported .* version/);
	});

	it("sets started_at once on first ongoing and stamps/clears completed_at across done cycles", () => {
		const dir = temps.create();
		const store = new TodoStore(dir);
		store.add("lifecycle");
		expect(store.load().tasks[0]?.started_at).toBeUndefined();

		store.update("t1", { status: "ongoing" });
		const started = store.load().tasks[0]?.started_at;
		expect(started).toBeDefined();
		expect(store.load().tasks[0]?.completed_at).toBeUndefined();

		// A second ongoing transition must not move the first start.
		store.update("t1", { status: "todo" });
		store.update("t1", { status: "ongoing" });
		expect(store.load().tasks[0]?.started_at).toBe(started);

		store.done("t1");
		const completed = store.load().tasks[0]?.completed_at;
		expect(completed).toBeDefined();
		expect(store.load().tasks[0]?.started_at).toBe(started);

		// Reopening clears the completion stamp, keeps the first start.
		store.update("t1", { status: "todo" });
		expect(store.load().tasks[0]?.completed_at).toBeUndefined();
		expect(store.load().tasks[0]?.started_at).toBe(started);
	});
});

describe("todo watchdog prompt", () => {
	it("lists open tasks and names idle children holding ongoing work", () => {
		const { prompt, message } = buildTodoWatchdogContinuation("root", [
			{
				id: "t1",
				title: "parent item",
				status: "ongoing",
				assignees: ["child-a", "child-b"],
				parent_id: null,
				notes: [],
				created_at: "x",
				updated_at: "x",
			},
			{
				id: "t2",
				title: "done item",
				status: "done",
				assignees: [],
				parent_id: null,
				notes: [],
				created_at: "x",
				updated_at: "x",
			},
		]);
		expect(prompt).toContain("[ongoing] t1: parent item (assignees: child-a, child-b)");
		expect(prompt).not.toContain("t2");
		expect(prompt).toContain("Children child-a, child-b idle with ongoing tasks - re-delegate or do it inline.");
		expect(message.details).toEqual({ kind: "continuation", openCount: 1, idleAssignees: ["child-a", "child-b"] });
	});
});

describe("todo watchdog scheduling", () => {
	it("fires one continuation after a run ends idle with open todos (root)", async () => {
		const harness = await createHarness({ settings: WATCHDOG_SETTINGS });
		seedBoard(harness.tempDir, [{ id: "t1", title: "unfinished", status: "ongoing", assignees: ["root"] }]);
		harness.setResponses([fauxAssistantMessage("Stopping early."), fauxAssistantMessage("Continuing the board.")]);
		await harness.session.prompt("go");
		await waitFor(() => expect(watchdogMessages(harness).length).toBeGreaterThan(0), 2000);
		const [message] = watchdogMessages(harness);
		expect(JSON.stringify((message as any).content)).toContain("t1: unfinished");
		harness.cleanup();
	});

	it("fires for a depth-1 child session too", async () => {
		const harness = await createHarness({ settings: WATCHDOG_SETTINGS, rlmDepth: 1 });
		seedBoard(harness.tempDir, [{ id: "t1", title: "child work", status: "ongoing", assignees: ["sub-1"] }]);
		harness.setResponses([fauxAssistantMessage("Stopping early."), fauxAssistantMessage("Continuing.")]);
		await harness.session.prompt("go");
		await waitFor(() => expect(watchdogMessages(harness).length).toBeGreaterThan(0), 2000);
		harness.cleanup();
	});

	it("does not fire when the board is all done", async () => {
		const harness = await createHarness({ settings: WATCHDOG_SETTINGS });
		seedBoard(harness.tempDir, [{ id: "t1", title: "finished", status: "done" }]);
		harness.setResponses([fauxAssistantMessage("Done.")]);
		await harness.session.prompt("go");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(watchdogMessages(harness)).toHaveLength(0);
		harness.cleanup();
	});

	it("is disabled by the todoWatchdogEnabled setting", async () => {
		const harness = await createHarness({ settings: { ...WATCHDOG_SETTINGS, todoWatchdogEnabled: false } });
		seedBoard(harness.tempDir, [{ id: "t1", title: "unfinished", status: "ongoing" }]);
		harness.setResponses([fauxAssistantMessage("Stopping early.")]);
		await harness.session.prompt("go");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(watchdogMessages(harness)).toHaveLength(0);
		harness.cleanup();
	});

	it("user input arriving first cancels the pending watchdog", async () => {
		const harness = await createHarness({
			settings: { todoWatchdogEnabled: true, todoWatchdogDelaySeconds: 0.5 },
		});
		seedBoard(harness.tempDir, [{ id: "t1", title: "unfinished", status: "ongoing" }]);
		harness.setResponses([fauxAssistantMessage("First stop."), fauxAssistantMessage("Second run.")]);
		await harness.session.prompt("go");
		// User input lands well before the 500ms delay elapses.
		await harness.session.prompt("user takes over");
		harness.cleanup(); // disposes before the rescheduled timer can fire
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(watchdogMessages(harness)).toHaveLength(0);
	});
});

describe("rlm terminal auto-report autopsy", () => {
	it("ships the real stop reason and token count at death", async () => {
		const harness = await createHarness({ rlmDepth: 1 });
		harness.setResponses([fauxAssistantMessage("Did some work.")]);
		await harness.session.prompt("go");
		const report = harness.session._buildRlmTerminalAutoReport("completed");
		expect(report).toContain("outcome: completed");
		expect(report).toContain("stop: stop");
		expect(report).toMatch(/tokens: \d+ output over 1 assistant turn\(s\)/);
		expect(report).toContain("events: 0 compaction(s), 0 kernel restore(s)");
		harness.cleanup();
	});

	it("reports a silent death when no assistant message was ever produced", () => {
		// Minimal `this`: exercises the autopsy path without a full session.
		const report = (
			AgentSession.prototype._buildRlmTerminalAutoReport as (this: unknown, outcome: string) => string
		).call(
			{
				messages: [],
				sessionManager: { getBranch: () => [] },
				_cwd: process.cwd(),
				sessionName: undefined,
				sessionId: "test-session",
			},
			"completed",
		);
		expect(report).toContain("stop: none (no assistant message ever produced)");
		expect(report).toContain("tokens: 0 output over 0 assistant turn(s)");
	});
});

describe("rlm child compaction configuration", () => {
	it("gives inline child sessions the same auto-compaction config as their parent", async () => {
		const harness = await createHarness();
		const buildOptions = Reflect.get(AgentSession.prototype, "_createRlmSubagentRuntimeOptions") as (
			this: AgentSession,
			options: Record<string, unknown>,
		) => Record<string, unknown>;
		const createInline = Reflect.get(AgentSession.prototype, "_createInlineRlmSubagentRuntime") as (
			this: AgentSession,
			options: Record<string, unknown>,
		) => { session: AgentSession };
		const options = buildOptions.call(harness.session, {
			id: "child-1",
			prompt: "work on the board",
			sessionName: "test-child",
			sessionDir: join(harness.tempDir, "child-sessions"),
			model: harness.getModel(),
		});
		const child = createInline.call(harness.session, options).session;
		try {
			// Inline children share the parent's settings manager, so compaction
			// defaults (enabled + thresholds) apply identically at depth 1.
			expect(child.settingsManager).toBe(harness.session.settingsManager);
			const compaction = child.settingsManager.getCompactionSettings();
			expect(compaction.enabled).toBe(true);
			expect(compaction.reserveTokens).toBeGreaterThan(0);
			expect(compaction.compactAtTokens).toBeGreaterThan(0);
			expect(child.settingsManager.getCompactionAgentCallable()).toBe(true);
		} finally {
			await child.disposeAsync();
			harness.cleanup();
		}
	});

	it("keeps auto-compaction on for daemon-style sessions built from fresh services", async () => {
		// Daemon/runtime-hosted children build SettingsManager.create(cwd, agentDir).
		const settings = SettingsManager.create(temps.create(), join(getAgentDir()));
		expect(settings.getCompactionSettings().enabled).toBe(true);
		expect(settings.getCompactionSettings().compactAtTokens).toBeGreaterThan(0);
	});
});
