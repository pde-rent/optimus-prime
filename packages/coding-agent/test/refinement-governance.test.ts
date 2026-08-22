import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ConsolidateHarnessMemoriesOptions,
	consolidateHarnessMemories,
} from "../src/core/refinement/consolidation.js";
import {
	DEFAULT_MEMORY_BUDGET,
	getHarnessStatePath,
	HARNESS_HOST_REQUEST_TYPES,
	type HarnessBridgeContext,
	type HarnessEntry,
	type HarnessState,
	handleHarnessHostRequest,
	loadHarnessState,
	memoryBudgetCap,
	saveHarnessState,
} from "../src/core/refinement/index.js";
import type { RefinementProposal } from "../src/core/refinement/refinement.js";
import { cleanupTempDirs, makeTempDir } from "./test-helpers.js";

afterEach(() => {
	cleanupTempDirs();
});

let counter = 0;

function memoryEntry(
	overrides: Partial<HarnessEntry> & { id: string; title?: string; content?: string },
): HarnessEntry {
	counter += 1;
	const stamp = new Date(Date.now() + counter).toISOString();
	return {
		kind: "memory",
		title: overrides.id,
		content: "",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: stamp,
		updated_at: stamp,
		version: 1,
		hit_count: 0,
		last_used_at: "",
		...overrides,
	};
}

function stateWith(entries: HarnessEntry[]): HarnessState {
	const state: HarnessState = {
		schema: 2,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	for (const entry of entries) {
		state.entries[entry.kind][entry.id] = entry;
	}
	return state;
}

function makeContext(): HarnessBridgeContext {
	const root = makeTempDir();
	mkdirSync(join(root, "global"), { recursive: true });
	mkdirSync(join(root, "local"), { recursive: true });
	return { globalDir: join(root, "global"), localDir: join(root, "local") };
}

describe("schema back-compat", () => {
	it("defaults usage fields when loading a version-1 store and migrates on save", () => {
		const dir = makeTempDir();
		const oldState = {
			schema: 1,
			entries: {
				prompt: {},
				skill: {},
				subagent: {},
				memory: {
					legacy: {
						id: "legacy",
						kind: "memory",
						title: "Legacy memory",
						content: "Written before usage tracking existed.",
						path: "general",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
						version: 3,
					},
				},
			},
			refinements: [],
		};
		const path = getHarnessStatePath(dir);
		writeFileSync(path, JSON.stringify(oldState), "utf8");

		const loaded = loadHarnessState(dir, "local");
		expect(loaded.schema).toBe(2);
		const legacy = loaded.entries.memory.legacy;
		expect(legacy.hit_count).toBe(0);
		expect(legacy.last_used_at).toBe("");
		expect(legacy.version).toBe(3);

		saveHarnessState(dir, loaded);
		const roundTripped = JSON.parse(readFileSync(path, "utf8")) as HarnessState;
		expect(roundTripped.schema).toBe(2);
		expect(roundTripped.entries.memory.legacy.hit_count).toBe(0);
	});
});

describe("usage tracking", () => {
	it("increments hit_count and stamps last_used_at for entries returned by search", () => {
		const ctx = makeContext();
		saveHarnessState(
			ctx.localDir!,
			stateWith([
				memoryEntry({
					id: "keeper_marks",
					title: "Keeper mark pushing",
					content: "Push external marks every five seconds.",
				}),
				memoryEntry({ id: "unrelated", title: "Unrelated fact", content: "The office plant is a ficus." }),
			]),
		);

		const response = handleHarnessHostRequest("harness.search_memory", { query: "keeper marks push" }, ctx);
		const hits = response.results as { id: string }[];
		expect(hits.map((hit) => hit.id)).toContain("keeper_marks");

		const stored = loadHarnessState(ctx.localDir!, "local");
		expect(stored.entries.memory.keeper_marks.hit_count).toBe(1);
		expect(stored.entries.memory.keeper_marks.last_used_at).not.toBe("");
		expect(stored.entries.memory.unrelated.hit_count).toBe(0);
		expect(stored.entries.memory.unrelated.last_used_at).toBe("");

		const overview = handleHarnessHostRequest("harness.overview", {}, ctx);
		const summaries = (overview.entries as Record<string, Record<string, unknown>[]>).memory;
		expect(summaries.find((summary) => summary.id === "keeper_marks")?.last_used_at).not.toBe("");
	});

	it("writes nothing when the search misses", () => {
		const ctx = makeContext();
		saveHarnessState(ctx.localDir!, stateWith([memoryEntry({ id: "solo", content: "Only entry in the store." })]));
		handleHarnessHostRequest("harness.search_memory", { query: "zzzqqqxxx nothing matches this" }, ctx);
		const stored = loadHarnessState(ctx.localDir!, "local");
		expect(stored.entries.memory.solo.hit_count).toBe(0);
	});
});

describe("consolidateHarnessMemories", () => {
	const base: ConsolidateHarnessMemoriesOptions = {};

	function consolidated(entries: HarnessEntry[], options?: ConsolidateHarnessMemoriesOptions) {
		const state = stateWith(entries);
		return { before: state, result: consolidateHarnessMemories(state, options ?? base) };
	}

	it("merges near-duplicates into the older id, unioning content, and never mutates its input", () => {
		const older = memoryEntry({
			id: "deploy_marks",
			title: "Deploy keeper marks",
			content: "Push marks every five seconds.",
			created_at: "2026-01-01T00:00:00.000Z",
		});
		const newer = memoryEntry({
			id: "deploy_marks_2",
			title: "Deploy keeper marks guide",
			content: "Push marks every five seconds. Heartbeat covers feed outages.",
			created_at: "2026-02-01T00:00:00.000Z",
		});
		const { before, result } = consolidated([newer, older]);

		expect(result.merged).toEqual([{ keptId: "deploy_marks", mergedIds: ["deploy_marks_2"] }]);
		expect(result.deleted).toEqual([]);
		const kept = result.state.entries.memory.deploy_marks;
		expect(kept).toBeDefined();
		expect(result.state.entries.memory.deploy_marks_2).toBeUndefined();
		expect(kept.content).toContain("Heartbeat covers feed outages.");
		expect(kept.version).toBeGreaterThan(1);
		// Input state untouched.
		expect(before.entries.memory.deploy_marks_2).toBeDefined();
	});

	it("keeps both copies when contents are dissimilar despite similar titles", () => {
		const left = memoryEntry({
			id: "rollout_a",
			title: "Rollout checklist",
			content: "Btr dex rollout needs the keeper connected to nxr feeds first.",
		});
		const right = memoryEntry({
			id: "rollout_b",
			title: "Rollout checklist revision",
			content: "Completely different topic about gardening orchids indoors.",
		});
		const { result } = consolidated([left, right]);
		expect(result.merged).toEqual([]);
		expect(Object.keys(result.state.entries.memory)).toHaveLength(2);
	});

	it("deletes exact-content duplicates regardless of title", () => {
		const content = "Identical body stored under two different ids.";
		const { result } = consolidated([
			memoryEntry({ id: "dup_newer", title: "Second copy", content, created_at: "2026-03-01T00:00:00.000Z" }),
			memoryEntry({ id: "dup_older", title: "First copy variant", content, created_at: "2026-01-01T00:00:00.000Z" }),
		]);
		expect(result.deleted).toEqual([{ keptId: "dup_older", deletedIds: ["dup_newer"] }]);
		expect(result.state.entries.memory.dup_older).toBeDefined();
		expect(result.state.entries.memory.dup_newer).toBeUndefined();
	});

	it("never touches skills, prompts, or subagents", () => {
		const state = stateWith([]);
		const skill = {
			...memoryEntry({ id: "twin_a", title: "Same title", content: "Same content." }),
			kind: "skill" as const,
			reference: { type: "js", binding: "x", callable: "y" },
			arguments: {},
		};
		const twin = {
			...memoryEntry({ id: "twin_b", title: "Same title", content: "Same content." }),
			kind: "skill" as const,
			reference: { type: "js", binding: "x", callable: "y" },
			arguments: {},
		};
		state.entries.skill.twin_a = skill;
		state.entries.skill.twin_b = twin;
		const result = consolidateHarnessMemories(state, {});
		expect(result.merged).toEqual([]);
		expect(result.deleted).toEqual([]);
		expect(Object.keys(result.state.entries.skill)).toEqual(["twin_a", "twin_b"]);
	});
});

describe("memory budget enforcement", () => {
	it("caps at 200 local / 500 global by default", () => {
		expect(DEFAULT_MEMORY_BUDGET.local).toBe(200);
		expect(DEFAULT_MEMORY_BUDGET.global).toBe(500);
		expect(memoryBudgetCap(undefined, "local")).toBe(200);
		expect(memoryBudgetCap({ local: 3 }, "local")).toBe(3);
	});

	it("evicts lowest-value memories after an apply that exceeds the cap and logs the evictions", () => {
		const state = stateWith([
			// Used recently: highest value.
			memoryEntry({
				id: "used",
				title: "Used memory",
				content: "Short.",
				hit_count: 2,
				last_used_at: "2026-06-01T00:00:00.000Z",
				created_at: "2026-01-01T00:00:00.000Z",
			}),
			// Never used, stale, and the longest body: lowest value.
			memoryEntry({
				id: "stale_long",
				title: "Stale long memory",
				content: "This body is deliberately the longest of the three so it loses the tiebreak.",
				hit_count: 0,
				last_used_at: "2026-02-01T00:00:00.000Z",
				created_at: "2026-01-01T00:00:00.000Z",
			}),
			memoryEntry({
				id: "fresh_unused",
				title: "Fresh unused memory",
				content: "Never searched but newer.",
				hit_count: 0,
				last_used_at: "2026-05-01T00:00:00.000Z",
				created_at: "2026-01-01T00:00:00.000Z",
			}),
		]);

		const proposal: RefinementProposal = {
			summary: "Add one more memory",
			rationale: "test",
			expectedOutcome: "cap enforced",
			edits: [{ action: "create", kind: "memory", id: "brand_new", title: "Brand new", content: "Newest of all." }],
		};

		const result = handleApplyForTest(state, proposal);
		expect(state.entries.memory.brand_new).toBeDefined();
		// hit_count=0 first, then oldest last_used_at: stale_long loses to fresh_unused;
		// "used" survives on its hits.
		expect(state.entries.memory.stale_long).toBeUndefined();
		expect(state.entries.memory.used).toBeDefined();
		expect(state.entries.memory.fresh_unused).toBeDefined();

		const evictionEvents = state.refinements.filter((event) => event.trigger === "memory budget enforcement");
		expect(evictionEvents).toHaveLength(1);
		expect(evictionEvents[0].changes).toContain("delete memory:stale_long");
		expect(result.appliedEdits[0].applied).toBe(true);
	});
});

/** applyRefinementProposal imported late so the mock-free module graph stays flat. */
import { applyRefinementProposal } from "../src/core/refinement/refinement.js";

function handleApplyForTest(state: HarnessState, proposal: RefinementProposal) {
	return applyRefinementProposal(state, proposal, { id: "test-apply", scope: "local", maxMemories: { local: 3 } });
}

describe("rlm.harness.consolidate_memories", () => {
	it("is part of the host request surface", () => {
		expect(HARNESS_HOST_REQUEST_TYPES).toContain("harness.consolidate_memories");
	});

	it("reports merges on a dry run and persists them otherwise", () => {
		const ctx = makeContext();
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Deploy keeper", content: "Restart keeper before pushing marks." },
			ctx,
		);
		handleHarnessHostRequest(
			"harness.create_memory",
			{ title: "Deploy keeper notes", content: "Restart keeper before pushing marks. Check theta bounds too." },
			ctx,
		);

		const dryRun = handleHarnessHostRequest("harness.consolidate_memories", { dry_run: true }, ctx);
		expect((dryRun.merged as unknown[]).length).toBeGreaterThanOrEqual(1);
		let stored = loadHarnessState(ctx.localDir!, "local");
		expect(Object.keys(stored.entries.memory)).toHaveLength(2);

		const applied = handleHarnessHostRequest("harness.consolidate_memories", {}, ctx);
		expect((applied.merged as unknown[]).length).toBeGreaterThanOrEqual(1);
		stored = loadHarnessState(ctx.localDir!, "local");
		expect(Object.keys(stored.entries.memory)).toHaveLength(1);
		expect(stored.refinements.some((event) => event.trigger === "memory consolidation")).toBe(true);
	});
});
