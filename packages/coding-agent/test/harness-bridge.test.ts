import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import {
	getHarnessStatePath,
	HARNESS_HOST_REQUEST_TYPES,
	type HarnessBridgeContext,
	handleHarnessHostRequest,
	loadHarnessState,
} from "../src/core/refinement/index.js";
import { cleanupTempDirs, makeTempDir } from "./test-helpers.js";

/**
 * Read a cell's result as data.
 *
 * Result values are rendered with `util.inspect`, so they are for reading, not parsing.
 * Cells that need to hand data back to the test stringify it themselves; the outer parse unwraps the quoted string literal.
 */
function jsonResult(result: string | undefined): unknown {
	return JSON.parse(JSON.parse(result ?? '"null"') as string);
}

afterAll(() => {
	cleanupTempDirs();
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

			// Derived from the host request list in both directions, so a new `harness.*`
			// type or a new sandbox method cannot land without its counterpart.
			const surface = await manager.execute(
				`JSON.stringify({
					names: Object.keys(rlm.harness).sort(),
					kinds: [...new Set(Object.keys(rlm.harness).map((name) => typeof rlm.harness[name]))],
					getState: typeof rlm.get_harness_state,
				})`,
			);
			expect(surface.status).toBe("ok");
			const exposed = jsonResult(surface.result) as { names: string[]; kinds: string[]; getState: string };
			// `get_state` is reached as rlm.get_harness_state(), not through rlm.harness.
			const expectedNames = HARNESS_HOST_REQUEST_TYPES.filter((type) => type !== "harness.get_state")
				.map((type) => type.slice("harness.".length))
				.sort();
			expect(exposed.names).toEqual(expectedNames);
			expect(exposed.kinds).toEqual(["function"]);
			expect(exposed.getState).toBe("function");

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

			const searched = await manager.execute(
				`JSON.stringify(await rlm.harness.search_memory({ query: "bunx", top_k: 3 }))`,
			);
			expect(searched.status).toBe("ok");
			const searchPayload = jsonResult(searched.result) as {
				total_matches: number;
				results: { id: string; snippet: string }[];
			};
			expect(searchPayload.total_matches).toBe(1);
			expect(searchPayload.results[0].id).toBe("build_cmd");
			expect(searchPayload.results[0].snippet).toContain("bunx");

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
				{ ...VALID_SKILL, title: "Bad ref", reference: { type: "bash", binding: "x", callable: "run" } },
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

	it("reads memories without touching the store", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_memory", { title: "Auth flow", content: "auth uses jwt" }, ctx);
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Auth policy", content: "auth rotates hourly", global: true },
			ctx,
		);
		const localBefore = readFileSync(getHarnessStatePath(ctx.localDir!));
		const globalBefore = readFileSync(getHarnessStatePath(ctx.globalDir));
		const rebuildsBefore = ctx.rebuilds;

		handleHarnessHostRequest("harness.search_memory", { query: "auth" }, ctx);
		handleHarnessHostRequest("harness.get_memory", { id: "auth_flow" }, ctx);

		expect(readFileSync(getHarnessStatePath(ctx.localDir!)).equals(localBefore)).toBe(true);
		expect(readFileSync(getHarnessStatePath(ctx.globalDir)).equals(globalBefore)).toBe(true);
		expect(ctx.rebuilds).toBe(rebuildsBefore);
	});

	it("requires a non-blank query string", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_memory", { title: "Auth flow", content: "auth uses jwt" }, ctx);
		for (const query of [undefined, "", "   ", 12, null]) {
			expect(() => handleHarnessHostRequest("harness.search_memory", { query }, ctx)).toThrow(
				/requires a non-empty query string/,
			);
		}
	});

	it("clamps top_k instead of throwing, and honours the topK alias", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_memory", { title: "Auth flow", content: "auth uses jwt" }, ctx);
		const topK = (payload: Record<string, unknown>) =>
			(handleHarnessHostRequest("harness.search_memory", { query: "auth", ...payload }, ctx) as any).top_k;

		expect(topK({})).toBe(5);
		expect(topK({ top_k: 0 })).toBe(1);
		expect(topK({ top_k: -1 })).toBe(1);
		expect(topK({ top_k: 50 })).toBe(10);
		expect(topK({ top_k: 2.5 })).toBe(3);
		expect(topK({ top_k: "3" })).toBe(3);
		expect(topK({ topK: 4 })).toBe(4);
		// Both keys present: the wire name wins.
		expect(topK({ top_k: 2, topK: 9 })).toBe(2);
		expect(() => topK({ top_k: "abc" })).toThrow(/must be a number/);
	});

	it("scopes search by scope or by the global flag", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_memory", { title: "Auth local", content: "auth is local" }, ctx);
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Auth global", content: "auth is global", global: true },
			ctx,
		);

		expect(() => handleHarnessHostRequest("harness.search_memory", { query: "auth", scope: "session" }, ctx)).toThrow(
			/scope must be "local" or "global"/,
		);

		const globalOnly = handleHarnessHostRequest("harness.search_memory", { query: "auth", global: true }, ctx) as any;
		expect(globalOnly.scope).toBe("global");
		expect(globalOnly.results.map((hit: { id: string }) => hit.id)).toEqual(["auth_global"]);

		const localOnly = handleHarnessHostRequest(
			"harness.search_memory",
			{ query: "auth", scope: "local" },
			ctx,
		) as any;
		expect(localOnly.results.map((hit: { id: string }) => hit.id)).toEqual(["auth_local"]);

		// An explicit scope wins over a disagreeing global flag.
		const conflicting = handleHarnessHostRequest(
			"harness.search_memory",
			{ query: "auth", scope: "local", global: true },
			ctx,
		) as any;
		expect(conflicting.results.map((hit: { id: string }) => hit.id)).toEqual(["auth_local"]);

		const both = handleHarnessHostRequest("harness.search_memory", { query: "auth" }, ctx) as any;
		expect(both.scope).toBe("all");
		expect(both.total_matches).toBe(2);
		expect(both.query_terms).toEqual(["auth"]);
	});

	it("keeps colliding local and global ids apart through the merged key", () => {
		const ctx = makeContext();
		const payload = { title: "Build cmd", content: "Use bun, never npm." };
		handleHarnessHostRequest("harness.create_memory", payload, ctx);
		handleHarnessHostRequest("harness.create_memory", { ...payload, global: true }, ctx);

		// Default responses omit `key`: it is `scope:id`, so `scope` already
		// disambiguates a collision and the model fetches with `get_memory({ id, scope })`.
		const found = handleHarnessHostRequest("harness.search_memory", { query: "bun" }, ctx) as any;
		expect(found.results).toHaveLength(2);
		expect(found.results.every((hit: { id: string }) => hit.id === "build_cmd")).toBe(true);
		expect(found.results.map((hit: { scope: string }) => hit.scope).sort()).toEqual(["global", "local"]);
		expect(found.results.every((hit: { key?: string }) => hit.key === undefined)).toBe(true);
		// Both are reachable and distinct despite sharing an id.
		const local = handleHarnessHostRequest("harness.get_memory", { id: "build_cmd", scope: "local" }, ctx) as any;
		const global = handleHarnessHostRequest("harness.get_memory", { id: "build_cmd", scope: "global" }, ctx) as any;
		expect(local.scope).toBe("local");
		expect(global.scope).toBe("global");

		const verbose = handleHarnessHostRequest("harness.search_memory", { query: "bun", verbose: true }, ctx) as any;
		const keys = verbose.results.map((hit: { key: string }) => hit.key).sort();
		expect(keys).toEqual(["build_cmd", "local:build_cmd"]);
		expect(new Set(keys).size).toBe(2);
	});

	it("omits diagnostic envelope fields unless verbose is requested", () => {
		const ctx = makeContext();
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Auth flow", content: "auth uses jwt with a fifteen minute expiry" },
			ctx,
		);

		const lean = handleHarnessHostRequest("harness.search_memory", { query: "auth" }, ctx) as any;
		expect(Object.keys(lean.results[0]).sort()).toEqual(["id", "path", "scope", "score", "snippet", "title"]);

		const verbose = handleHarnessHostRequest("harness.search_memory", { query: "auth", verbose: true }, ctx) as any;
		const keys = Object.keys(verbose.results[0]);
		for (const field of ["key", "version", "updated_at", "coverage", "matched_terms", "content_chars"]) {
			expect(keys).toContain(field);
		}
		// The envelope was ~50% of the payload; the lean shape must stay strictly smaller.
		expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(verbose).length);
	});

	it("returns whole memories through get_memory", () => {
		const ctx = makeContext();
		const content = "auth uses jwt with a 15 minute expiry and refresh on the hour";
		handleHarnessHostRequest("harness.create_memory", { title: "Auth flow", content }, ctx);

		const got = handleHarnessHostRequest("harness.get_memory", { id: "auth_flow" }, ctx) as any;
		expect(got.id).toBe("auth_flow");
		expect(got.scope).toBe("local");
		expect(got.content).toBe(content);
		expect(got.content_chars).toBe(content.length);
		expect(got.truncated).toBe(false);
		expect(got.title).toBe("Auth flow");
		expect(got.metadata).toEqual({});

		// The display-only merged prefix resolves the same entry.
		expect((handleHarnessHostRequest("harness.get_memory", { id: "local:auth_flow" }, ctx) as any).content).toBe(
			content,
		);

		expect(() => handleHarnessHostRequest("harness.get_memory", { id: "nope_at_all" }, ctx)).toThrow(/nope_at_all/);
		expect(() => handleHarnessHostRequest("harness.get_memory", {}, ctx)).toThrow(/requires id/);
	});

	it("prefers the local entry for an ambiguous id and caps oversized content", () => {
		const ctx = makeContext();
		handleHarnessHostRequest("harness.create_memory", { title: "Build cmd", content: "local body" }, ctx);
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Build cmd", content: "global body", global: true },
			ctx,
		);
		expect((handleHarnessHostRequest("harness.get_memory", { id: "build_cmd" }, ctx) as any).scope).toBe("local");
		expect(
			(handleHarnessHostRequest("harness.get_memory", { id: "build_cmd", global: true }, ctx) as any).scope,
		).toBe("global");

		const huge = "x".repeat(25_000);
		handleHarnessHostRequest("harness.create_memory", { title: "Huge note", content: huge }, ctx);
		const got = handleHarnessHostRequest("harness.get_memory", { id: "huge_note" }, ctx) as any;
		expect(got.content).toHaveLength(20_000);
		expect(got.content_chars).toBe(25_000);
		expect(got.truncated).toBe(true);
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
