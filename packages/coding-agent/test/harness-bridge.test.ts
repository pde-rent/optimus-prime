import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import {
	getHarnessStatePath,
	HARNESS_HOST_REQUEST_TYPES,
	type HarnessBridgeContext,
	handleHarnessHostRequest,
	loadHarnessState,
} from "../src/core/refinement/index.js";

/**
 * Read a cell's result as data.
 *
 * Result values are rendered with `util.inspect` (the JS analogue of the old kernel's
 * Python `repr`), so they are for reading, not parsing. Cells that need to hand data back
 * to the test stringify it themselves; the outer parse unwraps the quoted string literal.
 */
function jsonResult(result: string | undefined): unknown {
	return JSON.parse(JSON.parse(result ?? '"null"') as string);
}

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-harness-bridge-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Real host handlers over a temp store, wired the way agent-session wires them. */
function makeContext(): HarnessBridgeContext & { rebuilds: number } {
	const root = makeTempDir();
	const ctx = {
		globalDir: join(root, "global"),
		localDir: join(root, "local"),
		rebuilds: 0,
		onStateChanged: () => {
			ctx.rebuilds++;
		},
	};
	return ctx;
}

function hostHandlers(
	ctx: HarnessBridgeContext,
): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
	const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
	for (const type of HARNESS_HOST_REQUEST_TYPES) {
		handlers[type] = async (payload) => handleHarnessHostRequest(type, payload, ctx);
	}
	return handlers;
}

const VALID_SKILL = {
	title: "Deploy checker",
	content: "Check the deploy status before releasing.",
	reference: { type: "js", binding: "deploy_checker", callable: "run", call_pattern: "await deploy_checker.run(...)" },
	arguments: { env: { type: "string", required: true } },
};

describe("rlm.harness sandbox surface", () => {
	it("exposes every documented method and round-trips through the real host handlers", async () => {
		const ctx = makeContext();
		const manager = new BunReplManager({ cwd: makeTempDir(), hostHandlers: hostHandlers(ctx) });
		try {
			await manager.start();

			const methods = await manager.execute(
				`JSON.stringify([
					"create_memory","update_memory","delete_memory",
					"create_skill","update_skill","delete_skill",
					"create_subagent","update_subagent","delete_subagent",
					"create_prompt_note","update_prompt_note","delete_prompt_note",
					"record_refinement","overview",
				].map((name) => typeof rlm.harness[name]).concat(typeof rlm.get_harness_state, typeof rlm.delete_subagent))`,
			);
			expect(methods.status).toBe("ok");
			expect(jsonResult(methods.result)).toEqual(new Array(16).fill("function"));

			const created = await manager.execute(
				`JSON.stringify(await rlm.harness.create_memory({ title: "Build cmd", content: "Use bun, never npm." }))`,
			);
			expect(created.status).toBe("ok");
			const createdPayload = jsonResult(created.result) as Record<string, unknown>;
			expect(createdPayload.id).toBe("build_cmd");
			expect(createdPayload.scope).toBe("local");

			const readBack = await manager.execute(
				`JSON.stringify((await rlm.get_harness_state()).entries.memory.build_cmd.content)`,
			);
			expect(jsonResult(readBack.result)).toBe("Use bun, never npm.");

			const updated = await manager.execute(
				`JSON.stringify(await rlm.harness.update_memory({ id: "build_cmd", content: "Use bun/bunx only." }))`,
			);
			const updatedPayload = jsonResult(updated.result) as { entry: { version: number; title: string } };
			expect(updatedPayload.entry.version).toBe(2);
			// Unspecified fields are preserved on a partial update.
			expect(updatedPayload.entry.title).toBe("Build cmd");

			const overview = await manager.execute(`JSON.stringify(await rlm.harness.overview())`);
			expect((jsonResult(overview.result) as { counts: { memory: number } }).counts.memory).toBe(1);

			const deleted = await manager.execute(`JSON.stringify(await rlm.harness.delete_memory({ id: "build_cmd" }))`);
			expect((jsonResult(deleted.result) as { action: string }).action).toBe("delete");

			const after = await manager.execute(
				`JSON.stringify(Object.keys((await rlm.get_harness_state()).entries.memory))`,
			);
			expect(jsonResult(after.result)).toEqual([]);

			// Errors surface as sandbox exceptions, not silent nulls.
			const invalid = await manager.execute(`await rlm.harness.create_skill({ title: "x", content: "y" })`);
			expect(invalid.status).toBe("error");
			expect(invalid.error?.evalue).toContain("requires arguments");

			expect(ctx.rebuilds).toBeGreaterThan(0);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});

describe("harness host handlers", () => {
	it("writes the local store by default and the global store with global: true", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_memory", { title: "Local fact", content: "session only" }, ctx);
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Global fact", content: "cross session", global: true },
			ctx,
		);

		const local = loadHarnessState(ctx.localDir!, "local");
		const global = loadHarnessState(ctx.globalDir, "global");
		expect(Object.keys(local.entries.memory)).toEqual(["local_fact"]);
		expect(Object.keys(global.entries.memory)).toEqual(["global_fact"]);
		expect(existsSync(getHarnessStatePath(ctx.localDir!))).toBe(true);

		// The merged view the model reads carries both, tagged by scope.
		const merged = handleHarnessHostRequest("harness.get_state", {}, ctx) as any;
		expect(merged.entries.memory.local_fact.scope).toBe("local");
		expect(merged.entries.memory.global_fact.scope).toBe("global");
	});

	it("keeps CRUD calls out of the refinement log and records explicit refinements", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_prompt_note", { title: "Terse", content: "Be terse." }, ctx);
		expect(loadHarnessState(ctx.localDir!, "local").refinements).toEqual([]);

		handleHarnessHostRequest(
			"harness.record_refinement",
			{ trigger: "repeated failure", changes: ["create prompt:terse"], outcome: "fewer retries" },
			ctx,
		);
		const state = loadHarnessState(ctx.localDir!, "local");
		expect(state.refinements).toHaveLength(1);
		expect(state.refinements[0].trigger).toBe("repeated failure");
	});

	it("accepts a valid skill entry and rejects malformed ones", () => {
		const ctx = makeContext();
		const created = handleHarnessHostRequest("harness.create_skill", { ...VALID_SKILL }, ctx);
		expect((created as any).id).toBe("deploy_checker");

		expect(() =>
			handleHarnessHostRequest(
				"harness.create_skill",
				{ ...VALID_SKILL, title: "No args", arguments: undefined },
				ctx,
			),
		).toThrow(/requires arguments/);
		expect(() =>
			handleHarnessHostRequest(
				"harness.create_skill",
				{ ...VALID_SKILL, title: "No ref", reference: undefined },
				ctx,
			),
		).toThrow(/requires js reference/);
		expect(() =>
			handleHarnessHostRequest(
				"harness.create_skill",
				{ ...VALID_SKILL, title: "Bad ref", reference: { type: "python", binding: "x", callable: "run" } },
				ctx,
			),
		).toThrow(/reference.type must be js/);
		expect(() =>
			handleHarnessHostRequest(
				"harness.create_skill",
				{ ...VALID_SKILL, title: "No binding", reference: { type: "js", callable: "run" } },
				ctx,
			),
		).toThrow(/requires js binding/);
		expect(() => handleHarnessHostRequest("harness.update_memory", { content: "x" }, ctx)).toThrow(/requires id/);
		expect(() => handleHarnessHostRequest("harness.delete_memory", { id: "nope" }, ctx)).toThrow(/entry not found/);
		expect(() =>
			handleHarnessHostRequest("harness.create_memory", { title: "t", content: "c", global: "yes" }, ctx),
		).toThrow(/global must be a boolean/);
	});

	it("refuses local writes when the session has no local store", () => {
		const ctx = { ...makeContext(), localDir: undefined };
		expect(() => handleHarnessHostRequest("harness.create_memory", { title: "t", content: "c" }, ctx)).toThrow(
			/no local harness store/,
		);
		expect(() =>
			handleHarnessHostRequest("harness.create_memory", { title: "t", content: "c", global: true }, ctx),
		).not.toThrow();
	});
});
