import { describe, expect, it } from "bun:test";
import { searchHarnessMemories } from "../../../src/core/refinement/memory-search.js";
import type { HarnessEntry } from "../../../src/core/refinement/refinement.js";

function makeEntry(overrides: Partial<HarnessEntry> & { id: string }): HarnessEntry {
	return {
		kind: "memory",
		title: overrides.id,
		content: "",
		path: "general",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: "2025-01-01T00:00:00.000Z",
		updated_at: "2025-01-01T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";

describe("searchHarnessMemories", () => {
	it("returns an empty response for an empty query", () => {
		const memories: Record<string, HarnessEntry> = {
			auth: makeEntry({ id: "auth", title: "Auth flow", content: "JWT tokens with 15min expiry" }),
		};
		expect(searchHarnessMemories(memories, { query: "", topK: 5 })).toEqual({
			suppressedByGate: 0,
			duplicatesCollapsed: 0,
			totalMatchesBeforeCollapse: 0,
			queryTerms: [],
			totalMatches: 0,
			results: [],
		});
		expect(searchHarnessMemories(memories, { query: "   ", topK: 5 })).toEqual({
			suppressedByGate: 0,
			duplicatesCollapsed: 0,
			totalMatchesBeforeCollapse: 0,
			queryTerms: [],
			totalMatches: 0,
			results: [],
		});
	});

	it("returns an empty response for an empty memory store", () => {
		const response = searchHarnessMemories({}, { query: "auth", topK: 5 });
		expect(response.totalMatches).toBe(0);
		expect(response.results).toEqual([]);
		expect(response.queryTerms).toEqual(["auth"]);
	});

	it("ranks title matches above content matches via field weights", () => {
		const memories: Record<string, HarnessEntry> = {
			content_match: makeEntry({
				id: "content_match",
				title: "Something else",
				content: "This memory mentions auth in the body text",
			}),
			title_match: makeEntry({
				id: "title_match",
				title: "Auth flow",
				content: "Some unrelated content about databases",
			}),
		};
		const { results } = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["title_match", "content_match"]);
	});

	it("ranks path matches above content matches", () => {
		const memories: Record<string, HarnessEntry> = {
			content_match: makeEntry({
				id: "content_match",
				title: "Something",
				path: "database",
				content: "This mentions auth briefly",
			}),
			path_match: makeEntry({
				id: "path_match",
				title: "Something else",
				path: "auth/middleware",
				content: "Database connection pooling",
			}),
		};
		const { results } = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["path_match", "content_match"]);
	});

	it("filters by scope and defaults a missing scope to global", () => {
		const memories: Record<string, HarnessEntry> = {
			local_mem: makeEntry({ id: "local_mem", title: "Auth local", content: "local auth", scope: "local" }),
			global_mem: makeEntry({ id: "global_mem", title: "Auth global", content: "global auth", scope: "global" }),
			legacy_mem: makeEntry({ id: "legacy_mem", title: "Auth legacy", content: "legacy auth" }),
		};
		delete memories.legacy_mem.scope;

		const localOnly = searchHarnessMemories(memories, { query: "auth", topK: 5, scope: "local" });
		expect(localOnly.results.map((result) => result.id)).toEqual(["local_mem"]);

		const globalOnly = searchHarnessMemories(memories, { query: "auth", topK: 5, scope: "global" });
		expect(globalOnly.results.map((result) => result.id).sort()).toEqual(["global_mem", "legacy_mem"]);
		expect(globalOnly.results.every((result) => result.scope === "global")).toBe(true);

		const everything = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(everything.results).toHaveLength(3);
	});

	it("breaks score ties by a fixed key order rather than input order", () => {
		const memories: Record<string, HarnessEntry> = {
			b_entry: makeEntry({ id: "b_entry", title: "Auth", content: "auth", scope: "global" }),
			a_entry: makeEntry({ id: "a_entry", title: "Auth", content: "auth", scope: "global" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["a_entry", "b_entry"]);
	});

	it("is stable under key insertion order and reports non-increasing scores", () => {
		const forward: Record<string, HarnessEntry> = {
			alpha: makeEntry({ id: "alpha", title: "Auth flow", content: "auth tokens" }),
			beta: makeEntry({ id: "beta", title: "Notes", path: "auth/middleware", content: "handlers" }),
			gamma: makeEntry({ id: "gamma", title: "Misc", content: "an auth mention buried in prose" }),
		};
		const reversed: Record<string, HarnessEntry> = {
			gamma: makeEntry({ id: "gamma", title: "Misc", content: "an auth mention buried in prose" }),
			beta: makeEntry({ id: "beta", title: "Notes", path: "auth/middleware", content: "handlers" }),
			alpha: makeEntry({ id: "alpha", title: "Auth flow", content: "auth tokens" }),
		};
		const first = searchHarnessMemories(forward, { query: "auth", topK: 5 });
		const second = searchHarnessMemories(reversed, { query: "auth", topK: 5 });
		expect(second.results).toEqual(first.results);

		for (const result of first.results) {
			expect(typeof result.score).toBe("number");
			expect(result.score).toBeGreaterThan(0);
		}
		for (let index = 1; index < first.results.length; index++) {
			expect(first.results[index].score).toBeLessThanOrEqual(first.results[index - 1].score);
		}
	});

	it("retrieves CJK memories with a CJK query", () => {
		const memories: Record<string, HarnessEntry> = {
			pool: makeEntry({ id: "pool", title: "数据库连接池", content: "连接池最大值是十六" }),
			other: makeEntry({ id: "other", title: "Deploy notes", content: "run the deploy script" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "数据库", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["pool"]);
	});

	it("folds diacritics symmetrically between query and index", () => {
		const accented: Record<string, HarnessEntry> = {
			cafe_mem: makeEntry({ id: "cafe_mem", title: "Café menu", content: "espresso and cortado" }),
			deploy_mem: makeEntry({ id: "deploy_mem", title: "Notes", content: "déployer le service avant midi" }),
		};
		expect(searchHarnessMemories(accented, { query: "cafe", topK: 5 }).results[0]?.id).toBe("cafe_mem");
		expect(searchHarnessMemories(accented, { query: "deployer", topK: 5 }).results[0]?.id).toBe("deploy_mem");

		const plain: Record<string, HarnessEntry> = {
			cafe_mem: makeEntry({ id: "cafe_mem", title: "Cafe menu", content: "espresso and cortado" }),
			other: makeEntry({ id: "other", title: "Notes", content: "unrelated" }),
		};
		expect(searchHarnessMemories(plain, { query: "café", topK: 5 }).results[0]?.id).toBe("cafe_mem");
	});

	it("splits acronym boundaries so HTTPServerError answers to 'http server'", () => {
		const memories: Record<string, HarnessEntry> = {
			http_mem: makeEntry({ id: "http_mem", title: "HTTPServerError", content: "retry once then give up" }),
			other: makeEntry({ id: "other", title: "Database pooling", content: "unrelated prose" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "http server", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["http_mem"]);
		expect(results[0].matchedTerms).toEqual(["http", "server"]);
	});

	it("keeps single-character tokens queryable", () => {
		const memories: Record<string, HarnessEntry> = {
			langs: makeEntry({ id: "langs", title: "Language notes", content: "the C compiler is picky here" }),
			other: makeEntry({ id: "other", title: "Deploy", content: "run kubectl rollout restart" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "C", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["langs"]);
	});

	it("matches simple plurals in both directions", () => {
		const singular: Record<string, HarnessEntry> = {
			cache_mem: makeEntry({ id: "cache_mem", title: "Warm start", content: "the cache is warm after boot" }),
			other: makeEntry({ id: "other", title: "Networking", content: "tcp handshake timing" }),
		};
		expect(searchHarnessMemories(singular, { query: "caches", topK: 5 }).results[0]?.id).toBe("cache_mem");

		const plural: Record<string, HarnessEntry> = {
			cache_mem: makeEntry({ id: "cache_mem", title: "Warm start", content: "multiple caches exist per node" }),
			other: makeEntry({ id: "other", title: "Networking", content: "tcp handshake timing" }),
		};
		expect(searchHarnessMemories(plural, { query: "cache", topK: 5 }).results[0]?.id).toBe("cache_mem");
	});

	it("drops results that only match a low-idf term of a multi-term query", () => {
		const memories: Record<string, HarnessEntry> = {};
		for (let index = 0; index < 4; index++) {
			memories[`mem_${index}`] = makeEntry({
				id: `mem_${index}`,
				title: `Note ${index}`,
				content: "the token expires quickly",
			});
		}
		const { results, totalMatches } = searchHarnessMemories(memories, { query: "photosynthesis token", topK: 5 });
		expect(results).toEqual([]);
		expect(totalMatches).toBe(0);
	});

	it("drops a much weaker hit with the score-ratio gate", () => {
		const memories: Record<string, HarnessEntry> = {
			auth_notes: makeEntry({
				id: "auth_notes",
				title: "Auth flow",
				path: "auth/middleware",
				content: "auth auth auth",
			}),
			long_aside: makeEntry({
				id: "long_aside",
				title: "Misc",
				content: `${FILLER.repeat(40)} auth ${FILLER.repeat(40)}`,
			}),
		};
		for (let index = 0; index < 4; index++) {
			memories[`filler_${index}`] = makeEntry({
				id: `filler_${index}`,
				title: `Filler ${index}`,
				content: "nothing",
			});
		}
		const { results, totalMatches } = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(results.map((result) => result.id)).toEqual(["auth_notes"]);
		expect(totalMatches).toBe(1);
	});

	it("falls back to prefix matching only when nothing matched exactly", () => {
		const withExact: Record<string, HarnessEntry> = {
			prefix_doc: makeEntry({ id: "prefix_doc", title: "Authentication guide", content: "login and session" }),
			exact_doc: makeEntry({ id: "exact_doc", title: "Authent", content: "the authent flag is legacy" }),
		};
		const gated = searchHarnessMemories(withExact, { query: "authent", topK: 5 });
		expect(gated.results.map((result) => result.id)).toEqual(["exact_doc"]);

		const withoutExact: Record<string, HarnessEntry> = {
			prefix_doc: makeEntry({ id: "prefix_doc", title: "Authentication guide", content: "login and session" }),
			other: makeEntry({ id: "other", title: "Deploy guide", content: "run the rollout" }),
		};
		const fallback = searchHarnessMemories(withoutExact, { query: "authent", topK: 5 });
		expect(fallback.results.map((result) => result.id)).toEqual(["prefix_doc"]);
		expect(fallback.results[0].matchedTerms).toEqual(["authentication"]);
	});

	it("returns a query-biased snippet instead of the document head", () => {
		const content = `${FILLER.repeat(6)}the auth token rotates hourly. ${FILLER.repeat(6)}`;
		const memories: Record<string, HarnessEntry> = {
			long_mem: makeEntry({ id: "long_mem", title: "Notes", content }),
		};
		const { results } = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(results).toHaveLength(1);
		expect(results[0].snippet).toContain("auth");
		expect(results[0].snippet.startsWith("...")).toBe(true);
		expect(results[0].truncated).toBe(true);
		expect(results[0].contentChars).toBe(content.length);
		expect(results[0].snippet.length).toBeLessThan(content.length);
	});

	it("returns short content whole and untruncated", () => {
		const memories: Record<string, HarnessEntry> = {
			short_mem: makeEntry({ id: "short_mem", title: "Notes", content: "short auth note" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "auth", topK: 5 });
		expect(results[0].snippet).toBe("short auth note");
		expect(results[0].truncated).toBe(false);
		expect(results[0].contentChars).toBe("short auth note".length);
	});

	it("reports totalMatches beyond the topK slice", () => {
		const memories: Record<string, HarnessEntry> = {};
		for (let index = 0; index < 10; index++) {
			memories[`mem_${index}`] = makeEntry({
				id: `mem_${index}`,
				title: `Auth entry ${index}`,
				content: "auth flow",
			});
		}
		const { results, totalMatches } = searchHarnessMemories(memories, { query: "auth", topK: 3 });
		expect(results).toHaveLength(3);
		expect(totalMatches).toBe(10);
	});

	it("handles entries with empty content and empty path without dividing by zero", () => {
		const memories: Record<string, HarnessEntry> = {
			blank: makeEntry({ id: "blank", title: "Blank", content: "", path: "" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "blank", topK: 5 });
		expect(results).toHaveLength(1);
		expect(Number.isFinite(results[0].score)).toBe(true);
		expect(Number.isFinite(results[0].coverage)).toBe(true);
		expect(results[0].snippet).toBe("");
		expect(results[0].contentChars).toBe(0);
		expect(results[0].truncated).toBe(false);
	});
});

describe("relevance gates", () => {
	it("does not let a high-scoring low-coverage decoy suppress a full-coverage hit", () => {
		const filler = Array.from({ length: 400 }, (_, index) => `background sentence number ${index} about builds`).join(
			" ",
		);
		const memories: Record<string, HarnessEntry> = {
			perfect: makeEntry({
				id: "perfect",
				title: "Credential lifecycle",
				path: "ops/creds",
				content: `${filler} the keeper key rotation is quarterly ${filler}`,
			}),
			// Short, and its only term sits in the weight-3 title field, so it outscores
			// the long entry that actually matched the whole query.
			decoy: makeEntry({ id: "decoy", title: "keeper", path: "keeper", content: "keeper" }),
		};
		const { results } = searchHarnessMemories(memories, { query: "keeper key rotation quarterly", topK: 5 });
		expect(results.map((result) => result.id)).toContain("perfect");
	});

	it("keeps a prose query answerable when most of its words are absent from the corpus", () => {
		const memories: Record<string, HarnessEntry> = {
			keeper: makeEntry({
				id: "keeper",
				title: "Keeper private key must never be logged",
				path: "btr/security",
				content: "KEEPER_PRIVATE_KEY is never printed, echoed or written to a log line.",
			}),
			terse: makeEntry({ id: "terse", title: "User wants short answers", path: "style", content: "Keep it brief." }),
		};
		const { results } = searchHarnessMemories(memories, {
			query: "is it safe to print the keeper key in a log line",
			topK: 5,
		});
		expect(results[0]?.id).toBe("keeper");
	});

	it("reports how many candidates the gates removed", () => {
		const memories: Record<string, HarnessEntry> = {};
		for (let index = 0; index < 4; index++) {
			memories[`mem_${index}`] = makeEntry({
				id: `mem_${index}`,
				title: `Note ${index}`,
				content: "the token expires quickly",
			});
		}
		const response = searchHarnessMemories(memories, { query: "photosynthesis token", topK: 5 });
		expect(response.results).toEqual([]);
		expect(response.suppressedByGate).toBeGreaterThan(0);
	});
});

describe("duplicate collapsing", () => {
	const body =
		"Never run kubectl patch against the sitp workloads; Argo selfHeal reverts the change within sixty seconds.";

	it("returns one hit when the same body is stored under two ids", () => {
		const memories: Record<string, HarnessEntry> = {
			"global:argocd_only": makeEntry({
				id: "argocd_only",
				title: "Config goes through argocd-values",
				content: body,
			}),
			"global:no_kubectl_patch": makeEntry({ id: "no_kubectl_patch", title: "Do not patch sitp", content: body }),
		};
		const response = searchHarnessMemories(memories, { query: "kubectl patch argo selfheal", topK: 5 });

		expect(response.results).toHaveLength(1);
		expect(response.duplicatesCollapsed).toBe(1);
		// Whichever copy ranks higher wins; the other stays addressable through the
		// winner so it can still be merged or deleted.
		const covered = [`global:${response.results[0].id}`, ...(response.results[0].duplicateIds ?? [])].sort();
		expect(covered).toEqual(["global:argocd_only", "global:no_kubectl_patch"]);
	});

	it("prefers the local copy of a memory promoted to global, matching get_memory", () => {
		const memories: Record<string, HarnessEntry> = {
			argocd_only: { ...makeEntry({ id: "argocd_only", title: "Config", content: body }), scope: "global" },
			"local:argocd_only": { ...makeEntry({ id: "argocd_only", title: "Config", content: body }), scope: "local" },
		};
		const response = searchHarnessMemories(memories, { query: "kubectl patch argo selfheal", topK: 5 });

		expect(response.results).toHaveLength(1);
		expect(response.results[0].scope).toBe("local");
	});

	it("keeps short bodies that merely look alike", () => {
		const memories: Record<string, HarnessEntry> = {
			a: makeEntry({ id: "a", title: "Deploy note one", content: "deploy on friday" }),
			b: makeEntry({ id: "b", title: "Deploy note two", content: "deploy on friday" }),
		};
		const response = searchHarnessMemories(memories, { query: "deploy friday", topK: 5 });

		expect(response.results).toHaveLength(2);
		expect(response.duplicatesCollapsed).toBe(0);
	});
});

describe("duplicate accounting", () => {
	const body =
		"Never run kubectl patch against the sitp workloads; Argo selfHeal reverts the change within sixty seconds.";

	it("counts distinct matches and keeps a differently titled twin's name", () => {
		const memories: Record<string, HarnessEntry> = {
			"global:argocd_only": makeEntry({
				id: "argocd_only",
				title: "Config goes through argocd-values",
				content: body,
			}),
			"global:no_kubectl_patch": makeEntry({ id: "no_kubectl_patch", title: "Do not patch sitp", content: body }),
		};
		const response = searchHarnessMemories(memories, { query: "kubectl patch argo selfheal", topK: 5 });

		// The model must be told how many memories it can act on, not how many rows the
		// gates passed, or it infers a distinct memory it will never be shown.
		expect(response.totalMatches).toBe(1);
		expect(response.totalMatchesBeforeCollapse).toBe(2);
		expect(response.results[0].duplicateTitles).toHaveLength(1);
		expect(response.results[0].duplicateTitles?.[0]).not.toBe(response.results[0].title);
	});

	it("omits twin titles when the collapsed entries share the survivor's title", () => {
		const memories: Record<string, HarnessEntry> = {
			"global:a": makeEntry({ id: "a", title: "Same name", content: body }),
			"local:a": { ...makeEntry({ id: "a", title: "Same name", content: body }), scope: "local" },
		};
		const response = searchHarnessMemories(memories, { query: "kubectl patch argo selfheal", topK: 5 });

		expect(response.results).toHaveLength(1);
		expect(response.results[0].duplicateTitles).toBeUndefined();
	});
});
