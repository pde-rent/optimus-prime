/**
 * One tree model for every surface that lists agents: the chat preview panel
 * and the full agents view assemble, order, and section the same nodes here
 * instead of each keeping a private tree builder.
 */

import { resolve } from "node:path";
import { canonicalizePath } from "../../utils/paths.js";
import { isChildAgentActive } from "../agent-connection/agent-status.js";
import type { AgentConnectionSavedSessionInfo } from "../agent-connection/index.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";

// ---------------------------------------------------------------------------
// Sections: the single home for the section list, order, and headings.
// ---------------------------------------------------------------------------

/** Display sections, in render order. */
export const AGENTS_VIEW_SECTIONS = ["running", "done", "failed", "archive"] as const;

export type AgentsViewSection = (typeof AGENTS_VIEW_SECTIONS)[number];

export function sectionRank(section: AgentsViewSection): number {
	return AGENTS_VIEW_SECTIONS.indexOf(section);
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "running":
			return "Running";
		case "done":
			return "Done";
		case "failed":
			return "Failed";
		case "archive":
			return "Archive";
	}
}

/** Saved-only sessions older than this leave Done for Archive. */
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AgentsViewSectionBlock<P> {
	section: AgentsViewSection;
	title: string;
	rows: P[];
}

/**
 * Group rows into section blocks, one per canonical section in render order
 * (empty blocks included so headings stay stable). Nested rows stay in the
 * block their top-level row opened, so a subtree never splits across sections.
 */
export function groupBySection<P>(
	rows: readonly P[],
	sectionOf: (row: P, current: AgentsViewSection | undefined) => AgentsViewSection,
): AgentsViewSectionBlock<P>[] {
	const blocks = AGENTS_VIEW_SECTIONS.map((section) => ({
		section,
		title: sectionTitle(section),
		rows: [] as P[],
	}));
	const bySection = new Map(blocks.map((block) => [block.section, block] as const));
	let current: AgentsViewSection | undefined;
	for (const row of rows) {
		current = sectionOf(row, current);
		bySection.get(current)!.rows.push(row);
	}
	return blocks;
}

export function countRowsBySection<P>(
	rows: readonly P[],
	sectionOf: (row: P) => AgentsViewSection,
): Record<AgentsViewSection, number> {
	const counts = Object.fromEntries(AGENTS_VIEW_SECTIONS.map((section) => [section, 0])) as Record<
		AgentsViewSection,
		number
	>;
	for (const row of rows) counts[sectionOf(row)] += 1;
	return counts;
}

// ---------------------------------------------------------------------------
// Tree assembler: one walk producing order, depth, descendants, and prefixes.
// ---------------------------------------------------------------------------

/** Normalized tree node: identity plus parent linkage. */
export interface AgentTreeNode {
	id: string;
	parentId?: string;
}

export interface AgentTreePosition<P> {
	node: P;
	depth: number;
	/** Rows nested under this one at any depth. */
	descendants: number;
	parent?: AgentTreePosition<P>;
	children: AgentTreePosition<P>[];
	/** Tree-drawing branch glued to the status glyph, e.g. "│ └─". */
	prefix: string;
}

export interface AssembleAgentTreeOptions<P> {
	/** Stable node id used for parent lookup and cycle guarding. */
	idOf: (node: P) => string;
	parentIdOf: (node: P) => string | undefined;
	/** Sibling and root ordering; omit to keep catalog insertion order. */
	compare?: (a: P, b: P) => number;
	/**
	 * Runs once after linking and cycle-guarding, before ordering — e.g.
	 * ancestor state promotion that must land before rows are grouped.
	 */
	prepare?: (positions: readonly AgentTreePosition<P>[]) => void;
}

/**
 * Flatten an id/parentId graph into depth-first order. Nodes whose parent is
 * unknown or missing stay as roots so live work is never silently dropped; a
 * parentId cycle has no root, so every node whose ancestor chain loops is
 * re-rooted. Duplicate ids keep the last occurrence, like a catalog refresh.
 */
export function assembleAgentTree<P>(nodes: Iterable<P>, options: AssembleAgentTreeOptions<P>): AgentTreePosition<P>[] {
	const positions: AgentTreePosition<P>[] = [];
	const byId = new Map<string, AgentTreePosition<P>>();
	for (const node of nodes) {
		const position: AgentTreePosition<P> = { node, depth: 0, descendants: 0, children: [], prefix: "" };
		positions.push(position);
		byId.set(options.idOf(node), position);
	}
	// Provisional parent links, resolved through known ids only.
	const parentIds = new Map<string, string>();
	for (const position of positions) {
		const id = options.idOf(position.node);
		const parentId = options.parentIdOf(position.node);
		if (parentId === undefined || parentId === id) continue;
		if (!byId.has(parentId)) continue;
		parentIds.set(id, parentId);
	}
	// Re-root every node whose ancestor chain loops back onto itself.
	for (const [childId, parentId] of parentIds) {
		const guard = new Set<string>([childId]);
		let cursor: string | undefined = parentId;
		while (cursor !== undefined) {
			if (guard.has(cursor)) {
				parentIds.delete(childId);
				break;
			}
			guard.add(cursor);
			cursor = parentIds.get(cursor);
		}
	}
	for (const [childId, parentId] of parentIds) {
		const child = byId.get(childId)!;
		const parent = byId.get(parentId)!;
		child.parent = parent;
		parent.children.push(child);
	}
	options.prepare?.(positions);
	const roots = positions.filter((position) => position.parent === undefined);
	if (options.compare) {
		roots.sort((a, b) => options.compare!(a.node, b.node));
		for (const position of positions) position.children.sort((a, b) => options.compare!(a.node, b.node));
	}
	const flat: AgentTreePosition<P>[] = [];
	const walk = (position: AgentTreePosition<P>, ancestors: string): void => {
		const siblings = position.parent?.children ?? roots;
		const isLast = siblings[siblings.length - 1] === position;
		position.depth = position.parent === undefined ? 0 : position.parent.depth + 1;
		position.prefix = `${ancestors}${isLast ? "└─" : "├─"}`;
		flat.push(position);
		for (const child of position.children) walk(child, `${ancestors}${isLast ? "  " : "│ "}`);
	};
	for (const root of roots) walk(root, "");
	for (let index = flat.length - 1; index >= 0; index--) {
		const position = flat[index]!;
		position.descendants = position.children.reduce((sum, child) => sum + child.descendants + 1, 0);
	}
	return flat;
}

// ---------------------------------------------------------------------------
// Adapter: chat preview panel over RLM child snapshots.
// ---------------------------------------------------------------------------

export interface ChildSnapshotNode extends AgentTreeNode {
	child: AgentConnectionRlmChildAgentSnapshot;
}

/**
 * Panel adapter over the live child roster. Cancelled children drop out;
 * children of the session root (or of an unknown, evicted parent) hang
 * straight off the session.
 */
export function nodesFromChildSnapshots(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	rootId: string | undefined,
): AgentTreePosition<ChildSnapshotNode>[] {
	const known = new Map<string, ChildSnapshotNode>();
	for (const child of children) {
		if (child.status === "cancelled") continue;
		known.set(child.id, {
			id: child.id,
			...(child.parentId !== undefined ? { parentId: child.parentId } : {}),
			child,
		});
	}
	return assembleAgentTree(known.values(), {
		idOf: (node) => node.id,
		parentIdOf: (node) => (node.child.parentId !== rootId ? node.child.parentId : undefined),
	});
}

export interface ChildSnapshotTotals {
	total: number;
	running: number;
	done: number;
	errored: number;
	tokens: number;
}

/** Tree totals over snapshot rows; a done child still emitting counts as running. */
export function summarizeChildSnapshots(rows: readonly AgentTreePosition<ChildSnapshotNode>[]): ChildSnapshotTotals {
	const totals: ChildSnapshotTotals = { total: rows.length, running: 0, done: 0, errored: 0, tokens: 0 };
	for (const { node } of rows) {
		totals.tokens += node.child.tokenCount ?? 0;
		if (node.child.status === "error") totals.errored += 1;
		else if (isChildAgentActive(node.child)) totals.running += 1;
		else if (node.child.status === "done") totals.done += 1;
	}
	return totals;
}

// ---------------------------------------------------------------------------
// Adapter: full agents view over unified session records.
// ---------------------------------------------------------------------------

export interface UnifiedSessionHeartbeat {
	activeCount: number;
	nextRunAt?: string;
}

export interface UnifiedSessionRecord {
	daemon?: SessionSummary;
	saved?: AgentConnectionSavedSessionInfo;
	/** Stable UI key, chosen using canonical path, session id, then active id. */
	identity: string;
	/** Alternate keys used to restore selection while a session is persisted or reattached. */
	identityAliases: readonly string[];
	section: AgentsViewSection;
	searchableText: string;
	heartbeat?: UnifiedSessionHeartbeat;
}

export function canonicalSessionPath(path: string): string {
	return resolve(canonicalizePath(path));
}

function fileIdentity(path: string): string {
	return `file:${canonicalSessionPath(path)}`;
}

export function getAgentsViewSummaryIdentity(summary: SessionSummary): string {
	if (summary.sessionFile) return fileIdentity(summary.sessionFile);
	if (summary.activeSessionId) return `active:${summary.activeSessionId}`;
	return `session:${summary.sessionId}`;
}

export function summaryIdentityAliases(summary: SessionSummary): string[] {
	return [
		summary.sessionFile ? fileIdentity(summary.sessionFile) : undefined,
		`session:${summary.sessionId}`,
		summary.activeSessionId ? `active:${summary.activeSessionId}` : undefined,
		`active:${summary.id}`,
	].filter((identity): identity is string => identity !== undefined);
}

export function savedIdentityAliases(saved: AgentConnectionSavedSessionInfo): string[] {
	return [fileIdentity(saved.path), `session:${saved.id}`];
}

/** Every key another summary can reference this summary by. */
export function getSummaryKeys(summary: SessionSummary): string[] {
	return [
		`active:${summary.activeSessionId ?? summary.id}`,
		`session:${summary.sessionId}`,
		summary.sessionFile ? fileIdentity(summary.sessionFile) : undefined,
	].filter((key): key is string => key !== undefined);
}

/** Parent alias keys: runtime linkage first, then the saved fork path. */
export function summaryParentKeys(summary: SessionSummary): string[] {
	return [
		summary.parentActiveSessionId ? `active:${summary.parentActiveSessionId}` : undefined,
		summary.parentSessionId ? `session:${summary.parentSessionId}` : undefined,
		summary.parentSessionPath ? fileIdentity(summary.parentSessionPath) : undefined,
	].filter((key): key is string => key !== undefined);
}

export function unifiedRecordParentKeys(record: UnifiedSessionRecord): string[] {
	const daemonKeys = record.daemon ? summaryParentKeys(record.daemon) : [];
	const savedKey = record.saved?.parentSessionPath ? fileIdentity(record.saved.parentSessionPath) : undefined;
	return savedKey ? [...daemonKeys, savedKey] : daemonKeys;
}

/**
 * Full-view adapter: links unified records through their identity aliases.
 * Saved catalogs stream progressively, so a child whose parent record has not
 * appeared yet stays reachable as a root until the parent arrives.
 */
export function nodesFromUnifiedRecords(
	records: readonly UnifiedSessionRecord[],
): AgentTreePosition<UnifiedSessionRecord>[] {
	const byAlias = new Map<string, UnifiedSessionRecord>();
	for (const record of records) {
		for (const key of record.identityAliases) byAlias.set(key, record);
	}
	return assembleAgentTree(records, {
		idOf: (record) => record.identity,
		parentIdOf: (record) => {
			for (const key of unifiedRecordParentKeys(record)) {
				const parent = byAlias.get(key);
				if (parent && parent !== record) return parent.identity;
			}
			return undefined;
		},
	});
}
