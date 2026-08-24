// Shared scaffolding for the daemon test suites (daemon-mode, daemon-supervisor-monitor,
// agent-connection-daemon). Everything here drives private internals of the daemon classes on
// purpose; types are deliberately loose so call sites stay one-liners.
import { vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionMessageController } from "../../src/core/agent-messages.js";
import type { AgentObserveController } from "../../src/core/agent-observe.js";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore } from "../../src/core/cron-jobs.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../../src/core/rlm-runtime.js";
import { type SessionInfo, SessionManager } from "../../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import type { SessionSummary } from "../../src/modes/daemon/daemon-session-list.js";

export { waitFor } from "../suite/helpers.js";

/** Polls until the file exists or the deadline passes, then throws. */
export async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

/** Resolves once the child process has exited, immediately if it already has. */
export async function waitForChildClose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
}

/**
 * Runs `fn` with a fresh mkdtemp directory and removes it afterwards.
 * Replaces the mkdtempSync / try / finally-rmSync boilerplate repeated across the daemon suites.
 */
export async function withTempDir<T>(label: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), label));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Creates a fresh mkdtemp directory the caller must remove (for sync test bodies). */
export function tempDir(label: string): string {
	return mkdtempSync(join(tmpdir(), label));
}

/**
 * Typed window into AgentDaemon private internals. Members whose results tests consume,
 * that tests call with arguments, or that receive typed mocks carry real signatures; the
 * Function-keyed index half keeps every remaining ad-hoc internal access a plain property
 * read instead of a per-test cast block. (`(...args: never[]) => unknown` is the top type
 * for functions: every concrete function is assignable to it, including Bun's `vi.fn()`
 * mocks, which keeps mock swaps one-liners.)
 */
export type DaemonInternals = {
	[key: string]: (...args: never[]) => unknown;
} & {
	sessions: Map<string, ActiveSessionState>;
	clients: Set<DaemonSocketClient>;
	closingSessions: Map<string, { promise: Promise<void>; reason: string }>;
	openingSessions: Map<string, Promise<unknown>>;
	reservingSessionOpens: Map<string, Promise<unknown>>;
	bindingSessions: Map<string, Promise<unknown>>;
	passivatingSessions: Map<string, Promise<void>>;
	promptAdmissions: Map<
		string,
		{
			activeSessionId: string;
			admissionId: string;
			controller?: AbortController;
			status: "waiting" | "owned" | "cancelled";
		}
	>;
	supervisorClaims: Map<DaemonSocketClient, { claim: Record<string, unknown>; ownerFingerprint: string }>;
	updateRestart?: { phase?: string };
	agentMessageAcceptingTargets: Set<string>;
	agentMessagePreparingTargets: Set<string>;
	agentMessageTargetLocks: Map<string, Promise<void>>;
	agentMessageRateLimiter: { clear(): void };
	remoteAgentPeers: Map<string, unknown>;
	rlmSpawnLedgerInstance?: unknown;
	cronStore: AgentCronJobStore;
	cronScheduler: { runDue(now: Date): Promise<number> };

	createRuntime(command: object): Promise<ActiveSessionState>;
	createRlmSubagentRuntime(
		parentState: ActiveSessionState,
		options: CreateRlmSubagentRuntimeOptions,
	): Promise<{ session: AgentSession }>;
	createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost;
	createAgentMessageController(getState: () => ActiveSessionState): AgentSessionMessageController;
	createAgentObserveController(getState: () => ActiveSessionState): AgentObserveController;
	listPassiveRlmSubagents(): Promise<PassiveRlmSubagentFixture[]>;
	findPassiveRlmSubagent(target: string): Promise<PassiveRlmSubagentFixture | undefined>;
	hydratePassiveRlmSubagent(
		passive: PassiveRlmSubagentFixture,
		clientEnv?: Record<string, string>,
	): Promise<ActiveSessionState>;
	getOrCreateCronJobSession(heartbeat: AgentCronJob, allowCreate: boolean): Promise<ActiveSessionState>;
	restoreRlmHeartbeatSession(heartbeat: AgentCronJob): Promise<ActiveSessionState>;
	getOrHydrateBoundSessionState(selector: string): Promise<ActiveSessionState>;
	getBoundSessionState(selector: string): ActiveSessionState;
	waitForBoundSession(state: ActiveSessionState): Promise<ActiveSessionState>;
	setStateSessionName(state: ActiveSessionState, name: string): Promise<void>;
	assertStateSessionNameAvailable(state: ActiveSessionState, name: string): Promise<void>;
	createAgentFamilyRoster(state: ActiveSessionState): unknown;
	closeSession(state: ActiveSessionState, reason: string, ...rest: unknown[]): Promise<unknown>;
	sendAgentSessionMessage(options: object): Promise<unknown>;
	sendRemoteAgentSessionMessage(source: ActiveSessionState, targetSelector: string, message: string): Promise<unknown>;
	createAgentMessageListResult(state: ActiveSessionState): Promise<{
		agents: Array<{ activeSessionId: string; unfinishedActionCount?: number }>;
	}>;
	createAgentObserveListResult(state: ActiveSessionState): Promise<{ current: { status: string } }>;
	createAgentMessageAgentSummary(state: ActiveSessionState): { status: string };
	buildSessionListWithPassiveRlmSubagents(
		states: readonly object[],
		savedSessions: readonly SessionInfo[],
		scheduledJobs: readonly object[],
	): Promise<SessionSummary[]>;
	buildRlmChildSnapshotsWithPassiveRlmSubagents(parentState: ActiveSessionState): Promise<unknown[]>;
	handleCommand(client: DaemonSocketClient, command: object): Promise<unknown>;
	handleLine(client: DaemonSocketClient, line: string): unknown;
	handleConnection(socket: Socket): void;
	queueClientCatchup(client: DaemonSocketClient, activeSessionId: string, reason?: string): void;
	catchUpBackpressuredClient(client: DaemonSocketClient): Promise<unknown>;
	drainBackpressuredClientCatchups(client: DaemonSocketClient): Promise<unknown>;
	broadcastToSession(state: ActiveSessionState, event: object): void;
	parseCommandAndRegisterPromptAdmission(client: DaemonSocketClient, line: string): void;
	abortWaitingPromptAdmissionsForSession(activeSessionId: string): void;
	promptWithAgentMessagePreparingGuard(state: ActiveSessionState, message: string): Promise<unknown>;
	runCronJob(heartbeat: AgentCronJob): Promise<unknown>;
	passivateIdleChildren(idleEvictionMinutes: number, now: number, limit: number): Promise<number>;
	updateRlmHeartbeatForState(state: ActiveSessionState, update: object): unknown;
	assertAgentFamilyReachable(from: ActiveSessionState, to: ActiveSessionState): void;
	isAgentFamilyReachable(from: ActiveSessionState, to: ActiveSessionState): unknown;
	agentFamilyEntry(state: ActiveSessionState): unknown;
	agentMessageRelationship(from: ActiveSessionState, to: ActiveSessionState): unknown;
};

/** Structural shape of a passive RLM child as the daemon hands it to hydration paths. */
export interface PassiveRlmSubagentFixture {
	rootParentState?: ActiveSessionState;
	rootInfo?: SessionInfo;
	entry: {
		childId: string;
		sessionFile: string;
		sessionName?: string;
		prompt?: string;
		rlmMaxDepth?: number;
		status?: string;
	};
	info: { id: string; name?: string };
	chain: Array<{ childId: string; sessionFile: string }>;
}

export function daemonInternals(daemon: AgentDaemon): DaemonInternals {
	return daemon as unknown as DaemonInternals;
}

export interface MakeDaemonOptions {
	socketPath?: string;
	agentDir?: string;
	cwd?: string;
	sessionDir?: string;
	createRuntime?: CreateAgentSessionRuntimeFactory | ReturnType<typeof vi.fn>;
	worker?: Record<string, unknown>;
}

/**
 * Constructs an AgentDaemon whose runtime factory always throws, for suites that
 * only exercise internal bookkeeping and must never create a real runtime.
 */
export function stubDaemon(options: Omit<MakeDaemonOptions, "createRuntime"> = {}): AgentDaemon {
	return makeDaemon({
		...options,
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
}

/** Constructs an AgentDaemon with the option defaults every suite repeats. */
export function makeDaemon(options: MakeDaemonOptions = {}): AgentDaemon {
	const config: Record<string, unknown> = {
		agentDir: options.agentDir ?? "/tmp",
		cwd: options.cwd ?? "/tmp",
	};
	if (options.sessionDir) config.sessionDir = options.sessionDir;
	return new AgentDaemon(options.socketPath ?? "/tmp/optimus-harness-daemon.sock", {
		defaultSessionConfig: config as never,
		createRuntime: (options.createRuntime ?? vi.fn()) as never,
		...(options.worker ? { worker: options.worker as never } : {}),
	});
}

// ---------------------------------------------------------------------------
// Active-session / client fixtures (moved from daemon-mode.test.ts)
// ---------------------------------------------------------------------------

export function makeState(activeSessionId: string, parentActiveSessionId?: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		runtime: {
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId,
			},
		},
	} as unknown as ActiveSessionState;
}

export function makeClient(id: string, activeSessionId: string, supportsExtensionUi = false): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi,
		capabilities: new Set(supportsExtensionUi ? ["extension_ui"] : []),
	};
}

export function makeRuntimeSession(
	sessionManager: Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionManager"],
): Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"] {
	return {
		sessionManager,
		messages: [],
		extensionRunner: {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn(async () => {}),
		},
		sessionFile: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
		get sessionName() {
			return sessionManager.getSessionName();
		},
		setSubagentRuntimeHost: vi.fn(),
		getRlmChildRunStatus: vi.fn(() => "running"),
		registerRlmChildSession: vi.fn(() => true),
		releaseRlmChildSession: vi.fn(() => vi.fn()),
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn(async () => {}),
		setExecEnvProvider: vi.fn(),
		getAvailableThinkingLevels: vi.fn(() => []),
		scopedModels: [],
		getActiveToolNames: vi.fn(() => []),
		getContextUsage: vi.fn(() => undefined),
		setSessionName: vi.fn((name: string) => sessionManager.appendSessionInfo(name)),
		dispose: vi.fn(),
		disposeAsync: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	} as unknown as Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"];
}

export function makeAgentFamilyState(
	activeSessionId: string,
	sessionName: string,
	parent?: ActiveSessionState,
): { state: ActiveSessionState; acceptAgentMessagePrompt: ReturnType<typeof vi.fn> } {
	const state = makeState(activeSessionId, parent?.activeSessionId);
	const acceptAgentMessagePrompt = vi.fn(
		(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			options?.preflightResult?.(true);
			return Promise.resolve();
		},
	);
	const parentSessionId = parent?.runtime.session.sessionId;
	state.runtime = {
		...state.runtime,
		cwd: "/tmp",
		diagnostics: [],
		metadata: {
			kind: parent ? "subagent" : "top-level",
			createdAt: 1,
			...(parent ? { parentActiveSessionId: parent.activeSessionId, parentSessionId } : {}),
		},
		session: {
			sessionId: `session-${activeSessionId}`,
			sessionName,
			runtimeKind: parent ? "subagent" : "top-level",
			rlmDepth: parent ? (parent.runtime.session.rlmDepth ?? 0) + 1 : 0,
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isRetrying: false,
			isSessionActive: false,
			hasAcceptedPromptInFlight: false,
			unfinishedActionCount: 0,
			messages: [],
			state: { pendingToolCalls: new Set(), streamingMessage: undefined },
			sessionManager: {
				getCwd: () => "/tmp",
				getHeader: () => ({ created: new Date(0).toISOString() }),
			},
			hasRunningRlmChildren: () => false,
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			acceptAgentMessagePrompt,
		},
	} as never;
	return { state, acceptAgentMessagePrompt };
}

export function makeCronJob(input: {
	id: string;
	source: AgentCronJob["source"];
	activeSessionId: string;
	deliveryMode?: AgentCronJob["deliveryMode"];
}): AgentCronJob {
	return {
		id: input.id,
		status: "active",
		source: input.source,
		...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
		activeSessionId: input.activeSessionId,
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "heartbeat prompt",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T12:00:00.000Z",
		updatedAt: "2026-01-01T12:00:00.000Z",
		nextRunAt: "2026-01-01T12:05:00.000Z",
		runCount: 0,
	};
}

/**
 * Applies session/runtime fixture fields onto an existing ActiveSessionState.
 * Only the keys present in options are written; everything else is left untouched,
 * so conversions from literal `state.runtime = {...} as never` blocks stay exact.
 * The `session` and `runtime` merges run last so tests can override or extend anything.
 */
export interface SessionFixtureOptions {
	sessionId?: string;
	sessionName?: string;
	depth?: number;
	sessionFile?: string;
	kind?: "top-level" | "subagent";
	parentActiveSessionId?: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
	cwd?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	isBashRunning?: boolean;
	isRetrying?: boolean;
	isSessionActive?: boolean;
	hasAcceptedPromptInFlight?: boolean;
	unfinishedActionCount?: number;
	hasPendingSessionWork?: boolean;
	header?: unknown;
	acceptAgentMessagePrompt?: unknown;
	prompt?: unknown;
	promptHeartbeat?: unknown;
	followUp?: unknown;
	removeQueuedFollowUp?: unknown;
	session?: Record<string, unknown>;
	runtime?: Record<string, unknown>;
}

export function applySession(state: ActiveSessionState, options: SessionFixtureOptions = {}): ActiveSessionState {
	const session: Record<string, unknown> = {
		...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		...(options.sessionName !== undefined ? { sessionName: options.sessionName } : {}),
		...(options.depth !== undefined ? { rlmDepth: options.depth } : {}),
		...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
		...(options.header !== undefined ? { sessionManager: { getHeader: () => options.header } } : {}),
		...(options.isStreaming !== undefined ? { isStreaming: options.isStreaming } : {}),
		...(options.isCompacting !== undefined ? { isCompacting: options.isCompacting } : {}),
		...(options.isBashRunning !== undefined ? { isBashRunning: options.isBashRunning } : {}),
		...(options.isRetrying !== undefined ? { isRetrying: options.isRetrying } : {}),
		...(options.isSessionActive !== undefined ? { isSessionActive: options.isSessionActive } : {}),
		...(options.hasAcceptedPromptInFlight !== undefined
			? { hasAcceptedPromptInFlight: options.hasAcceptedPromptInFlight }
			: {}),
		...(options.unfinishedActionCount !== undefined ? { unfinishedActionCount: options.unfinishedActionCount } : {}),
		...(options.hasPendingSessionWork !== undefined ? { hasPendingSessionWork: options.hasPendingSessionWork } : {}),
		...(options.acceptAgentMessagePrompt ? { acceptAgentMessagePrompt: options.acceptAgentMessagePrompt } : {}),
		...(options.prompt ? { prompt: options.prompt } : {}),
		...(options.promptHeartbeat ? { promptHeartbeat: options.promptHeartbeat } : {}),
		...(options.followUp ? { followUp: options.followUp } : {}),
		...(options.removeQueuedFollowUp ? { removeQueuedFollowUp: options.removeQueuedFollowUp } : {}),
		...options.session,
	};
	state.runtime = {
		...state.runtime,
		metadata: {
			...(state.runtime as unknown as { metadata?: Record<string, unknown> }).metadata,
			...(options.kind !== undefined ? { kind: options.kind } : {}),
			...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
			...(options.metadata ?? {}),
		},
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		session,
		...options.runtime,
	} as never;
	return state;
}

/** Creates a fresh ActiveSessionState with the given session fixture fields. */
export function sessionFixture(activeSessionId: string, options: SessionFixtureOptions = {}): ActiveSessionState {
	return applySession(makeState(activeSessionId, options.parentActiveSessionId), options);
}

export function makePersistedRlmDaemonFixture(
	tempDir: string,
	options: {
		childRuntimeStarted?: () => void;
		childRuntimeGate?: Promise<void>;
		childBindingStarted?: () => void;
		childBindingGate?: Promise<void>;
		grandchildRuntimeStarted?: () => void;
		grandchildRuntimeGate?: Promise<void>;
		childDisposeStarted?: () => void;
		childDisposeGate?: Promise<void>;
		childAdmissionStarted?: () => void;
		childAdmissionGate?: Promise<void>;
	} = {},
) {
	const sessionDir = join(tempDir, "sessions");
	const parentManager = SessionManager.create(tempDir, sessionDir);
	parentManager.newSession();
	parentManager.appendSessionInfo("Parent");
	parentManager.appendSessionState({ status: "active" });
	const parentSessionFile = parentManager.getSessionFile();
	const parentArtifactDir = parentManager.getSessionArtifactDir();
	if (!parentSessionFile || !parentArtifactDir) {
		throw new Error("Missing parent session paths");
	}

	const childId = "child-1";
	const childSessionDir = join(parentArtifactDir, "sub-1234abcd");
	const childManager = SessionManager.create(tempDir, childSessionDir);
	childManager.newSession({ parentSession: parentSessionFile });
	childManager.appendSessionInfo("spawn-worker");
	childManager.appendSessionInfo("renamed-worker");
	childManager.appendMessage({ role: "user", content: "complete this task", timestamp: 1 });
	childManager.flushNow();
	const childSessionFile = childManager.getSessionFile();
	const childArtifactDir = childManager.getSessionArtifactDir();
	if (!childSessionFile || !childArtifactDir) {
		throw new Error("Missing child session paths");
	}
	const grandchildId = "grandchild-1";
	mkdirSync(childArtifactDir, { recursive: true });
	const grandchildSessionDir = join(childSessionDir, "sub-deadbeef");
	const grandchildManager = SessionManager.create(tempDir, grandchildSessionDir);
	grandchildManager.newSession({ parentSession: childSessionFile });
	grandchildManager.appendSessionInfo("nested-worker");
	grandchildManager.appendMessage({ role: "user", content: "complete the nested task", timestamp: 2 });
	grandchildManager.flushNow();
	const grandchildSessionFile = grandchildManager.getSessionFile();
	if (!grandchildSessionFile) throw new Error("Missing grandchild session file");
	writeFileSync(
		join(childArtifactDir, "rlm-subagents.jsonl"),
		`${JSON.stringify({
			type: "rlm_subagent",
			childId: grandchildId,
			sessionName: "nested-worker",
			sessionDir: grandchildSessionDir,
			sessionFile: grandchildSessionFile,
			parentSessionId: childManager.getSessionId(),
			parentSessionFile: childSessionFile,
			rlmDepth: 2,
			rlmMaxDepth: 4,
			rlmParentNodeId: grandchildId,
			status: "completed",
			createdAt: 2,
			updatedAt: "2026-01-01T00:00:01.000Z",
		})}
`,
	);
	writeFileSync(
		join(parentArtifactDir, "rlm-subagents.jsonl"),
		`${JSON.stringify({
			type: "rlm_subagent",
			childId,
			sessionName: "spawn-worker",
			sessionDir: childSessionDir,
			sessionFile: childSessionFile,
			parentSessionId: parentManager.getSessionId(),
			parentSessionFile,
			rlmDepth: 1,
			rlmMaxDepth: 4,
			rlmParentNodeId: childId,
			status: "completed",
			createdAt: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		})}
`,
	);

	const acceptAgentMessagePrompt = vi.fn(
		async (_message: string, promptOptions?: { preflightResult?: (didSucceed: boolean) => void }) => {
			if (options.childAdmissionGate) {
				options.childAdmissionStarted?.();
				await options.childAdmissionGate;
			}
			promptOptions?.preflightResult?.(true);
		},
	);
	const runtimeSessions: Array<ReturnType<typeof makeRuntimeSession>> = [];
	const createRuntime = vi.fn(async (runtimeOptions: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
		const sessionFile = runtimeOptions.sessionManager.getSessionFile();
		const isChild = sessionFile === childSessionFile;
		const isGrandchild = sessionFile === grandchildSessionFile;
		if (isChild && options.childRuntimeGate) {
			options.childRuntimeStarted?.();
			await options.childRuntimeGate;
		}
		if (isGrandchild && options.grandchildRuntimeGate) {
			options.grandchildRuntimeStarted?.();
			await options.grandchildRuntimeGate;
		}
		const runtimeSession = makeRuntimeSession(runtimeOptions.sessionManager);
		runtimeSessions.push(runtimeSession);
		if (isChild && options.childBindingGate) {
			runtimeSession.bindExtensions = vi.fn(async () => {
				options.childBindingStarted?.();
				await options.childBindingGate;
			});
		}
		if (isChild && options.childDisposeGate) {
			runtimeSession.disposeAsync = vi.fn(async () => {
				options.childDisposeStarted?.();
				await options.childDisposeGate;
			});
		}
		Object.assign(runtimeSession, {
			isStreaming: false,
			isCompacting: false,
			isSessionActive: false,
			unfinishedActionCount: 0,
			state: { pendingToolCalls: new Set() },
			hasRunningRlmChildren: () => false,
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			acceptAgentMessagePrompt,
		});
		return {
			session: runtimeSession,
			extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
				ReturnType<CreateAgentSessionRuntimeFactory>
			>["extensionsResult"],
			services: { cwd: runtimeOptions.cwd, agentDir: runtimeOptions.agentDir } as Awaited<
				ReturnType<CreateAgentSessionRuntimeFactory>
			>["services"],
			diagnostics: [],
		};
	});
	const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
		defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
		createRuntime,
	});
	return {
		daemon,
		createRuntime,
		runtimeSessions,
		acceptAgentMessagePrompt,
		parentSessionFile,
		parentArtifactDir,
		parentSessionId: parentManager.getSessionId(),
		childId,
		childSessionFile,
		childSessionDir,
		childArtifactDir,
		grandchildId,
		grandchildSessionFile,
	};
}

/** Registers states on the internal session map of a daemon. */
export function registerSessions(daemon: AgentDaemon, ...states: ActiveSessionState[]): void {
	const internals = daemonInternals(daemon);
	for (const state of states) internals.sessions.set(state.activeSessionId, state);
}
