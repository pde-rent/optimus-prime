import { randomUUID } from "node:crypto";
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
	"harness.overview",
	"harness.get_state",
];

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
		return loadMergedState(ctx) as unknown as Record<string, unknown>;
	}
	if (type === "harness.record_refinement") {
		return recordRefinement(payload, ctx);
	}
	const match = /^harness\.(create|update|delete)_(.+)$/.exec(type);
	const kind = match ? KIND_BY_SUFFIX[match[2]] : undefined;
	if (!match || !kind) {
		throw new Error(`unknown harness request type "${type}"`);
	}
	return applySingleEdit(type, match[1] as RefinementAction, kind, payload, ctx);
}
