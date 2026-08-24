import type { ServiceTier, Transport } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { ensureDir, isTruthyEnvVar } from "../utils/shared.js";
import { acquireLockSyncWithRetry } from "./file-lock.js";
import { DEFAULT_GRAPH_RESOLVER_LEVEL, type GraphResolverLevel, isGraphResolverLevel } from "./graph-resolver.js";
import { isRlmMaxDepthValue, type RlmMaxDepthValue } from "./rlm-max-depth.js";

type MaxRunningAgentsSetting = "auto" | number;

const RECENT_MODELS_LIMIT = 20;
const DEFAULT_IDLE_EVICTION_MINUTES = 90;
const DEFAULT_REPL_IDLE_TIMEOUT_MINUTES = 10;

interface ToolTimeoutsSettings {
	/** Default repl cell timeout in ms; a call-level timeout overrides it. default: 120000 */
	replMs?: number;
	/** Default bash tool timeout in seconds; 0 keeps the current no-default behavior. default: 0 */
	bashSeconds?: number;
}

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	maxContextTokens?: number; // default: 666000 - harness-side context budget, hard-capped by the model window
	compactAtTokens?: number; // default: 500000 - context level where threshold compaction triggers
	agentCallable?: boolean; // default: true - expose the compact skill so the model can request compaction
}

interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

interface AutoRefineSettings {
	enabled?: boolean; // default: true
	turnInterval?: number; // default: 25 assistant turns
	compact?: boolean; // default: true
	cooldownMs?: number; // default: 20 minutes
}

interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 5
	baseDelayMs?: number; // default: 2000 (exponential backoff with jitter, capped by maxDelayMs)
	maxDelayMs?: number; // default: 60000
	provider?: ProviderRetrySettings;
}

interface TerminalSettings {
	showImages?: boolean; // default: true (show image type and dimensions)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	fullscreen?: boolean; // default: true (alternate-screen rendering with scrollable transcript)
	fullscreenMouse?: boolean; // default: true
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

interface BundledSkillsSettings {
	websearch?: boolean; // default: true
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/**
 * Remote/local MCP server an integration connects to. Built-in integrations
 * (Linear/Notion) are defined in the ai/mcp catalog; this is for user-declared
 * servers. The kernel-side integration package reads creds from auth.json
 * (`mcp:<name>`); login/refresh run host-side.
 */
export type McpServerConfig =
	| {
			type: "http";
			url: string;
			headers?: Record<string, string>;
			/** Env var holding a static bearer token (skips OAuth). */
			bearerTokenEnvVar?: string;
			/** Use the generic OAuth login flow for this server. */
			oauth?: boolean;
			/** Force-disable even when credentials exist. */
			enabled?: boolean;
			/** Only these tools are offered to the model. Named as the wider convention names them. */
			includeTools?: string[];
			/** These tools are withheld. Takes precedence over `includeTools`. */
			excludeTools?: string[];
	  }
	| {
			type: "stdio";
			command: string;
			args?: string[];
			env?: Record<string, string>;
			enabled?: boolean;
			includeTools?: string[];
			excludeTools?: string[];
	  };

/**
 * How much the model may move its own reasoning effort.
 * - `off`: static; the configured level is the only level.
 * - `banded`: free movement within low/medium/high; xhigh/max need an escalation trigger.
 * - `free`: no band; only the thrash guard applies.
 */
export type DynamicEffortMode = "off" | "banded" | "free";

const DEFAULT_DYNAMIC_EFFORT_MODE: DynamicEffortMode = "banded";

export interface Settings {
	onboardingShown?: boolean;
	onboardingCompleted?: boolean;
	defaultProvider?: string;
	defaultModel?: string;
	recentModels?: string[]; // "provider/id" keys, most-recently-used first
	/** Floor for dynamic effort, not a fixed level: the model may raise above it, never below. */
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	dynamicEffort?: DynamicEffortMode; // default: "banded"
	/** Let an agent raise its own recursion limit after an observed failure. default: true */
	dynamicDepth?: boolean;
	dynamicContext?: boolean; // default: true - allow the agent to adjust context budget and compaction trigger at runtime
	toolTimeouts?: ToolTimeoutsSettings;
	/** Show the live sub-agent graph while children are running. default: true */
	subagentGraph?: boolean;
	/** Abort a turn whose streamed text or reasoning collapses into a repetition loop. default: true */
	degeneracyGuard?: boolean;
	/** Steer, abort, or stop a run whose assistant keeps planning without acting. default: true */
	reasoningLoopGuard?: boolean;
	/** Re-prompt an idle session whose todo board still has open tasks. default: true */
	todoWatchdogEnabled?: boolean;
	/** Seconds a session stays idle with open todos before the watchdog continuation fires. default: 120 */
	todoWatchdogDelaySeconds?: number;
	defaultServiceTier?: ServiceTier;
	rlmMaxDepth?: RlmMaxDepthValue; // default for new sessions; unset falls through to RLM_MAX_DEPTH, then 1
	/** Cap on concurrently running rlm subagents. "auto" sizes it from a live memory sample; a number pins it (kill-switch). default: "auto" */
	maxRunningAgents?: MaxRunningAgentsSetting;
	/** Multi-agent graph budget dial. "off" keeps the single-agent path. default: "off" */
	graphResolver?: GraphResolverLevel;
	/** Clamp on the level ceiling. Only ever lowers it; it cannot raise a level past its budget. */
	graphMaxTokens?: number;
	idleEvictionMinutes?: number | "off"; // global daemon policy; default: 90
	/** Minutes a Bun REPL kernel may sit idle before it is disposed (snapshot-restored on next use). "off" keeps the kernel forever. default: 10 */
	replIdleTimeoutMinutes?: number | "off";
	/** Reap an idle REPL kernel early once its RSS exceeds this many MB. 0 disables. default: 512 */
	replPressureReapMb?: number;
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	/** How a submitted message interacts with an existing queue. default: "merge" */
	queueMergeBehavior?: "merge" | "separate";
	theme?: string;
	compaction?: CompactionSettings;
	autoRefine?: AutoRefineSettings;
	agentTraces?: AgentTracesSettings;
	telemetry?: TelemetrySettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	/** Play the start-up animation and sound. default: true */
	ignition?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	mcpServers?: Record<string, McpServerConfig>; // User-declared MCP servers (name → config); built-ins are in the ai/mcp catalog
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	bundledSkills?: BundledSkillsSettings; // Configure built-in skills shipped with Optimus Prime
	enableBuiltinSkills?: boolean; // default: true - load built-in skills shipped with optimus
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default: "user-only"
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
}

interface AgentTracesSettings {
	enabled?: boolean;
}

interface TelemetrySettings {
	enabled?: boolean;
	noticeShown?: boolean;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

type SettingsScope = "global" | "project";

interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			const fileExists = existsSync(path);
			if (fileExists) {
				release = acquireLockSyncWithRetry(path, "settings");
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				ensureDir(dir);
				if (!release) {
					release = acquireLockSyncWithRetry(path, "settings");
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private runtimeOverrides: Settings = {};
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		if (typeof settings.telemetry === "boolean") {
			settings.telemetry = { enabled: settings.telemetry };
		} else if (
			settings.telemetry !== undefined &&
			(typeof settings.telemetry !== "object" || settings.telemetry === null || Array.isArray(settings.telemetry))
		) {
			delete settings.telemetry;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}
	/** Set one top-level global setting and persist it. */
	private setGlobalField<K extends keyof Settings>(key: K, value: Settings[K]): void {
		this.globalSettings[key] = value;
		this.markModified(key);
		this.save();
	}

	private ensureGlobalSection<K extends "compaction" | "agentTraces" | "retry" | "terminal" | "images">(
		key: K,
	): NonNullable<Settings[K]> {
		if (!this.globalSettings[key]) {
			this.globalSettings[key] = {} as NonNullable<Settings[K]>;
		}
		return this.globalSettings[key] as NonNullable<Settings[K]>;
	}

	private setProjectListField(
		key: "packages" | "extensions" | "skills" | "prompts" | "themes",
		value: unknown[],
	): void {
		const projectSettings = structuredClone(this.projectSettings);
		(projectSettings as Record<string, unknown>)[key] = value;
		this.markProjectModified(key);
		this.saveProjectSettings(projectSettings);
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private persistScope(scope: SettingsScope, settings: Settings, loadError: Error | null): void {
		if (loadError) {
			const label = scope === "global" ? "Global" : "Project";
			this.recordError(
				scope,
				new Error(`${label} settings not saved: settings file failed to parse: ${loadError.message}`),
			);
			return;
		}

		const snapshot = structuredClone(settings);
		const modifiedFields = new Set(scope === "global" ? this.modifiedFields : this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(
			scope === "global" ? this.modifiedNestedFields : this.modifiedProjectNestedFields,
		);
		this.enqueueWrite(scope, () => {
			this.persistScopedSettings(scope, snapshot, modifiedFields, modifiedNestedFields);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
		this.persistScope("global", this.globalSettings, this.globalSettingsLoadError);
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
		this.persistScope("project", this.projectSettings, this.projectSettingsLoadError);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(scope?: SettingsScope): SettingsError[] {
		if (!scope) {
			const drained = [...this.errors];
			this.errors = [];
			return drained;
		}
		const drained = this.errors.filter((entry) => entry.scope === scope);
		this.errors = this.errors.filter((entry) => entry.scope !== scope);
		return drained;
	}

	getOnboardingShown(): boolean {
		return this.settings.onboardingShown ?? this.settings.onboardingCompleted ?? false;
	}

	setOnboardingShown(shown: boolean): void {
		this.setGlobalField("onboardingShown", shown);
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		if (!sessionDir) {
			return sessionDir;
		}
		if (sessionDir === "~") {
			return homedir();
		}
		if (sessionDir.startsWith("~/")) {
			return join(homedir(), sessionDir.slice(2));
		}
		return sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.setGlobalField("defaultProvider", provider);
	}

	setDefaultModel(modelId: string): void {
		this.setGlobalField("defaultModel", modelId);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.recordModelUseInternal(provider, modelId);
		this.markModified("recentModels");
		this.save();
	}

	getRecentModels(): string[] {
		return this.settings.recentModels ?? [];
	}

	private recordModelUseInternal(provider: string, modelId: string): void {
		const key = `${provider}/${modelId}`;
		const next = [key, ...this.getRecentModels().filter((k) => k !== key)];
		this.globalSettings.recentModels = next.slice(0, RECENT_MODELS_LIMIT);
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobalField("steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobalField("followUpMode", mode);
	}

	getQueueMergeBehavior(): "merge" | "separate" {
		return this.settings.queueMergeBehavior || "merge";
	}

	setQueueMergeBehavior(behavior: "merge" | "separate"): void {
		this.setGlobalField("queueMergeBehavior", behavior);
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.setGlobalField("theme", theme);
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): void {
		this.setGlobalField("defaultThinkingLevel", level);
	}

	getDynamicEffort(): DynamicEffortMode {
		return this.settings.dynamicEffort ?? DEFAULT_DYNAMIC_EFFORT_MODE;
	}

	setDynamicEffort(mode: DynamicEffortMode): void {
		this.setGlobalField("dynamicEffort", mode);
	}

	/** Opt out to pin recursion at the configured `rlmMaxDepth`. */
	getDynamicDepth(): boolean {
		return this.settings.dynamicDepth ?? true;
	}

	setDynamicDepth(enabled: boolean): void {
		this.setGlobalField("dynamicDepth", enabled);
	}

	getDynamicContext(): boolean {
		return this.settings.dynamicContext ?? true;
	}

	getToolTimeoutReplMs(): number {
		const value = this.settings.toolTimeouts?.replMs;
		return value !== undefined && value > 0 ? value : 120_000;
	}

	getToolTimeoutBashSeconds(): number {
		return this.settings.toolTimeouts?.bashSeconds ?? 0;
	}

	setDynamicContext(enabled: boolean): void {
		this.setGlobalField("dynamicContext", enabled);
	}

	/** Opt out only to inspect a collapse; the loop otherwise streams and is billed to max_tokens. */
	getDegeneracyGuard(): boolean {
		// Default off until the repetition rule stops firing on ordinary enumeration. A review
		// reproduced aborts on twelve bullets sharing a clause (700 chars) against genuine
		// degeneracy at 560 — a 1.25x margin. The validation corpus was static source files,
		// which structurally cannot contain generated lists, so the measured zero false
		// positives never covered the shape that breaks it. A guard that kills real answers is
		// worse than the failure it prevents; re-enable when the margin is real.
		return this.settings.degeneracyGuard ?? false;
	}

	setDegeneracyGuard(enabled: boolean): void {
		this.setGlobalField("degeneracyGuard", enabled);
	}

	/** Kill switch for the reasoning-loop guard; the protection itself is default-on. */
	getReasoningLoopGuard(): boolean {
		return this.settings.reasoningLoopGuard ?? true;
	}

	setReasoningLoopGuard(enabled: boolean): void {
		this.setGlobalField("reasoningLoopGuard", enabled);
	}

	/** Idle-watchdog over the shared todo board; settings + effective delay in ms. */
	getTodoWatchdogSettings(): { enabled: boolean; delayMs: number } {
		return {
			enabled: this.settings.todoWatchdogEnabled ?? true,
			delayMs: Math.max(0, this.settings.todoWatchdogDelaySeconds ?? 120) * 1000,
		};
	}
	getSubagentGraph(): boolean {
		return this.settings.subagentGraph ?? true;
	}

	setSubagentGraph(enabled: boolean): void {
		this.setGlobalField("subagentGraph", enabled);
	}

	getDefaultServiceTier(): ServiceTier {
		return this.settings.defaultServiceTier ?? "default";
	}

	setDefaultServiceTier(serviceTier: ServiceTier): void {
		this.setGlobalField("defaultServiceTier", serviceTier);
	}

	getRlmMaxDepth(): RlmMaxDepthValue | undefined {
		const value = this.globalSettings.rlmMaxDepth;
		return isRlmMaxDepthValue(value) ? value : undefined;
	}

	setRlmMaxDepth(maxDepth: RlmMaxDepthValue): void {
		this.setGlobalField("rlmMaxDepth", maxDepth);
	}

	/**
	 * Cap on concurrently running rlm subagents. A number pins the cap and skips memory
	 * sampling entirely (kill-switch); "auto" sizes it from a live sample at admission time.
	 */
	getMaxRunningAgents(): MaxRunningAgentsSetting {
		const value: unknown = this.settings.maxRunningAgents;
		if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
		return "auto";
	}

	setMaxRunningAgents(value: MaxRunningAgentsSetting): void {
		if (value !== "auto" && !(typeof value === "number" && Number.isInteger(value) && value >= 1)) {
			throw new Error('maxRunningAgents must be "auto" or a positive integer');
		}
		this.setGlobalField("maxRunningAgents", value);
	}

	/**
	 * Graph budget dial. Env wins over the settings file so a run can be escalated without
	 * editing configuration, mirroring how `RLM_MAX_DEPTH` behaves.
	 */
	getGraphResolver(): GraphResolverLevel {
		const fromEnv = process.env.GRAPH_RESOLVER?.trim().toLowerCase();
		if (isGraphResolverLevel(fromEnv)) return fromEnv;
		const configured: unknown = this.settings.graphResolver;
		return isGraphResolverLevel(configured) ? configured : DEFAULT_GRAPH_RESOLVER_LEVEL;
	}

	setGraphResolver(level: GraphResolverLevel): void {
		this.setGlobalField("graphResolver", level);
	}

	getGraphMaxTokens(): number | undefined {
		const value: unknown = this.settings.graphMaxTokens;
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	}

	setGraphMaxTokens(maxTokens: number): void {
		this.setGlobalField("graphMaxTokens", maxTokens);
	}

	getIdleEvictionMinutes(): number | "off" {
		const value: unknown = this.globalSettings.idleEvictionMinutes;
		if (value === "off" || value === "none") return "off";
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_IDLE_EVICTION_MINUTES;
	}

	setIdleEvictionMinutes(value: number | "off"): void {
		if (value !== "off" && (!Number.isFinite(value) || value <= 0)) {
			throw new Error("Idle eviction minutes must be a positive number or off");
		}
		this.setGlobalField("idleEvictionMinutes", value);
	}

	getReplPressureReapMb(): number {
		const value = this.settings.replPressureReapMb;
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 512;
	}

	getReplIdleTimeoutMinutes(): number | "off" {
		const value: unknown = this.settings.replIdleTimeoutMinutes;
		if (value === "off" || value === "none") return "off";
		return typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: DEFAULT_REPL_IDLE_TIMEOUT_MINUTES;
	}

	setReplIdleTimeoutMinutes(value: number | "off"): void {
		if (value !== "off" && (!Number.isFinite(value) || value <= 0)) {
			throw new Error("REPL idle timeout minutes must be a positive number or off");
		}
		this.setGlobalField("replIdleTimeoutMinutes", value);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.setGlobalField("transport", transport);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.ensureGlobalSection("compaction").enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getAgentTracesEnabled(): boolean {
		return this.settings.agentTraces?.enabled ?? false;
	}

	setAgentTracesEnabled(enabled: boolean): void {
		this.ensureGlobalSection("agentTraces").enabled = enabled;
		this.markModified("agentTraces", "enabled");
		this.save();
	}

	/**
	 * Telemetry is opt-in in this fork.
	 *
	 * Upstream defaults it on and posts to its own analytics endpoint. That is a reasonable
	 * default for the project that runs the endpoint and the wrong one for a fork: whoever runs
	 * this build is not whoever runs that server, so consent cannot be assumed on their behalf.
	 *
	 * Any scope that says `false` wins, so an opt-out is never overridden by a broader scope;
	 * otherwise one explicit `true` is enough to enable it. Point
	 * OPTIMUS_TELEMETRY_ENDPOINT at something you control before turning it on.
	 */
	getTelemetryEnabled(): boolean {
		const scopes = [
			this.globalSettings.telemetry?.enabled,
			this.projectSettings.telemetry?.enabled,
			this.runtimeOverrides.telemetry?.enabled,
		];
		if (scopes.some((value) => value === false)) return false;
		return scopes.some((value) => value === true);
	}

	private getOrCreateGlobalTelemetrySettings(): TelemetrySettings {
		const telemetry = this.globalSettings.telemetry;
		if (typeof telemetry !== "object" || telemetry === null || Array.isArray(telemetry)) {
			this.globalSettings.telemetry = {};
		}
		return this.globalSettings.telemetry!;
	}

	setTelemetryEnabled(enabled: boolean): void {
		this.getOrCreateGlobalTelemetrySettings().enabled = enabled;
		this.markModified("telemetry", "enabled");
		this.save();
	}

	getTelemetryNoticeShown(): boolean {
		return this.runtimeOverrides.telemetry?.noticeShown ?? this.globalSettings.telemetry?.noticeShown ?? false;
	}

	setTelemetryNoticeShown(shown: boolean): void {
		this.getOrCreateGlobalTelemetrySettings().noticeShown = shown;
		this.markModified("telemetry", "noticeShown");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionAgentCallable(): boolean {
		return this.settings.compaction?.agentCallable ?? true;
	}

	getCompactionMaxContextTokens(): number {
		return this.settings.compaction?.maxContextTokens ?? 666000;
	}

	getCompactionCompactAtTokens(): number {
		return this.settings.compaction?.compactAtTokens ?? 500000;
	}

	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		maxContextTokens: number;
		compactAtTokens: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
			maxContextTokens: this.getCompactionMaxContextTokens(),
			compactAtTokens: this.getCompactionCompactAtTokens(),
		};
	}
	getAutoRefineSettings(): { enabled: boolean; turnInterval: number; compact: boolean; cooldownMs: number } {
		const turnInterval = this.settings.autoRefine?.turnInterval;
		const cooldownMs = this.settings.autoRefine?.cooldownMs;
		return {
			enabled: this.settings.autoRefine?.enabled ?? true,
			turnInterval: Math.max(
				1,
				typeof turnInterval === "number" && Number.isFinite(turnInterval) ? turnInterval : 25,
			),
			compact: this.settings.autoRefine?.compact ?? true,
			cooldownMs: Math.max(
				0,
				typeof cooldownMs === "number" && Number.isFinite(cooldownMs) ? cooldownMs : 20 * 60_000,
			),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.ensureGlobalSection("retry").enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 5,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
			maxDelayMs: this.settings.retry?.maxDelayMs ?? 60000,
		};
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setGlobalField("hideThinkingBlock", hide);
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.setGlobalField("shellPath", path);
	}

	/** Start-up brand animation and sound. default: true */
	getIgnition(): boolean {
		return this.settings.ignition ?? true;
	}

	setIgnition(enabled: boolean): void {
		this.setGlobalField("ignition", enabled);
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.setGlobalField("quietStartup", quiet);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.setGlobalField("shellCommandPrefix", prefix);
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.setGlobalField("npmCommand", command === undefined ? undefined : [...command]);
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.setGlobalField("packages", packages);
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.setProjectListField("packages", packages);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.setGlobalField("extensions", paths);
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.setProjectListField("extensions", paths);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.setGlobalField("skills", paths);
	}

	setProjectSkillPaths(paths: string[]): void {
		this.setProjectListField("skills", paths);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.setGlobalField("prompts", paths);
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.setProjectListField("prompts", paths);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.setGlobalField("themes", paths);
	}

	setProjectThemePaths(paths: string[]): void {
		this.setProjectListField("themes", paths);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.setGlobalField("enableSkillCommands", enabled);
	}

	getBundledSkills(): { websearch: boolean } {
		return {
			websearch: this.settings.bundledSkills?.websearch ?? true,
		};
	}

	getBundledWebsearchEnabled(): boolean {
		return this.getBundledSkills().websearch;
	}

	getEnableBuiltinSkills(): boolean {
		return this.settings.enableBuiltinSkills ?? true;
	}

	setEnableBuiltinSkills(enabled: boolean): void {
		this.setGlobalField("enableBuiltinSkills", enabled);
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		this.ensureGlobalSection("terminal").showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getClearOnShrink(): boolean {
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return isTruthyEnvVar(process.env.PI_CLEAR_ON_SHRINK);
	}

	setClearOnShrink(enabled: boolean): void {
		this.ensureGlobalSection("terminal").clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getFullscreen(): boolean {
		if (process.env.PI_FULLSCREEN !== undefined) {
			return isTruthyEnvVar(process.env.PI_FULLSCREEN);
		}
		return this.settings.terminal?.fullscreen ?? true;
	}

	setFullscreen(enabled: boolean): void {
		this.ensureGlobalSection("terminal").fullscreen = enabled;
		this.markModified("terminal", "fullscreen");
		this.save();
	}

	getFullscreenMouse(): boolean {
		return this.settings.terminal?.fullscreenMouse ?? true;
	}

	setFullscreenMouse(enabled: boolean): void {
		this.ensureGlobalSection("terminal").fullscreenMouse = enabled;
		this.markModified("terminal", "fullscreenMouse");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		this.ensureGlobalSection("terminal").showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		this.ensureGlobalSection("images").autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		this.ensureGlobalSection("images").blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getMcpServers(): Record<string, McpServerConfig> | undefined {
		return this.settings.mcpServers;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.setGlobalField("enabledModels", patterns);
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "user-only";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.setGlobalField("treeFilterMode", mode);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? isTruthyEnvVar(process.env.PI_HARDWARE_CURSOR);
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.setGlobalField("showHardwareCursor", enabled);
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.setGlobalField("editorPaddingX", Math.max(0, Math.min(3, Math.floor(padding))));
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.setGlobalField("autocompleteMaxVisible", Math.max(3, Math.min(20, Math.floor(maxVisible))));
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.setGlobalField("warnings", { ...warnings });
	}
}
