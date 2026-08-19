import { randomUUID } from "node:crypto";
import { type HarnessMemorySearchResult, searchHarnessMemories } from "./memory-search.js";
import {
	applyRefinementProposal,
	type HarnessEntry,
	type HarnessScope,
	type HarnessState,
	loadHarnessState,
	mergeHarnessStates,
	type RefinementAction,
	type RefinementKind,
	saveHarnessState,
} from "./refinement.js";

/**
 * Host-side implementation of the `rlm.harness` surface documented in
 * prompts/rlm.ts. The sandbox never touches the harness store directly: it sends
 * `harness.*` host requests and the host applies them through the same
 * `applyRefinementProposal` path `/refine` uses, so REPL-created entries are
 * validated and shaped identically to refinement-created ones.
 */

export interface HarnessBridgeContext {
	globalDir: string;
	/** Session-local store; absent when the session has no artifact dir. */
	localDir?: string;
	/** Called after a successful write so the next system-prompt build sees it. */
	onStateChanged?: () => void;
}

const KIND_BY_SUFFIX: Record<string, RefinementKind> = {
	memory: "memory",
	skill: "skill",
	subagent: "subagent",
	prompt_note: "prompt",
};

export const HARNESS_HOST_REQUEST_TYPES: readonly string[] = [
	...Object.keys(KIND_BY_SUFFIX).flatMap((suffix) => [
		`harness.create_${suffix}`,
		`harness.update_${suffix}`,
		`harness.delete_${suffix}`,
	]),
	"harness.record_refinement",
	"harness.search_memory",
	"harness.get_memory",
	"harness.overview",
	"harness.get_state",
];

/** Search snippets are lossy, so `harness.get_memory` caps rather than truncates silently. */
const GET_MEMORY_MAX_CHARS = 20000;

/** `get_state` returns the recent tail of the refinement log, not all of it. */
const GET_STATE_MAX_REFINEMENTS = 20;

/**
 * Wire shape of a `harness.search_memory` hit (snake_case, like every other bridge payload).
 *
 * Measured on a real corpus, the metadata envelope was ~50% of the response: the
 * fields the model never acts on cost as much as the snippets it reads. Only the
 * five it needs to decide "is this the memory I want, and how do I fetch it" are
 * sent by default; the rest are diagnostics behind `verbose`.
 */
export interface HarnessSearchMemoryHit {
	id: string;
	scope: HarnessScope;
	title: string;
	path: string;
	score: number;
	snippet: string;
	/** Present only when the snippet is shorter than the stored body. */
	truncated?: true;
	/** Merged-state key; `scope:id` and therefore derivable. Verbose only. */
	key?: string;
	version?: number;
	updated_at?: string;
	coverage?: number;
	matched_terms?: string[];
	content_chars?: number;
}

export interface HarnessSearchMemoryResponse {
	query: string;
	query_terms: string[];
	top_k: number;
	scope: HarnessScope | "all";
	total_matches: number;
	results: HarnessSearchMemoryHit[];
	/** Candidates dropped by the relevance gates. Present only when non-zero. */
	suppressed_by_gate?: number;
	/** Recovery facets, sent only when nothing matched, so a miss can be reworded. */
	memory_count?: number;
	paths?: string[];
}

export interface HarnessGetMemoryResponse {
	key: string;
	id: string;
	scope: HarnessScope;
	title: string;
	path: string;
	version: number;
	created_at: string;
	updated_at: string;
	content: string;
	content_chars: number;
	truncated: boolean;
	metadata: Record<string, unknown>;
}

function optionalString(payload: Record<string, unknown>, key: string, type: string): string | undefined {
	const value = payload[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${type} ${key} must be a string when provided`);
	}
	return value;
}

function optionalRecord(
	payload: Record<string, unknown>,
	key: string,
	type: string,
): Record<string, unknown> | undefined {
	const value = payload[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${type} ${key} must be an object when provided`);
	}
	return value as Record<string, unknown>;
}

function resolveScope(payload: Record<string, unknown>, type: string, ctx: HarnessBridgeContext) {
	const flag = payload.global;
	if (flag !== undefined && typeof flag !== "boolean") {
		throw new Error(`${type} global must be a boolean when provided`);
	}
	const scope: HarnessScope = flag ? "global" : "local";
	const dir = scope === "global" ? ctx.globalDir : ctx.localDir;
	if (!dir) {
		throw new Error(
			`${type} cannot write local harness state: this session has no local harness store. Pass { global: true } to target the cross-session store.`,
		);
	}
	return { scope, dir };
}

function loadMergedState(ctx: HarnessBridgeContext): HarnessState {
	return mergeHarnessStates(
		loadHarnessState(ctx.globalDir, "global"),
		ctx.localDir ? loadHarnessState(ctx.localDir, "local") : undefined,
	);
}

function entrySummary(entry: HarnessEntry): Record<string, unknown> {
	return {
		id: entry.id,
		kind: entry.kind,
		scope: entry.scope ?? "global",
		title: entry.title,
		path: entry.path,
		version: entry.version,
		updated_at: entry.updated_at,
	};
}

function overview(state: HarnessState): Record<string, unknown> {
	const counts: Record<string, number> = {};
	const entries: Record<string, Record<string, unknown>[]> = {};
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const kindEntries = Object.values(state.entries[kind]);
		counts[kind] = kindEntries.length;
		entries[kind] = kindEntries.map(entrySummary);
	}
	return {
		counts,
		entries,
		refinement_count: state.refinements.length,
		recent_refinements: state.refinements.slice(-5),
	};
}

function applySingleEdit(
	type: string,
	action: RefinementAction,
	kind: RefinementKind,
	payload: Record<string, unknown>,
	ctx: HarnessBridgeContext,
): Record<string, unknown> {
	const { scope, dir } = resolveScope(payload, type, ctx);
	const state = loadHarnessState(dir, scope);

	const id = optionalString(payload, "id", type);
	if (action !== "create" && !id) {
		throw new Error(`${type} requires id`);
	}
	// Ids in the prompt overview may carry a display-only `local:`/`global:` prefix.
	const bareId = id?.replace(/^(?:local|global):/, "");
	const existing = bareId ? state.entries[kind][bareId] : undefined;
	if (action !== "create" && !existing) {
		throw new Error(`${type} entry not found in ${scope} harness state: ${bareId}`);
	}
	if (action === "create" && bareId && state.entries[kind][bareId]) {
		throw new Error(`${type} entry already exists in ${scope} harness state: ${bareId}`);
	}

	// Updates are partial: unspecified fields fall back to the stored entry so the
	// shared validator sees a complete edit rather than rejecting a partial one.
	const edit = {
		action,
		kind,
		id: bareId,
		title: optionalString(payload, "title", type) ?? (action === "update" ? existing?.title : undefined),
		content: optionalString(payload, "content", type) ?? (action === "update" ? existing?.content : undefined),
		path: optionalString(payload, "path", type) ?? (action === "update" ? existing?.path : undefined),
		reference: optionalRecord(payload, "reference", type) ?? (action === "update" ? existing?.reference : undefined),
		arguments: optionalRecord(payload, "arguments", type) ?? (action === "update" ? existing?.arguments : undefined),
		metadata: optionalRecord(payload, "metadata", type) ?? (action === "update" ? existing?.metadata : undefined),
		reason: optionalString(payload, "reason", type) ?? `${action} ${kind} from RLM harness bridge`,
	};

	const result = applyRefinementProposal(
		state,
		{
			summary: `${action} ${kind} from RLM harness bridge`,
			rationale: edit.reason ?? "",
			expectedOutcome: "",
			edits: [edit],
		},
		{ id: `harness-${randomUUID()}`, scope },
	);
	// applyRefinementProposal records a refinement event for every proposal. A single
	// CRUD call is not a refinement, so drop it here; record_refinement is the explicit
	// way to log one.
	state.refinements.pop();

	const applied = result.appliedEdits[0];
	if (!applied?.applied) {
		throw new Error(`${type} rejected: ${applied?.error ?? "unknown error"}`);
	}
	const path = saveHarnessState(dir, state);
	ctx.onStateChanged?.();

	return {
		id: applied.id,
		kind,
		action,
		scope,
		harness_state_path: path,
		entry: applied.after ?? null,
		before: applied.before ?? null,
	};
}

function recordRefinement(payload: Record<string, unknown>, ctx: HarnessBridgeContext): Record<string, unknown> {
	const type = "harness.record_refinement";
	const { scope, dir } = resolveScope(payload, type, ctx);
	const trigger = optionalString(payload, "trigger", type);
	if (!trigger) {
		throw new Error(`${type} requires trigger`);
	}
	const rawChanges = payload.changes;
	if (rawChanges !== undefined && !Array.isArray(rawChanges)) {
		throw new Error(`${type} changes must be an array of strings when provided`);
	}
	const changes = (rawChanges ?? []).map((change) => {
		if (typeof change !== "string") {
			throw new Error(`${type} changes must be an array of strings when provided`);
		}
		return change;
	});

	const state = loadHarnessState(dir, scope);
	const event = {
		id: `harness-${randomUUID()}`,
		trigger,
		changes,
		evidence: optionalString(payload, "evidence", type) ?? "",
		outcome: optionalString(payload, "outcome", type) ?? "",
		created_at: new Date().toISOString(),
	};
	state.refinements.push(event);
	const path = saveHarnessState(dir, state);
	ctx.onStateChanged?.();
	return { refinement: event, scope, harness_state_path: path };
}

/**
 * Read-side scope: an explicit `scope` wins, but `{ global: true }` is accepted too
 * because every sibling CRUD call on this bridge selects its store that way.
 */
function resolveReadScope(payload: Record<string, unknown>, type: string): HarnessScope | undefined {
	const scope = payload.scope;
	if (scope !== undefined && scope !== null) {
		if (scope !== "local" && scope !== "global") {
			throw new Error(`${type} scope must be "local" or "global" when provided`);
		}
		return scope;
	}
	const flag = payload.global;
	if (flag !== undefined && flag !== null) {
		if (typeof flag !== "boolean") {
			throw new Error(`${type} global must be a boolean when provided`);
		}
		if (flag) return "global";
	}
	return undefined;
}

/**
 * `top_k` is a display knob, not a contract: out-of-range and fractional values are
 * clamped rather than thrown, so a model guessing `top_k: 50` still gets an answer.
 */
function resolveTopK(payload: Record<string, unknown>, type: string): number {
	const raw = payload.top_k ?? payload.topK;
	if (raw === undefined || raw === null) return 5;
	const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
	if (!Number.isFinite(numeric)) {
		throw new Error(`${type} top_k must be a number when provided`);
	}
	return Math.min(10, Math.max(1, Math.round(numeric)));
}

function searchMemory(payload: Record<string, unknown>, ctx: HarnessBridgeContext): HarnessSearchMemoryResponse {
	const type = "harness.search_memory";
	const rawQuery = payload.query;
	if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
		throw new Error(`${type} requires a non-empty query string`);
	}
	const query = rawQuery.trim();
	const topK = resolveTopK(payload, type);
	const scope = resolveReadScope(payload, type);
	const verbose = payload.verbose === true;

	const memories = loadMergedState(ctx).entries.memory;
	const found = searchHarnessMemories(memories, { query, topK, scope });
	const response: HarnessSearchMemoryResponse = {
		query,
		query_terms: found.queryTerms,
		top_k: topK,
		scope: scope ?? "all",
		total_matches: found.totalMatches,
		results: found.results.map((result) => toSearchHit(result, verbose)),
	};
	if (found.suppressedByGate > 0) {
		response.suppressed_by_gate = found.suppressedByGate;
	}
	// Retrieval is the only path to a memory's contents and nothing retrieves
	// automatically, so an empty result must say whether the store is empty or the
	// wording missed. Sent only on a miss: on a hit it is noise the model pays for.
	if (found.results.length === 0) {
		const inScope = Object.values(memories).filter(
			(entry) => scope === undefined || (entry.scope ?? "global") === scope,
		);
		response.memory_count = inScope.length;
		response.paths = [...new Set(inScope.map((entry) => entry.path).filter(Boolean))].sort();
	}
	return response;
}

function toSearchHit(result: HarnessMemorySearchResult, verbose: boolean): HarnessSearchMemoryHit {
	const hit: HarnessSearchMemoryHit = {
		id: result.id,
		scope: result.scope,
		title: result.title,
		path: result.path,
		score: result.score,
		snippet: result.snippet,
	};
	// Omitted rather than sent false: an absent key costs nothing, `truncated: false`
	// costs its name on every hit.
	if (result.truncated) hit.truncated = true;
	if (verbose) {
		hit.key = result.key;
		hit.version = result.version;
		hit.updated_at = result.updatedAt;
		hit.coverage = result.coverage;
		hit.matched_terms = result.matchedTerms;
		hit.content_chars = result.contentChars;
	}
	return hit;
}

function localFirst(entry: HarnessEntry): number {
	return (entry.scope ?? "global") === "local" ? 0 : 1;
}

/** Fetch one memory in full, because search now returns snippets rather than bodies. */
function getMemory(payload: Record<string, unknown>, ctx: HarnessBridgeContext): HarnessGetMemoryResponse {
	const type = "harness.get_memory";
	const rawId = optionalString(payload, "id", type)?.trim();
	if (!rawId) {
		throw new Error(`${type} requires id`);
	}
	// Ids in the prompt overview may carry a display-only `local:`/`global:` prefix.
	const prefix = /^(local|global):/.exec(rawId);
	const bareId = prefix ? rawId.slice(prefix[0].length) : rawId;
	const requested = resolveReadScope(payload, type);
	const preferred = requested ?? (prefix ? (prefix[1] as HarnessScope) : undefined);

	const memories = loadMergedState(ctx).entries.memory;
	let candidates = Object.entries(memories).filter(([key, entry]) => entry.id === bareId || key === rawId);
	if (preferred) {
		const scoped = candidates.filter(([, entry]) => (entry.scope ?? "global") === preferred);
		if (scoped.length > 0 || requested !== undefined) candidates = scoped;
	}
	if (candidates.length === 0) {
		throw new Error(`${type} memory not found: ${rawId}`);
	}
	// Ambiguous ids resolve to local; the response carries the scope actually served.
	candidates.sort(([, left], [, right]) => localFirst(left) - localFirst(right));
	const [key, entry] = candidates[0];

	const content = entry.content ?? "";
	return {
		key,
		id: entry.id,
		scope: entry.scope ?? "global",
		title: entry.title,
		path: entry.path,
		version: entry.version,
		created_at: entry.created_at,
		updated_at: entry.updated_at,
		content: content.slice(0, GET_MEMORY_MAX_CHARS),
		content_chars: content.length,
		truncated: content.length > GET_MEMORY_MAX_CHARS,
		metadata: entry.metadata ?? {},
	};
}

/**
 * Every other read on this bridge is bounded -- search by `PAYLOAD_BUDGET`, single
 * reads by `GET_MEMORY_MAX_CHARS` -- but `get_state` returned every entry's full body
 * plus the entire refinement log, so the one call meant as an escape hatch was the one
 * that could exhaust the context window.
 */
function boundedState(state: HarnessState): Record<string, unknown> {
	const entries: Record<string, Record<string, HarnessEntry>> = {};
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		entries[kind] = {};
		for (const [id, entry] of Object.entries(state.entries[kind])) {
			const content = entry.content ?? "";
			entries[kind][id] =
				content.length > GET_MEMORY_MAX_CHARS
					? { ...entry, content: content.slice(0, GET_MEMORY_MAX_CHARS) }
					: entry;
		}
	}
	return {
		schema: state.schema,
		entries,
		refinements: state.refinements.slice(-GET_STATE_MAX_REFINEMENTS),
		refinement_count: state.refinements.length,
	};
}

/** Handle a `harness.*` host request from the Bun REPL sandbox. */
export function handleHarnessHostRequest(
	type: string,
	payload: Record<string, unknown> = {},
	ctx: HarnessBridgeContext,
): Record<string, unknown> {
	if (type === "harness.overview") {
		return overview(loadMergedState(ctx));
	}
	if (type === "harness.get_state") {
		return boundedState(loadMergedState(ctx));
	}
	if (type === "harness.record_refinement") {
		return recordRefinement(payload, ctx);
	}
	if (type === "harness.search_memory") {
		return searchMemory(payload, ctx) as unknown as Record<string, unknown>;
	}
	if (type === "harness.get_memory") {
		return getMemory(payload, ctx) as unknown as Record<string, unknown>;
	}
	const match = /^harness\.(create|update|delete)_(.+)$/.exec(type);
	const kind = match ? KIND_BY_SUFFIX[match[2]] : undefined;
	if (!match || !kind) {
		throw new Error(`unknown harness request type "${type}"`);
	}
	return applySingleEdit(type, match[1] as RefinementAction, kind, payload, ctx);
}
