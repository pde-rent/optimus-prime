import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import type { HostRequestHandler } from "./tools/repl-types.js";

/** Request emitted by `rlm.run`; cellSourceCode preserves the spawning cell for display. */
export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	cellSourceCode?: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
	/** Level the child actually got, after clamping to its model's supported set. */
	effort: string;
	/**
	 * Present when a requested `effort` was not applied at all. Band clamping is not a
	 * refusal — `effort` already reports it — but a level dropped by policy has to be
	 * visible, or the model reads its own ignored kwarg as honored.
	 */
	effort_refused?: RlmEffortRefusal;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error" | "stalled";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
	/** Tokens this child has spent so far, from the harness's own usage attribution. */
	tokens_spent: number;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

/**
 * Validate an orchestrator-supplied peer list: the siblings this child may message.
 *
 * Directed and per-node, so the cohort's edges are whatever the spawner declared rather than a
 * single on/off switch over "all siblings". Listing B in A's peers does not let B reach A, which is
 * what makes one-way review edges expressible.
 *
 * An empty array is meaningful and distinct from omitting the kwarg: it says this child talks to
 * nobody but its parent. Omitting it leaves the family default in place.
 */
export function normalizeRequestedRlmPeers(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("rlm.run peers must be an array of sibling names");
	}
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry.trim()) {
			throw new Error("rlm.run peers entries must be non-empty strings");
		}
		const name = entry.trim();
		if (!names.includes(name)) names.push(name);
	}
	return names;
}

/** Validate and normalize an orchestrator-supplied subagent session name. */
export function normalizeRequestedRlmSubagentSessionName(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run name must be a string");
	}
	const name = value.trim();
	if (!name) {
		throw new Error("rlm.run name must not be empty");
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

/** Validate and normalize an orchestrator-supplied subagent model reference. */
export function normalizeRequestedRlmSubagentModel(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run model must be a string");
	}
	const model = value.trim();
	if (!model) {
		throw new Error("rlm.run model must not be empty");
	}
	return model;
}

/** Reasoning-effort levels the model may name; a subset is supported per model. */
const RLM_EFFORT_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Validate an orchestrator-supplied effort level. An unknown name throws so a
 * typo surfaces at the call site; a known-but-unsupported level is returned and
 * clamped downstream, which never throws.
 */
export function normalizeRequestedRlmEffort(value: unknown): ThinkingLevel | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm effort must be a string");
	}
	const effort = value.trim().toLowerCase();
	if (!RLM_EFFORT_LEVELS.includes(effort as ThinkingLevel)) {
		throw new Error(`rlm effort must be one of: ${RLM_EFFORT_LEVELS.join(", ")}`);
	}
	return effort as ThinkingLevel;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/** Adapt an RlmRunHandler into the typed `rlm.run` kernel host handler. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({
			prompt: payload.prompt,
			kwargs,
			cellSourceCode,
		});
		return result as unknown as Record<string, unknown>;
	};
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}

/** Expose the current parent session's direct RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return async () => {
		const { subagents } = await handler();
		return { subagents };
	};
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim());
		return outcome === undefined ? { subagent } : { subagent, outcome };
	};
}

/** Why a model-initiated effort change was not applied. */
export type RlmEffortRefusal = "disabled" | "band" | "floor" | "lower_after_raise";

export interface RlmSetEffortResult {
	effort: string;
	clamped: boolean;
	/** The run already spent its effort-change budget; the level is unchanged. */
	capped?: boolean;
	refused?: RlmEffortRefusal;
}

export interface RlmSetMaxDepthResult {
	max_depth: number;
	capped: boolean;
	/** Why a requested change was not applied, when it was not. */
	refused?: "cap" | "no_trigger" | "thrash" | "disabled";
}

export interface RlmGetMaxDepthResult {
	max_depth: number;
	depth: number;
	/** Ceiling on a model-initiated raise. */
	model_max: number;
}

export interface RlmGetEffortResult {
	effort: string;
	available: string[];
}

export type RlmSetEffortHandler = (level: ThinkingLevel) => RlmSetEffortResult | Promise<RlmSetEffortResult>;
export type RlmGetEffortHandler = () => RlmGetEffortResult | Promise<RlmGetEffortResult>;

/** Let the model raise or lower its own reasoning effort for the next turn. */
export function createRlmSetEffortHostHandler(handler: RlmSetEffortHandler): HostRequestHandler {
	return async (payload) => {
		const level = normalizeRequestedRlmEffort(payload.level);
		if (level === undefined) {
			throw new Error(`rlm.set_effort level must be one of: ${RLM_EFFORT_LEVELS.join(", ")}`);
		}
		return { ...(await handler(level)) };
	};
}

/** Report the level in force plus the levels the current model actually supports. */
export function createRlmGetEffortHostHandler(handler: RlmGetEffortHandler): HostRequestHandler {
	return async () => ({ ...(await handler()) });
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmMaxDepthPinned?: boolean;
	/** Siblings this child may message. Undefined leaves the family default. */
	peerNames?: string[];
	rlmParentNodeId: string;
	/** Source of the REPL cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
