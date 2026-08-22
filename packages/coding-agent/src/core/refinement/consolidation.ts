import { tokenizeBase } from "./memory-search.js";
import type { HarnessEntry, HarnessState } from "./refinement.js";

/**
 * Storage-side memory governance: find near-duplicate memories and either merge
 * them into their oldest copy or delete exact-content duplicates.
 *
 * Pure over its input: the passed state is never mutated, and when nothing changes
 * the same state object is returned. Only `memory` entries are considered -- skill,
 * prompt, and subagent entries carry executable contracts this pass must never
 * rewrite or delete.
 */

/** Midpoint of the separation between same-topic and different-topic titles. */
export const DEFAULT_TITLE_SIMILARITY_THRESHOLD = 0.6;

/**
 * Content guard for a merge: below this token overlap two similarly-titled bodies
 * are treated as potentially contradictory and both copies are kept. Exact-content
 * duplicates bypass the guard -- identical text cannot contradict itself.
 */
export const DEFAULT_CONTENT_SIMILARITY_THRESHOLD = 0.5;

export interface ConsolidateHarnessMemoriesOptions {
	/** Minimum title token-Jaccard for a merge candidate pair. Default 0.6. */
	titleThreshold?: number;
	/** Minimum content token-Jaccard before a title match may merge. Default 0.5. */
	contentThreshold?: number;
}

export interface HarnessMemoryMerge {
	keptId: string;
	mergedIds: string[];
}

export interface HarnessMemoryDeletion {
	keptId: string;
	deletedIds: string[];
}

export interface HarnessMemoryConsolidation {
	state: HarnessState;
	merged: HarnessMemoryMerge[];
	deleted: HarnessMemoryDeletion[];
}

function similarityTokens(value: string): Set<string> {
	return new Set(tokenizeBase(value));
}

/** Token Jaccard over the two token sets. */
function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 && right.size === 0) return 1;
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	return intersection / (left.size + right.size - intersection);
}

function normalizedContent(content: string): string {
	return content.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Union of the unique whitespace-normalized lines of both bodies, older entry's
 * lines first. Line granularity keeps appended sentences instead of gluing prose
 * into one paragraph, and exact-line matching drops only what is truly repeated.
 */
function unionContent(left: string, right: string): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const source of [left, right]) {
		for (const rawLine of source.split("\n")) {
			const line = rawLine.replace(/\s+/g, " ").trim();
			if (!line) continue;
			const key = normalizedContent(line);
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(line);
		}
	}
	return lines.join("\n");
}

function entryChanged(entry: HarnessEntry): void {
	entry.updated_at = new Date().toISOString();
	entry.version += 1;
}

/**
 * Merge near-duplicate memories and delete exact-content duplicates.
 *
 * Entries are visited oldest-first (created_at, then id), so the kept id is always
 * the older of any pair. A candidate collapses into the current kept entry when its
 * content is byte-identical after whitespace normalization (delete), or when title
 * and content both pass their Jaccard thresholds (merge, unioning content). Merged
 * entries keep the winner's title/path/reference wholesale; only content unions.
 */
export function consolidateHarnessMemories(
	state: HarnessState,
	options: ConsolidateHarnessMemoriesOptions = {},
): HarnessMemoryConsolidation {
	const titleThreshold = options.titleThreshold ?? DEFAULT_TITLE_SIMILARITY_THRESHOLD;
	const contentThreshold = options.contentThreshold ?? DEFAULT_CONTENT_SIMILARITY_THRESHOLD;

	const orderedIds = Object.values(state.entries.memory)
		.sort(
			(left, right) =>
				(left.created_at ?? "").localeCompare(right.created_at ?? "") || left.id.localeCompare(right.id),
		)
		.map((entry) => entry.id);
	const fingerprints = new Map<string, { title: Set<string>; content: Set<string>; normalized: string }>(
		Object.values(state.entries.memory).map((entry) => [
			entry.id,
			{
				title: similarityTokens(entry.title ?? ""),
				content: similarityTokens(entry.content ?? ""),
				normalized: normalizedContent(entry.content ?? ""),
			},
		]),
	);

	const next: HarnessState = structuredClone(state);
	const memories = next.entries.memory;
	// Merge targets are the cloned entries, never the input's -- this pass must not
	// mutate the state it was handed.
	const ordered = orderedIds.map((id) => next.entries.memory[id]);
	const consumed = new Set<string>();
	const merged: HarnessMemoryMerge[] = [];
	const deleted: HarnessMemoryDeletion[] = [];

	for (const kept of ordered) {
		if (consumed.has(kept.id)) continue;
		const keptFingerprint = fingerprints.get(kept.id)!;
		const absorbedIds: string[] = [];
		const duplicateIds: string[] = [];
		for (const candidate of ordered) {
			if (candidate.id === kept.id || consumed.has(candidate.id)) continue;
			const fingerprint = fingerprints.get(candidate.id)!;
			if (fingerprint.normalized === keptFingerprint.normalized) {
				consumed.add(candidate.id);
				delete memories[candidate.id];
				duplicateIds.push(candidate.id);
				continue;
			}
			if (jaccard(keptFingerprint.title, fingerprint.title) < titleThreshold) continue;
			if (jaccard(keptFingerprint.content, fingerprint.content) < contentThreshold) continue;
			consumed.add(candidate.id);
			delete memories[candidate.id];
			absorbedIds.push(candidate.id);
			kept.content = unionContent(kept.content ?? "", candidate.content ?? "");
		}
		if (absorbedIds.length > 0) {
			entryChanged(kept);
			merged.push({ keptId: kept.id, mergedIds: absorbedIds });
		}
		if (duplicateIds.length > 0) {
			deleted.push({ keptId: kept.id, deletedIds: duplicateIds });
		}
	}

	return { state: merged.length > 0 || deleted.length > 0 ? next : state, merged, deleted };
}

/**
 * One refinement-history event describing a consolidation pass, for callers that
 * persist the result. Pure: returns the event, does not touch the state.
 */
export function consolidationRefinementEvent(
	result: HarnessMemoryConsolidation,
	id: string,
): HarnessState["refinements"][number] | undefined {
	const changes = [
		...result.merged.flatMap((merge) => [
			`update memory:${merge.keptId}`,
			...merge.mergedIds.map((absorbed) => `delete memory:${absorbed}`),
		]),
		...result.deleted.flatMap((deletion) => deletion.deletedIds.map((removed) => `delete memory:${removed}`)),
	];
	if (changes.length === 0) return undefined;
	const duplicatesDeleted = result.deleted.reduce((total, deletion) => total + deletion.deletedIds.length, 0);
	return {
		id,
		trigger: "memory consolidation",
		changes: [...new Set(changes)],
		evidence: `${result.merged.length} merge(s), ${duplicatesDeleted} exact duplicate(s)`,
		outcome: "near-duplicate memories consolidated",
		created_at: new Date().toISOString(),
	};
}
