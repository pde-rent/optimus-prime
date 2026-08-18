import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledSkillsDir } from "../src/config.js";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import { getJsSkillRuntimeInfo, loadSkillsFromDir } from "../src/core/skills.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-skill-preload-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The env the host hands the REPL child, built the same way agent-session does. */
function replSkillsEnv(): string {
	const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });
	const specs = getJsSkillRuntimeInfo(skills).map((skill) => ({
		name: skill.name,
		global: skill.importName,
		entry: skill.entryPath,
	}));
	expect(specs.length).toBeGreaterThan(0);
	return JSON.stringify(specs);
}

/**
 * Read a cell's result as data.
 *
 * Result values are rendered with `util.inspect`, so they are for reading, not parsing.
 * Cells that need to hand data back to the test stringify it themselves; the outer parse unwraps the quoted string literal.
 */
function jsonResult(result: string | undefined): unknown {
	return JSON.parse(JSON.parse(result ?? '"null"') as string);
}

describe("bundled skills preload into the REPL", () => {
	it("binds every JS skill and routes its calls through the host bridge", async () => {
		const cwd = makeTempDir();
		const compactStatus = { tokens: 42, context_window: 1000, percent: 4.2, scheduled: false };
		const manager = new BunReplManager({
			cwd,
			env: { PRIME_AGENT_REPL_SKILLS: replSkillsEnv() },
			hostHandlers: {
				"compact.status": async () => compactStatus,
				"goal.get": async () => ({ goal: null, remaining_tokens: 100 }),
			},
		});

		try {
			await manager.start();

			const bindings = await manager.execute(
				`JSON.stringify([typeof edit, typeof compact.status, typeof goal.get, typeof agent_message.send, typeof websearch.run])`,
			);
			expect(bindings.status).toBe("ok");
			expect(jsonResult(bindings.result)).toEqual(["function", "function", "function", "function", "function"]);

			const status = await manager.execute(`JSON.stringify(await compact.status())`);
			expect(status.status).toBe("ok");
			expect(jsonResult(status.result)).toEqual(compactStatus);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("surfaces an edit skill diff on the cell result", async () => {
		const cwd = makeTempDir();
		const target = join(cwd, "target.txt");
		writeFileSync(target, "one\ntwo\nthree\n");

		const manager = new BunReplManager({ cwd, env: { PRIME_AGENT_REPL_SKILLS: replSkillsEnv() } });
		try {
			await manager.start();
			const result = await manager.execute(`await edit(${JSON.stringify(target)}, "two", "TWO")`);

			expect(result.status).toBe("ok");
			expect(result.diffs).toEqual([{ path: target, oldStr: "two", newStr: "TWO", startLine: 2 }]);
			expect(readFileSync(target, "utf-8")).toBe("one\nTWO\nthree\n");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("reports a sent agent message on the cell that issued it", async () => {
		const manager = new BunReplManager({
			cwd: makeTempDir(),
			env: { PRIME_AGENT_REPL_SKILLS: replSkillsEnv() },
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					id: "agentmsg_1",
					message: String(payload.message),
					deliveryStatus: "delivered",
					target: { activeSessionId: "a", sessionId: "s", sessionName: "kid" },
				}),
			},
		});

		try {
			await manager.start();
			const result = await manager.execute(
				`await agent_message.send("hi", { receiver_role: "child", receiver_name: "kid" })`,
			);

			expect(result.status).toBe("ok");
			expect(result.sentAgentMessages).toEqual([
				{
					id: "agentmsg_1",
					message: "hi",
					deliveryStatus: "delivered",
					receiverRole: "child",
					target: { activeSessionId: "a", sessionId: "s", sessionName: "kid" },
				},
			]);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("attributes a message sent without await to the cell that issued it", async () => {
		const late: Array<{ correlationId: string; id: string }> = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const manager = new BunReplManager({
			cwd: makeTempDir(),
			env: { PRIME_AGENT_REPL_SKILLS: replSkillsEnv() },
			hostHandlers: {
				"agent_message.send": async (payload) => {
					// Resolve only after the cell has already returned, so the receipt is late.
					await gate;
					return {
						id: "agentmsg_late",
						message: String(payload.message),
						deliveryStatus: "delivered",
						target: { activeSessionId: "a", sessionId: "s", sessionName: "kid" },
					};
				},
			},
			onLateSentAgentMessage: (correlationId, message) => late.push({ correlationId, id: message.id }),
		});

		try {
			await manager.start();
			const result = await manager.execute(
				`void agent_message.send("later", { receiver_role: "parent" }); "cell done"`,
				{ correlationId: "repl_call_1" },
			);

			expect(result.status).toBe("ok");
			expect(result.sentAgentMessages).toBeUndefined();

			release();
			for (let i = 0; i < 100 && late.length === 0; i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			expect(late).toEqual([{ correlationId: "repl_call_1", id: "agentmsg_late" }]);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});

describe("sandbox rlm bridge", () => {
	// Regression: the prompt documents `await rlm('sub-task')`, but the sandbox bound a
	// plain object, so the bare call threw "rlm is not a function".
	it("exposes rlm as a callable that also carries its helpers", async () => {
		const prompts: string[] = [];
		const manager = new BunReplManager({
			cwd: makeTempDir(),
			hostHandlers: {
				"rlm.run": async (payload) => {
					prompts.push(String(payload.prompt));
					return { rlm_child_id: "child-1", name: String((payload.kwargs as { name?: string })?.name ?? "auto") };
				},
			},
		});

		try {
			await manager.start();

			const shape = await manager.execute(
				`JSON.stringify([typeof rlm, typeof rlm.run, typeof rlm.list_subagents, typeof rlm.harness.create_memory])`,
			);
			expect(jsonResult(shape.result)).toEqual(["function", "function", "function", "function"]);

			const spawned = await manager.execute(`JSON.stringify(await rlm("sub-task", { name: "api-reviewer" }))`);
			expect(spawned.status).toBe("ok");
			expect(jsonResult(spawned.result)).toEqual({ rlm_child_id: "child-1", name: "api-reviewer" });
			expect(prompts).toEqual(["sub-task"]);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	// Regression: `rlm.delete_subagent` used to post `{ id }` while the host handler
	// requires `{ target }`, so every delete failed with a validation error.
	it("sends rlm.delete_subagent with the target the host handler expects", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const manager = new BunReplManager({
			cwd: makeTempDir(),
			hostHandlers: {
				"rlm.delete_subagent": async (payload) => {
					payloads.push(payload);
					if (typeof payload.target !== "string" || !payload.target.trim()) {
						throw new Error("rlm.delete_subagent target must be a non-empty string");
					}
					return { subagent: { name: payload.target } };
				},
			},
		});

		try {
			await manager.start();
			const result = await manager.execute(`await rlm.delete_subagent("api-reviewer")`);

			expect(result.status).toBe("ok");
			// Host requests also carry the source of the cell that issued them.
			expect(payloads).toEqual([
				{ target: "api-reviewer", cellSourceCode: `await rlm.delete_subagent("api-reviewer")` },
			]);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});
