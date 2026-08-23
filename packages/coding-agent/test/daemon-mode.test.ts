import { describe, expect, it, vi } from "bun:test";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	AGENT_FAMILY_REACH_ERROR,
	type AgentSessionMessageController,
	DEFAULT_AGENT_MESSAGE_MAX_CHARS,
	sessionNameReservationKey,
} from "../src/core/agent-messages.js";
import type { AgentObserveController } from "../src/core/agent-observe.js";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createDefaultRlmSubagentSessionName,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	cancelPendingExtensionUiRequests,
	detachClientFromActiveSession,
	finishClientSnapshotStreaming,
	getChildActiveSessionStates,
	markClientSnapshotStreaming,
	setDaemonClientSessionCapabilities,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	failure,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DAEMON_WORKER_SUPERVISOR_SOCKET_ENV } from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import {
	applySession,
	daemonInternals,
	makeAgentFamilyState,
	makeClient,
	makeCronJob,
	makeDaemon,
	makePersistedRlmDaemonFixture,
	makeRuntimeSession,
	makeState,
	stubDaemon,
	withTempDir,
} from "./helpers/daemon-harness.js";

describe("daemon mode helpers", () => {
	it("preserves envelope client identity while registering prompt admission", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/unused-daemon.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const client = makeClient("worker-socket", "active");
		const parse = Reflect.get(daemon, "parseCommandAndRegisterPromptAdmission").bind(daemon);

		parse(client, JSON.stringify(createDaemonCommandEnvelope({ type: "list" }, "request-1", "public-client")));
		expect(client.id).toBe("public-client");
	});

	it("normalizes daemon session names before validation and persistence", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/unused-daemon.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const setSessionName = vi.fn();
		const state = makeState("active");
		state.runtime = {
			...state.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: { setSessionName },
		} as never;
		const assertStateSessionNameAvailable = vi.fn(async () => {});
		const internals = daemonInternals(daemon);
		internals.assertStateSessionNameAvailable = assertStateSessionNameAvailable;

		await internals.setStateSessionName(state, "  normalized  ");

		expect(assertStateSessionNameAvailable).toHaveBeenCalledWith(state, "normalized");
		expect(setSessionName).toHaveBeenCalledWith("normalized");
		await expect(internals.setStateSessionName(state, "   ")).rejects.toThrow("Session name cannot be empty");
		expect(setSessionName).toHaveBeenCalledOnce();
	});

	it("treats a depth-zero fork as a sibling of another root", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-fork-family.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const fork = makeState("fork");
		applySession(fork, {
			kind: "top-level",
			parentSessionId: "fork-origin",
			sessionId: "session-fork",
			sessionFile: "/tmp/fork.jsonl",
			depth: 0,
			metadata: { parentSessionFile: "/tmp/fork-origin.jsonl" },
			session: { sessionManager: { getHeader: () => ({ parentSession: "/tmp/fork-origin.jsonl" }) } },
		});
		const root = makeState("root");
		applySession(root, {
			kind: "top-level",
			sessionId: "session-root",
			sessionFile: "/tmp/root.jsonl",
			depth: 0,
		});
		const internals = daemonInternals(daemon);

		expect(internals.agentFamilyEntry(fork)).not.toHaveProperty("parentSessionId");
		expect(internals.agentFamilyEntry(fork)).not.toHaveProperty("parentSessionPath");
		expect(internals.isAgentFamilyReachable(root, fork)).toBe(true);
		expect(internals.isAgentFamilyReachable(fork, root)).toBe(true);
	});

	it("finds only direct child active sessions", () => {
		const parent = makeState("parent");
		const child = makeState("child", "parent");
		const grandchild = makeState("grandchild", "child");
		const sibling = makeState("sibling");
		const selfLinked = makeState("self-linked", "self-linked");
		const sessions = new Map<string, ActiveSessionState>(
			[parent, child, grandchild, sibling, selfLinked].map((state) => [state.activeSessionId, state]),
		);

		expect(getChildActiveSessionStates(sessions, parent).map((state) => state.activeSessionId)).toEqual(["child"]);
	});

	it("cancels pending extension UI requests when the last client detaches", () => {
		const firstClient = makeClient("client-1", "active");
		const secondClient = makeClient("client-2", "active");
		const firstResolve = vi.fn();
		const secondResolve = vi.fn();
		const state = {
			...makeState("active"),
			clients: new Set<DaemonSocketClient>([firstClient, secondClient]),
			extensionUiRequests: new Map([
				["request-1", { resolve: firstResolve }],
				["request-2", { resolve: secondResolve }],
			]),
		};

		detachClientFromActiveSession(firstClient, state);

		expect(state.extensionUiRequests.size).toBe(2);
		expect(firstResolve).not.toHaveBeenCalled();
		expect(firstClient.attachedActiveSessionIds.has("active")).toBe(false);

		detachClientFromActiveSession(secondClient, state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(firstResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondClient.attachedActiveSessionIds.has("active")).toBe(false);
	});

	it("cancels pending extension UI requests directly", () => {
		const resolve = vi.fn();
		const state = {
			...makeState("active"),
			extensionUiRequests: new Map([["request-1", { resolve }]]),
		};

		cancelPendingExtensionUiRequests(state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(resolve).toHaveBeenCalledWith({ cancelled: true });
	});

	it("acknowledges agent messages after target prompt preflight succeeds", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					sessionId: string;
					sessionName: string;
					isStreaming: boolean;
					unfinishedActionCount: number;
					acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
				};
			};
		};
		let resolvePrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			},
		);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			session: { sessionActions: { queuedCount: 0, steering: [], followUps: [] }, acceptAgentMessagePrompt },
		});
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "please continue",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		resolvePrompt();
		await expect(send).resolves.toMatchObject({
			deliveryStatus: "delivered",
			target: { activeSessionId: targetState.activeSessionId },
		});
	});

	it("classifies local roster status with heartbeat and running-child activity", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-status-test.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const state = makeState("local-active");
		let hasRunningChildren = true;
		applySession(state, {
			cwd: "/tmp",
			kind: "top-level",
			sessionId: "local-session",
			isSessionActive: false,
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { hasRunningRlmChildren: () => hasRunningChildren },
		});
		const internals = daemonInternals(daemon);
		const getHeartbeat = vi.spyOn(internals.cronStore, "getHeartbeat").mockReturnValue(undefined);
		const listRlmHeartbeats = vi.spyOn(internals.cronStore, "listRlmHeartbeats").mockReturnValue([]);

		expect(internals.createAgentMessageAgentSummary(state).status).toBe("running");
		hasRunningChildren = false;
		applySession(state, { kind: "subagent", metadata: { createdAt: 1 } });
		expect(internals.createAgentMessageAgentSummary(state).status).toBe("idle");
		getHeartbeat.mockReturnValue({ status: "active" } as AgentCronJob);
		expect(internals.createAgentMessageAgentSummary(state).status).toBe("running");
		getHeartbeat.mockReturnValue(undefined);
		listRlmHeartbeats.mockReturnValue([{ status: "active" } as AgentCronJob]);
		expect(internals.createAgentMessageAgentSummary(state).status).toBe("running");
	});

	it("reserves a session name across equivalent session-relative parent headers", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-name-reservation.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const first = makeState("first");
		const second = makeState("second");
		applySession(first, {
			sessionId: "first-session",
			sessionFile: "/tmp/children/first.jsonl",
			depth: 1,
			session: {
				sessionManager: { getHeader: vi.fn(() => ({ parentSession: "../parent.jsonl" })) },
				setSessionName: vi.fn(),
			},
		});
		applySession(second, {
			sessionId: "second-session",
			sessionFile: "/tmp/children/nested/second.jsonl",
			depth: 1,
			session: {
				sessionManager: { getHeader: vi.fn(() => ({ parentSession: "../../parent.jsonl" })) },
				setSessionName: vi.fn(),
			},
		});
		let releaseValidation!: () => void;
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		const internals = daemonInternals(daemon);
		internals.assertStateSessionNameAvailable = vi.fn(async () => validationGate);

		const firstRename = internals.setStateSessionName(first, "shared");
		await expect(internals.setStateSessionName(second, "shared")).rejects.toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);
		releaseValidation();
		await expect(firstRename).resolves.toBeUndefined();
		expect(first.runtime.session.setSessionName).toHaveBeenCalledWith("shared");
		expect(second.runtime.session.setSessionName).not.toHaveBeenCalled();
	});

	it("allows concurrent same-name renames under different parents", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-scoped-name-reservation.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const first = makeState("first", "parent-a");
		const second = makeState("second", "parent-b");
		first.runtime = {
			...first.runtime,
			metadata: { ...first.runtime.metadata, parentSessionId: "parent-session-a" },
			session: {
				sessionId: "first-session",
				rlmDepth: 1,
				sessionManager: { getHeader: vi.fn(() => undefined) },
				setSessionName: vi.fn(),
			},
		} as never;
		second.runtime = {
			...second.runtime,
			metadata: { ...second.runtime.metadata, parentSessionId: "parent-session-b" },
			session: {
				sessionId: "second-session",
				rlmDepth: 1,
				sessionManager: { getHeader: vi.fn(() => undefined) },
				setSessionName: vi.fn(),
			},
		} as never;
		let releaseValidation!: () => void;
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		const internals = daemonInternals(daemon);
		internals.assertStateSessionNameAvailable = vi.fn(async () => validationGate);

		const firstRename = internals.setStateSessionName(first, "worker");
		const secondRename = internals.setStateSessionName(second, "worker");
		await vi.waitFor(() => expect(internals.assertStateSessionNameAvailable).toHaveBeenCalledTimes(2));
		releaseValidation();

		await expect(Promise.all([firstRename, secondRename])).resolves.toEqual([undefined, undefined]);
		expect(first.runtime.session.setSessionName).toHaveBeenCalledWith("worker");
		expect(second.runtime.session.setSessionName).toHaveBeenCalledWith("worker");
	});

	it("scopes a switched child rename from its session-relative persisted parent header", async () => {
		await withTempDir("optimus-switched-child-name-", async (tempDir) => {
			const parentPath = join(tempDir, "parent.jsonl");
			const childDir = join(tempDir, "child");
			const childPath = join(childDir, "child.jsonl");
			mkdirSync(childDir);
			writeFileSync(parentPath, "");
			const state = makeState("switched-child");
			applySession(state, {
				kind: "top-level",
				sessionId: "session-child",
				sessionFile: childPath,
				depth: 1,
				session: { sessionManager: { getHeader: () => ({ parentSession: "../parent.jsonl" }) } },
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: vi.fn(),
			});
			const internals = daemonInternals(daemon);
			internals.createAgentFamilyCatalog = vi.fn(async () => [
				{
					id: "sibling",
					name: "taken",
					depth: 1,
					status: "idle",
					parentSessionPath: canonicalSessionPath(parentPath),
				},
			]);

			await expect(internals.assertStateSessionNameAvailable(state, "taken")).rejects.toThrow(
				"an agent of that name already exists at depth 1 under this parent",
			);
		});
	});

	it("keeps fresh local rows over stale synced peers in the family catalog", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-local-precedence.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const state = makeState("local-active");
		applySession(state, {
			cwd: "/tmp",
			kind: "top-level",
			sessionId: "shared-session",
			sessionName: "fresh-local",
			isSessionActive: false,
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { hasRunningRlmChildren: () => false },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.remoteAgentPeers.set("stale-active", {
			activeSessionId: "stale-active",
			sessionId: "shared-session",
			sessionName: "stale-peer",
			runtimeKind: "top-level",
			cwd: "/tmp",
			isStreaming: false,
			unfinishedActionCount: 0,
		});
		const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		try {
			expect(await internals.createAgentFamilyCatalog()).toContainEqual(
				expect.objectContaining({ id: "shared-session", name: "fresh-local" }),
			);
		} finally {
			listAll.mockRestore();
		}
	});

	it("canonicalizes symlinked paths in the family catalog and name reservations", async () => {
		await withTempDir("optimus-family-catalog-paths-", async (tempDir) => {
			const realDir = join(tempDir, "real");
			const aliasDir = join(tempDir, "alias");
			mkdirSync(realDir);
			symlinkSync(realDir, aliasDir, "dir");
			const parentPath = join(realDir, "parent.jsonl");
			writeFileSync(parentPath, "");
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: vi.fn(),
			});
			const parent = makeState("parent");
			applySession(parent, {
				cwd: tempDir,
				kind: "top-level",
				sessionId: "session-parent",
				sessionName: "parent",
				sessionFile: parentPath,
				depth: 0,
				isStreaming: false,
				isSessionActive: false,
				unfinishedActionCount: 0,
				session: { sessionManager: { getSessionArtifactDir: () => undefined }, hasRunningRlmChildren: () => false },
			});
			const child = {
				activeSessionId: "child-active",
				sessionId: "session-child",
				sessionName: "child",
				runtimeKind: "subagent",
				cwd: tempDir,
				isStreaming: false,
				unfinishedActionCount: 0,
				parentSessionPath: join(aliasDir, "parent.jsonl"),
				rlmDepth: 1,
				status: "idle",
			};
			const internals = daemonInternals(daemon);
			internals.sessions.set(parent.activeSessionId, parent);
			internals.remoteAgentPeers.set(child.activeSessionId, child);
			const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
			try {
				expect(await internals.createAgentFamilyRoster(parent)).toMatchObject({
					entries: [expect.objectContaining({ id: "session-child" })],
				});
				expect(
					sessionNameReservationKey({
						name: "worker",
						depth: 1,
						parentSessionPath: parentPath,
					}),
				).toBe(
					sessionNameReservationKey({
						name: "worker",
						depth: 1,
						parentSessionPath: join(aliasDir, "parent.jsonl"),
					}),
				);
			} finally {
				listAll.mockRestore();
			}
		});
	});

	it("lists and sends agent messages to completed retained subagents", async () => {
		const daemon = stubDaemon();

		const parentState = makeState("parent");
		applySession(parentState, {
			cwd: "/tmp",
			kind: "top-level",
			sessionId: "session-parent",
			sessionName: "Parent",
			isStreaming: false,
			session: { sessionActions: { queuedCount: 0, steering: [], followUps: [] } },
		});
		const defaultSubagentName = createDefaultRlmSubagentSessionName("retained worker", "child-1");
		const subagentState = makeState("child", "parent") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					sessionId: string;
					sessionName: string;
					isStreaming: boolean;
					unfinishedActionCount: number;
					acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
				};
			};
		};
		const acceptAgentMessagePrompt = vi.fn(
			(message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return Promise.resolve(message);
			},
		);
		subagentState.runtime = {
			...subagentState.runtime,
			cwd: "/tmp",
			metadata: {
				...subagentState.runtime.metadata,
				rlmChildId: "child-1",
			},
			session: {
				sessionId: "session-child",
				sessionName: defaultSubagentName,
				isStreaming: false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(parentState.activeSessionId, parentState);
		// A successfully completed RLM child remains idle in this daemon registry.
		internals.sessions.set(subagentState.activeSessionId, subagentState);

		const controller = internals.createAgentMessageController(() => parentState);
		const subagentSummary = (await controller.listAgents()).agents.find(
			(agent: any) => agent.activeSessionId === subagentState.activeSessionId,
		);
		expect(subagentSummary).toMatchObject({
			sessionName: defaultSubagentName,
			runtimeKind: "subagent",
			parentActiveSessionId: parentState.activeSessionId,
			rlmChildId: "child-1",
		});
		if (!subagentSummary?.sessionName) {
			throw new Error("Missing default subagent session name");
		}

		await expect(
			controller.sendAgentMessage({
				target: subagentSummary.sessionName,
				message: "report current progress",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "delivered",
			target: { activeSessionId: subagentState.activeSessionId, runtimeKind: "subagent" },
		});
		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[0]).toContain(`To: ${defaultSubagentName}, active child`);
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[0]).toContain("report current progress");
	});

	it("closes a hosted child through the release hook and persists cancellation", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-daemon-release-test.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const parentState = makeState("parent");
		const childState = makeState("child", parentState.activeSessionId);
		Object.assign(childState.runtime.metadata, {
			kind: "subagent",
			parentActiveSessionId: parentState.activeSessionId,
			rlmChildId: "child-1",
		});
		let internals: {
			sessions: Map<string, ActiveSessionState>;
			closeSession: (state: ActiveSessionState, reason: "completed" | "killed") => Promise<void>;
			recordRlmSubagentDeletion(parentState: ActiveSessionState, childId: string): Promise<void>;
			createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost;
		};
		const closeSession = vi.fn(async (state: ActiveSessionState) => {
			internals.sessions.delete(state.activeSessionId);
		});
		internals = daemon as unknown as typeof internals;
		internals.sessions.set(parentState.activeSessionId, parentState);
		internals.sessions.set(childState.activeSessionId, childState);
		internals.closeSession = closeSession;
		const recordDeletion = vi.fn(async () => undefined);
		internals.recordRlmSubagentDeletion = recordDeletion;

		await internals
			.createSubagentRuntimeHost(parentState)
			.releaseRlmSubagentRuntime?.(
				{ session: childState.runtime.session },
				{ id: "child-1" } as CreateRlmSubagentRuntimeOptions,
				"error",
			);

		expect(recordDeletion).not.toHaveBeenCalled();
		expect(closeSession).toHaveBeenCalledWith(childState, "completed");
		internals.sessions.set(childState.activeSessionId, childState);
		await internals
			.createSubagentRuntimeHost(parentState)
			.releaseRlmSubagentRuntime?.(
				{ session: childState.runtime.session },
				{ id: "child-1" } as CreateRlmSubagentRuntimeOptions,
				"cancelled",
			);
		expect(recordDeletion).toHaveBeenCalledWith(parentState, "child-1", "revoked");
		expect(recordDeletion.mock.invocationCallOrder[0]).toBeLessThan(closeSession.mock.invocationCallOrder[1]!);
		expect(closeSession).toHaveBeenLastCalledWith(childState, "killed");
		expect(internals.sessions.has(childState.activeSessionId)).toBe(false);

		// A registry failure must not strand the cancelled child as a stale resident session.
		internals.sessions.set(childState.activeSessionId, childState);
		internals.recordRlmSubagentDeletion = vi.fn(async () => {
			throw new Error("registry write failed");
		});
		await expect(
			internals
				.createSubagentRuntimeHost(parentState)
				.releaseRlmSubagentRuntime?.(
					{ session: childState.runtime.session },
					{ id: "child-1" } as CreateRlmSubagentRuntimeOptions,
					"cancelled",
				),
		).rejects.toThrow("registry write failed");
		expect(closeSession).toHaveBeenLastCalledWith(childState, "killed");
		expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
	});

	it("persists a real child completion for passive discovery, roster, and listing", async () => {
		await withTempDir("optimus-daemon-real-completion-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentSessionFile) throw new Error("Missing parent session file");
			const childSessionDir = join(parentManager.getSessionArtifactDir()!, "child-1");
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["extensionsResult"],
				services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["services"],
				diagnostics: [],
			}));
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentSessionFile });
			Object.assign(parentState.runtime.session, {
				isSessionActive: false,
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				state: { pendingToolCalls: new Set(), streamingMessage: undefined },
				thinkingLevel: "off",
				hasRunningRlmChildren: () => false,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			});
			const childRuntime = await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "complete and persist",
				sessionName: "real-worker",
				sessionDir: childSessionDir,
				model: { provider: "test", id: "model" } as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-1",
			});
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.session === childRuntime.session,
			);
			if (!childState?.runtime.session.sessionFile) throw new Error("Missing child state");
			const host = internals.createSubagentRuntimeHost(parentState);
			expect(host.completeRlmSubagentRuntime?.("child-1", childRuntime.session)).toBe(true);
			await (
				daemon as unknown as { closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void> }
			).closeSession(childState, "shutdown");

			expect((await internals.listPassiveRlmSubagents()).map(({ entry }: any) => entry.childId)).toContain(
				"child-1",
			);
			expect((await internals.findPassiveRlmSubagent("real-worker"))?.entry.childId).toBe("child-1");
			const roster = await internals.createAgentMessageController(() => parentState).roster?.();
			const passiveRosterEntry = roster?.entries.find((entry: any) => entry.name === "real-worker");
			expect(passiveRosterEntry).toMatchObject({ relationship: "child", status: "inactive" });
			expect(passiveRosterEntry).not.toHaveProperty("repliedSinceTask");
			const listed = await internals.buildSessionListWithPassiveRlmSubagents(
				[parentState],
				await SessionManager.listAll(undefined, sessionDir),
				[],
			);
			expect(listed).toContainEqual(
				expect.objectContaining({ sessionFile: childState.runtime.session.sessionFile, rlmChildId: "child-1" }),
			);
			// The registry is legacy read-only now: spawn and completion must land
			// in the per-child display file, never in rlm-subagents.jsonl.
			expect(existsSync(join(parentManager.getSessionArtifactDir()!, "rlm-subagents.jsonl"))).toBe(false);
			const display = JSON.parse(readFileSync(join(childSessionDir, "rlm-subagent.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(display).toMatchObject({
				childId: "child-1",
				sessionName: "real-worker",
				status: "completed",
				prompt: "complete and persist",
			});
		});
	});

	it("discovers a non-resident child left running in the persisted registry", async () => {
		await withTempDir("optimus-daemon-orphan-running-child-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const entry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, unknown>;
			entry.status = "running";
			writeFileSync(registryPath, `${JSON.stringify(entry)}\n`);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<Array<{ entry: { childId: string } }>>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			expect((await internals.listPassiveRlmSubagents()).map(({ entry }) => entry.childId)).toContain(
				fixture.childId,
			);
			await expect(internals.createAgentMessageController(() => parentState).roster?.()).resolves.toMatchObject({
				entries: [expect.objectContaining({ relationship: "child", name: "renamed-worker" })],
			});
		});
	});

	it("persists explicit child depth for an in-memory daemon parent", async () => {
		await withTempDir("optimus-daemon-in-memory-parent-depth-", async (tempDir) => {
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["extensionsResult"],
				services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["services"],
				diagnostics: [],
			}));
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: join(tempDir, "sessions"),
				createRuntime,
			});
			const internals = daemonInternals(daemon);
			const parentState = await internals.createRuntime({ type: "create", noSession: true });
			const child = await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "persist depth",
				sessionName: "depth-child",
				sessionDir: join(tempDir, "child"),
				model: {} as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmParentNodeId: "child-1",
			});

			expect(parentState.runtime.session.sessionFile).toBeUndefined();
			expect(child.session.sessionManager.getHeader()).toMatchObject({ rlmDepth: 1 });
			expect(child.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		});
	});

	it("defers RLM heartbeats while a subagent is binding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-binding-heartbeat-"));
		let releaseChildBinding: (() => void) | undefined;
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentSessionFile) {
				throw new Error("Missing parent session file");
			}
			const childSessionDir = join(parentManager.getSessionArtifactDir() ?? tempDir, "child-1");
			let markChildBindingStarted: (() => void) | undefined;
			const childBindingStarted = new Promise<void>((resolve) => {
				markChildBindingStarted = resolve;
			});
			const childBindingGate = new Promise<void>((resolve) => {
				releaseChildBinding = resolve;
			});
			const promptHeartbeat = vi.fn(
				async (_job: AgentCronJob, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
					options?.preflightResult?.(true);
				},
			);
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				Object.assign(session, {
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					isBashRunning: false,
					hasAcceptedPromptInFlight: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					promptHeartbeat,
				});
				if (options.sessionOptions?.rlmSessionDir === childSessionDir) {
					session.bindExtensions = vi.fn(async () => {
						markChildBindingStarted?.();
						await childBindingGate;
					});
				}
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentSessionFile });
			const childRuntimePromise = internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "initialize a heartbeat",
				sessionName: "heartbeat-child",
				sessionDir: childSessionDir,
				model: {} as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-1",
			});
			await childBindingStarted;
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === "child-1",
			);
			const childSessionFile = childState?.runtime.session.sessionFile;
			if (!childState || !childSessionFile) {
				throw new Error("Missing binding child session");
			}
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			expect(await internals.cronScheduler.runDue(new Date("2026-07-16T00:00:00.000Z"))).toBe(0);
			expect(promptHeartbeat).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 0,
			});

			if (!releaseChildBinding) {
				throw new Error("Missing child binding release");
			}
			releaseChildBinding();
			releaseChildBinding = undefined;
			await childRuntimePromise;
			expect(await internals.cronScheduler.runDue(new Date("2027-01-01T00:00:00.000Z"))).toBe(1);
			expect(promptHeartbeat).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 1,
			});
		} finally {
			releaseChildBinding?.();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("closes the exact parent-scoped daemon runtime when a retained subagent is deleted", async () => {
		const daemon = stubDaemon();

		const parentState = makeState("parent");
		applySession(parentState, { session: { sessionManager: { getSessionArtifactDir: () => undefined } } });
		const childState = makeState("child", parentState.activeSessionId);
		const foreignChildState = makeState("foreign-child", "other-parent");
		const childSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		const foreignSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		childState.runtime = {
			...childState.runtime,
			metadata: { ...childState.runtime.metadata, rlmChildId: "child-1" },
			session: childSession,
		} as ActiveSessionState["runtime"];
		foreignChildState.runtime = {
			...foreignChildState.runtime,
			metadata: { ...foreignChildState.runtime.metadata, rlmChildId: "child-1" },
			session: foreignSession,
		} as ActiveSessionState["runtime"];
		const closeSession = vi.fn(async () => {});
		const internals = daemonInternals(daemon);
		internals.sessions.set(childState.activeSessionId, childState);
		internals.sessions.set(foreignChildState.activeSessionId, foreignChildState);
		internals.closeSession = closeSession;

		const staleParentReference = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		const host = internals.createSubagentRuntimeHost(parentState);
		await host.deleteRlmSubagentRuntime("child-1", staleParentReference);

		expect(closeSession).toHaveBeenCalledOnce();
		expect(closeSession).toHaveBeenCalledWith(childState, "killed", false);
		expect(closeSession).not.toHaveBeenCalledWith(foreignChildState, expect.anything());
		expect(childSession.disposeAsync).not.toHaveBeenCalled();
		expect(staleParentReference.disposeAsync).toHaveBeenCalledOnce();

		const missingSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		await host.deleteRlmSubagentRuntime("missing-child", missingSession);
		expect(missingSession.disposeAsync).toHaveBeenCalledOnce();
	});

	it("cancels child jobs when deletion joins an in-flight passivation close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-delete-passivation-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childDisposeStarted: markDisposeStarted,
				childDisposeGate: disposeGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());
			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await disposeStarted;
			const job = internals.cronStore.create({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "scheduled child work",
			});
			const deletion = internals
				.createSubagentRuntimeHost(parentState)
				.deleteRlmSubagentRuntime(fixture.childId, childState.runtime.session);
			releaseDispose();

			await Promise.all([passivation, deletion]);
			expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)?.status).toBe("cancelled");
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a child live when its durable deletion boundary cannot be read", async () => {
		await withTempDir("optimus-daemon-delete-registry-failure-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentArtifactDir) {
				throw new Error("Missing parent artifact directory");
			}
			mkdirSync(join(parentArtifactDir, "rlm-subagents.jsonl"), { recursive: true });

			const daemon = stubDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
			});

			const parentState = makeState("parent");
			parentState.runtime = {
				...parentState.runtime,
				session: makeRuntimeSession(parentManager),
			} as ActiveSessionState["runtime"];
			const childState = makeState("child", parentState.activeSessionId);
			childState.runtime = {
				...childState.runtime,
				metadata: { ...childState.runtime.metadata, rlmChildId: "child-1" },
				session: { disposeAsync: vi.fn(async () => {}) },
			} as unknown as ActiveSessionState["runtime"];
			const closeSession = vi.fn(async () => {});
			const internals = daemonInternals(daemon);
			internals.sessions.set(childState.activeSessionId, childState);
			internals.closeSession = closeSession;

			await expect(
				internals
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime("child-1", childState.runtime.session),
			).rejects.toThrow();
			expect(closeSession).not.toHaveBeenCalled();
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
		});
	});

	it("hides daemon sessions from messaging and observation while they are closing", async () => {
		const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

		const parentState = makeState("parent");
		const childState = makeState("child", parentState.activeSessionId);
		const sessionPrompt = vi.fn(async () => {});
		for (const [state, sessionId] of [
			[parentState, "session-parent"],
			[childState, "session-child"],
		] as const) {
			applySession(state, {
				cwd: "/tmp",
				sessionName: sessionId,
				prompt: sessionPrompt,
				isStreaming: false,
				session: { sessionId, sessionActions: { queuedCount: 0, steering: [], followUps: [] } },
			});
		}
		const internals = daemonInternals(daemon);
		internals.sessions.set(parentState.activeSessionId, parentState);
		internals.sessions.set(childState.activeSessionId, childState);
		internals.closingSessions.set(childState.activeSessionId, { promise: Promise.resolve(), reason: "shutdown" });

		const controller = internals.createAgentMessageController(() => parentState);
		const listed = await controller.listAgents();
		expect(listed.agents).not.toContainEqual(
			expect.objectContaining({ activeSessionId: childState.activeSessionId }),
		);
		expect(() => internals.getBoundSessionState(childState.activeSessionId)).toThrow("is closing");
		await expect(
			controller.sendAgentMessage({ target: childState.activeSessionId, message: "continue" }),
		).rejects.toThrow("is closing");
		const client = makeClient("client-1", childState.activeSessionId);
		for (const command of [
			{ id: "prompt", type: "prompt", activeSessionId: childState.activeSessionId, message: "continue" },
			{ id: "steer", type: "steer", activeSessionId: childState.activeSessionId, message: "continue" },
			{ id: "follow-up", type: "follow_up", activeSessionId: childState.activeSessionId, message: "continue" },
		] as const) {
			await expect(internals.handleCommand(client, command)).rejects.toThrow("is closing");
		}

		internals.closingSessions.delete(childState.activeSessionId);
		let releaseTargetLock: () => void = () => {};
		const targetLock = new Promise<void>((resolve) => {
			releaseTargetLock = resolve;
		});
		internals.agentMessageTargetLocks.set(childState.activeSessionId, targetLock);
		const guardedPrompt = internals.promptWithAgentMessagePreparingGuard(childState, "continue");
		await Promise.resolve();
		internals.closingSessions.set(childState.activeSessionId, { promise: Promise.resolve(), reason: "shutdown" });
		releaseTargetLock();
		await expect(guardedPrompt).rejects.toThrow("closing before prompt delivery");
		expect(sessionPrompt).not.toHaveBeenCalled();
	});

	it("removes a closing daemon session even when runtime disposal fails", async () => {
		const daemon = stubDaemon();

		const state = makeState("child");
		const dispose = vi.fn(async () => {
			throw new Error("dispose failed");
		});
		applySession(state, {
			sessionId: "session-child",
			sessionFile: undefined,
			session: { abort: vi.fn(() => new Promise<void>(() => {})) },
			runtime: { dispose },
		});
		state.extensionUiRequests = new Map();
		state.unsubscribe = vi.fn();
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.closeChildSessions = vi.fn(async () => undefined);
		internals.isEmptyDraftContent = vi.fn(() => true);
		internals.abortBashForClose = vi.fn(async () => {});
		internals.recordWorkerRecoveryState = vi.fn();
		internals.broadcastToSession = vi.fn();
		internals.cancelScheduledJobsForSession = vi.fn();

		await expect(internals.closeSession(state, "killed", false)).rejects.toThrow("dispose failed");

		expect(dispose).toHaveBeenCalledOnce();
		expect(internals.sessions.has(state.activeSessionId)).toBe(false);
		expect(internals.closingSessions.has(state.activeSessionId)).toBe(false);
	});

	it("lists and routes agent messages to peers hosted by another worker", async () => {
		const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

		const source = makeState("source");
		applySession(source, {
			cwd: "/tmp",
			sessionId: "session-source",
			sessionName: "Source",
			isStreaming: false,
			session: { sessionActions: { queuedCount: 0, steering: [], followUps: [] } },
		});
		const remoteSelector = "remote is closing";
		const receipt = {
			id: "agentmsg-remote",
			source: "agent_message",
			target: { activeSessionId: remoteSelector, sessionId: "session-remote" },
			message: "continue remotely",
			deliveryStatus: "delivered",
			deliveredAt: "2026-01-01T00:00:00.000Z",
			deliveryMode: "auto",
		};
		const sendRemoteAgentSessionMessage = vi.fn().mockResolvedValue(receipt);
		const internals = daemonInternals(daemon);
		internals.sessions.set(source.activeSessionId, source);
		internals.remoteAgentPeers.set(remoteSelector, {
			activeSessionId: remoteSelector,
			sessionId: "session-remote",
			sessionName: "Remote",
			runtimeKind: "top-level",
			cwd: "/tmp/remote",
			isStreaming: false,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		});
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		expect((await internals.createAgentMessageListResult(source)).agents).toContainEqual(
			expect.objectContaining({ activeSessionId: remoteSelector }),
		);
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: remoteSelector,
				message: "continue remotely",
				fromState: source,
				origin: "agent",
			}),
		).resolves.toEqual(receipt);
		expect(sendRemoteAgentSessionMessage).toHaveBeenCalledWith(source, remoteSelector, "continue remotely");
	});

	it("routes nonresident agent-message targets through the supervisor wake path", async () => {
		const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

		const source = makeState("source");
		applySession(source, {
			cwd: "/tmp",
			sessionId: "session-source",
			sessionName: "Source",
			isStreaming: false,
			session: { sessionActions: { queuedCount: 0, steering: [], followUps: [] } },
		});
		const sendRemoteAgentSessionMessage = vi
			.fn()
			.mockRejectedValue(new Error("Unknown active session: deleted-child"));
		const internals = daemonInternals(daemon);
		internals.sessions.set(source.activeSessionId, source);
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: "deleted-child",
				message: "continue",
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Unknown active session: deleted-child");
		expect(sendRemoteAgentSessionMessage).toHaveBeenCalledWith(source, "deleted-child", "continue");
	});

	it("rejects invalid nonresident agent messages before remote fallback", async () => {
		const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

		const source = makeState("source");
		const sendRemoteAgentSessionMessage = vi.fn();
		const internals = daemonInternals(daemon);
		internals.sessions.set(source.activeSessionId, source);
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: "nonresident-target",
				message: " ",
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Agent session message cannot be empty");
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: "nonresident-target",
				message: "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS + 1),
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Agent session message is too long");
		expect(sendRemoteAgentSessionMessage).not.toHaveBeenCalled();
	});

	it("does not retry supervisor agent-message rejections", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-msg-"));
		const socketPath = join(tempDir, "d.sock");
		let connectionCount = 0;
		const server: Server = createServer((socket) => {
			connectionCount++;
			socket.on("error", () => undefined);
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaId: DAEMON_SCHEMA_ID,
					clientId: "supervisor",
					serverCapabilities: [],
				})}\n`,
			);
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const wire = JSON.parse(buffer.slice(0, newline)) as {
					id: string;
					command?: { type: string };
					type: string;
				};
				const command = wire.command ?? wire;
				socket.write(
					`${JSON.stringify({
						type: "response",
						id: wire.id,
						command: command.type,
						success: false,
						error: "Target session has too many pending messages",
					})}\n`,
				);
			});
		});
		const previousSupervisorSocket = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

			const sendRemoteAgentSessionMessage = (
				daemon as unknown as {
					sendRemoteAgentSessionMessage(
						fromState: ActiveSessionState,
						targetSelector: string,
						message: string,
					): Promise<unknown>;
				}
			).sendRemoteAgentSessionMessage.bind(daemon);

			await expect(sendRemoteAgentSessionMessage(makeState("source"), "remote", "continue")).rejects.toThrow(
				"Target session has too many pending messages",
			);
			expect(connectionCount).toBe(1);
		} finally {
			if (previousSupervisorSocket === undefined) {
				delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			} else {
				process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSupervisorSocket;
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("routes worker-local session renames through the supervisor", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-worker-rename-"));
		const socketPath = join(tempDir, "s");
		let receivedCommand: Record<string, unknown> | undefined;
		let releaseResponse: () => void = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const server = createServer((socket) => {
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaRevision: DAEMON_SCHEMA_REVISION,
					serverCapabilities: [],
					clientId: "worker-rename-test",
				})}\n`,
			);
			let buffered = "";
			socket.on("data", (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				const newline = buffered.indexOf("\n");
				if (newline < 0 || receivedCommand) return;
				const wire = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				receivedCommand = (wire.command as Record<string, unknown> | undefined) ?? wire;
				void responseGate.then(() => {
					socket.write(
						`${JSON.stringify({
							id: wire.id,
							type: "response",
							command: "set_session_name",
							success: true,
						})}\n`,
					);
				});
			});
		});
		const previousSocketPath = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = makeDaemon({
				socketPath: join(tempDir, "worker.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				createRuntime: vi.fn(),
				worker: { authenticationToken: "token" },
			});
			const setSessionName = vi.fn((_name: string) => undefined);
			const state = makeState("active");
			Object.assign(state.runtime, { session: { setSessionName } });
			const controller = (
				daemon as unknown as {
					createAgentMessageController(getCurrentState: () => ActiveSessionState): AgentSessionMessageController;
				}
			).createAgentMessageController(() => state);

			const rename = controller.setSessionName?.("shared-root");
			// Workers and supervisors ship in one process tree, so no capability gate is needed; the
			// optional field remains compatible with old supervisors because envelope parsing preserves extra fields.
			await vi.waitFor(() =>
				expect(receivedCommand).toMatchObject({
					type: "set_session_name",
					activeSessionId: "active",
					name: "shared-root",
					workerToken: "token",
				}),
			);
			expect(setSessionName).not.toHaveBeenCalled();
			releaseResponse();
			await expect(rename).resolves.toBeUndefined();
		} finally {
			if (previousSocketPath === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSocketPath;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not retry permanent ambiguity errors from the supervisor", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-ambiguous-"));
		const socketPath = join(tempDir, "s");
		let requestCount = 0;
		const server = createServer((socket) => {
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaRevision: DAEMON_SCHEMA_REVISION,
					serverCapabilities: [],
				})}\n`,
			);
			let buffered = "";
			socket.on("data", (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				const newline = buffered.indexOf("\n");
				if (newline < 0 || requestCount > 0) return;
				const command = JSON.parse(buffered.slice(0, newline)) as { id?: string };
				requestCount++;
				socket.write(
					`${JSON.stringify(failure(command.id, "send_message", new Error('Ambiguous session selector "duplicate"')))}\n`,
				);
			});
		});
		const previousSocketPath = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = makeDaemon({
				socketPath: join(tempDir, "worker.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				createRuntime: vi.fn(),
			});
			const source = makeState("source");
			const internals = daemonInternals(daemon);

			await expect(internals.sendRemoteAgentSessionMessage(source, "duplicate", "hello")).rejects.toThrow(
				'Ambiguous session selector "duplicate"',
			);
			expect(requestCount).toBe(1);
		} finally {
			if (previousSocketPath === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSocketPath;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reports queued status when a direct accept races into the queue", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean, didQueue?: boolean) => void }) => {
				options?.preflightResult?.(true, true);
				return Promise.resolve();
			},
		);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			session: { sessionActions: { queuedCount: 0, steering: [], followUps: [] }, acceptAgentMessagePrompt },
		});
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "please continue",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "queued",
			target: { activeSessionId: targetState.activeSessionId },
		});
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: "steer" });
	});

	it("ignores a legacy follow-up mode and always steers agent messages", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		const queueAgentMessagePrompt = vi.fn(async () => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: true,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			unfinishedActionCount: 0,
			session: { queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const response = await internals.handleCommand(makeClient("legacy-client", targetState.activeSessionId), {
			type: "send_message",
			targetActiveSessionId: targetState.activeSessionId,
			message: "do not defer",
			deliveryMode: "follow_up",
		});

		expect(response).toMatchObject({ data: { deliveryStatus: "queued", deliveryMode: "steer" } });
		expect(queueAgentMessagePrompt).toHaveBeenCalledWith(
			expect.stringContaining("do not defer"),
			"steer",
			expect.objectContaining({ customType: "agent_message" }),
		);
	});

	it("rate limits agent messages per sender and target pair", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetA = makeState("target-a");
		const targetB = makeState("target-b");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		for (const targetState of [targetA, targetB]) {
			applySession(targetState, {
				cwd: "/tmp",
				sessionId: `session-${targetState.activeSessionId}`,
				sessionName: targetState.activeSessionId,
				isStreaming: false,
				prompt: vi.fn(async () => {}),
				followUp: vi.fn(async () => true),
				session: {
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					clearQueue: vi.fn(() => ({ cleared: 0 })),
					clearQueuedUserMessagesMatching: vi.fn(() => ({ steering: [], followUp: [] })),
				},
			});
		}
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetA.activeSessionId, targetA);
		internals.sessions.set(targetB.activeSessionId, targetB);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: targetA.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				}),
			).resolves.toMatchObject({ target: { activeSessionId: targetA.activeSessionId } });
		}
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetA.activeSessionId,
				message: "over limit",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent messaging rate limit exceeded");
		await internals.handleCommand(makeClient("client-1", targetA.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetA.activeSessionId,
		});
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetA.activeSessionId,
				message: "after clear",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetA.activeSessionId } });
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetB.activeSessionId,
				message: "different target",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetB.activeSessionId } });
	});

	it("clears only queued agent-message prompts", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		const agentMessageText =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_test\n\nhello";
		const clearQueuedUserMessagesMatching = vi.fn((predicate: (text: string) => boolean) => ({
			steering: [agentMessageText].filter(predicate),
			followUp: [],
		}));
		const clearQueue = vi.fn(() => ({ steering: ["user prompt"], followUp: ["heartbeat"] }));
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 2,
			session: { clearQueuedUserMessagesMatching, clearQueue },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});

		expect(clearQueuedUserMessagesMatching).toHaveBeenCalledOnce();
		const predicate = clearQueuedUserMessagesMatching.mock.calls[0]?.[0];
		expect(predicate?.(agentMessageText)).toBe(true);
		expect(predicate?.("ordinary queued follow-up")).toBe(false);
		expect(clearQueue).not.toHaveBeenCalled();
	});

	it("pause clears queued agent-message prompts from all sessions", async () => {
		const daemon = stubDaemon();

		const firstState = makeState("target-1");
		const secondState = makeState("target-2");
		const firstClear = vi.fn(() => ({ steering: [], followUp: ["agent message"] }));
		const secondClear = vi.fn(() => ({ steering: ["agent message"], followUp: [] }));
		for (const [state, clearQueuedUserMessagesMatching] of [
			[firstState, firstClear],
			[secondState, secondClear],
		] as const) {
			applySession(state, {
				cwd: "/tmp",
				sessionId: `session-${state.activeSessionId}`,
				sessionName: state.activeSessionId,
				isStreaming: false,
				unfinishedActionCount: 1,
				session: { clearQueuedUserMessagesMatching },
			});
		}
		const internals = daemonInternals(daemon);
		internals.agentMessageRateLimiter.clear = vi.fn();
		internals.sessions.set(firstState.activeSessionId, firstState);
		internals.sessions.set(secondState.activeSessionId, secondState);

		await internals.handleCommand(makeClient("client-1", firstState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});

		expect(internals.agentMessageRateLimiter.clear).toHaveBeenCalledOnce();
		expect(firstClear).toHaveBeenCalledOnce();
		expect(secondClear).toHaveBeenCalledOnce();
	});

	it("pause clears queued agent messages concurrently across sessions", async () => {
		const daemon = stubDaemon();

		const blockedState = makeState("blocked");
		const readyState = makeState("ready");
		let resolveBlockedClear: () => void = () => {};
		const blockedClear = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const readyClear = vi.fn(() => ({ steering: [], followUp: ["agent message"] }));
		for (const [state, clearQueuedUserMessagesMatching] of [
			[blockedState, blockedClear],
			[readyState, readyClear],
		] as const) {
			applySession(state, {
				cwd: "/tmp",
				sessionId: `session-${state.activeSessionId}`,
				sessionName: state.activeSessionId,
				isStreaming: false,
				unfinishedActionCount: 1,
				session: { clearQueuedUserMessagesMatching },
			});
		}
		const internals = daemonInternals(daemon);
		internals.sessions.set(blockedState.activeSessionId, blockedState);
		internals.sessions.set(readyState.activeSessionId, readyState);

		const pause = internals.handleCommand(makeClient("client-1", blockedState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(blockedClear).toHaveBeenCalledOnce();
		expect(readyClear).toHaveBeenCalledOnce();
		resolveBlockedClear();
		await pause;
	});

	it("refunds agent message rate limit tokens when delivery fails", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: {
				prompt: vi.fn(async () => {
					throw new Error("missing model");
				}),
			},
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: targetState.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				}),
			).rejects.toThrow("missing model");
		}
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "after failed sends",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("missing model");
	});

	it("counts concurrent agent message queue reservations against the target queue cap", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		let rejectQueuedMessage: (error: Error) => void = () => {};
		const queueAgentMessagePrompt = vi.fn(
			(_message: string, _streamingBehavior: "steer" | "followUp") =>
				new Promise<boolean>((_resolve, reject) => {
					rejectQueuedMessage = reject;
				}),
		);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: true,
			unfinishedActionCount: 19,
			prompt: vi.fn(async () => {}),
			session: {
				clearQueue: vi.fn(() => ({ cleared: 0 })),
				clearQueuedUserMessagesMatching: vi.fn(() => ({ steering: [], followUp: [] })),
				queueAgentMessagePrompt,
			},
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "second",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Target session has too many pending messages");

		rejectQueuedMessage(new Error("release reservation"));
		await expect(first).rejects.toThrow("release reservation");
		await clear;
	});

	it("releases queue reservations once messages are queued so concurrent senders do not halve capacity", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let pending = 0;
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => {
			pending += 1;
			return true;
		});
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: true,
				get unfinishedActionCount() {
					return pending;
				},
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);
		// Distinct senders so the per-sender rate limit stays out of the way.
		const senders = Array.from({ length: 12 }, (_, i) => {
			const fromState = makeState(`source-${i}`);
			applySession(fromState, {
				sessionId: `session-source-${i}`,
				sessionName: `Source ${i}`,
			});
			internals.sessions.set(fromState.activeSessionId, fromState);
			return fromState;
		});

		const errors: unknown[] = [];
		for (const [i, fromState] of senders.entries()) {
			void internals
				.sendAgentSessionMessage({
					targetSelector: targetState.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				})
				.catch((error: any) => {
					errors.push(error);
				});
		}
		for (let attempt = 0; attempt < 200 && queueAgentMessagePrompt.mock.calls.length < 12; attempt++) {
			await Promise.resolve();
		}

		// With reservations held past queue time, 12 concurrent senders would
		// count as 24 against the 20-slot cap and the tail would reject.
		expect(errors).toEqual([]);
		expect(queueAgentMessagePrompt).toHaveBeenCalledTimes(12);
	});

	it("resolves queued sends immediately with a queued receipt while the target is streaming", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		// A real streaming session only resolves this once its turn progresses;
		// the send must not depend on it.
		const waitForAgentMessagePromptDelivery = vi.fn(() => new Promise<void>(() => {}));
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: true,
			unfinishedActionCount: 0,
			session: { queueAgentMessagePrompt, waitForAgentMessagePromptDelivery },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued while streaming",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "queued",
			target: { activeSessionId: targetState.activeSessionId },
		});
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(waitForAgentMessagePromptDelivery).not.toHaveBeenCalled();
	});

	it("resolves mutual sends between two busy sessions without deadlocking", async () => {
		const daemon = stubDaemon();

		const makeBusyState = (name: string) => {
			const state = makeState(name);
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${name}`,
					sessionName: name,
					isStreaming: true,
					unfinishedActionCount: 0,
					queueAgentMessagePrompt: vi.fn(async () => true),
					// Neither turn ends while both sessions block inside their own send.
					waitForAgentMessagePromptDelivery: vi.fn(() => new Promise<void>(() => {})),
				},
			} as never;
			return state;
		};
		const stateA = makeBusyState("alpha");
		const stateB = makeBusyState("beta");
		const internals = daemonInternals(daemon);
		internals.sessions.set(stateA.activeSessionId, stateA);
		internals.sessions.set(stateB.activeSessionId, stateB);

		const [aToB, bToA] = await Promise.all([
			internals.sendAgentSessionMessage({
				targetSelector: stateB.activeSessionId,
				message: "alpha to beta",
				fromState: stateA,
				origin: "agent",
			}),
			internals.sendAgentSessionMessage({
				targetSelector: stateA.activeSessionId,
				message: "beta to alpha",
				fromState: stateB,
				origin: "agent",
			}),
		]);

		expect(aToB).toMatchObject({ deliveryStatus: "queued", target: { activeSessionId: stateB.activeSessionId } });
		expect(bToA).toMatchObject({ deliveryStatus: "queued", target: { activeSessionId: stateA.activeSessionId } });
	});

	it("counts accepted in-flight agent messages against the target queue cap", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 20,
			hasAcceptedPromptInFlight: true,
			session: { acceptAgentMessagePrompt, queueAgentMessagePrompt: vi.fn(async () => true) },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "over cap",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Target session has too many pending messages");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("reports accepted in-flight agent messages in agent-message lists", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 3,
			hasAcceptedPromptInFlight: true,
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		expect((await internals.createAgentMessageListResult(targetState)).agents[0]?.unfinishedActionCount).toBe(3);
	});

	it("reports non-streaming busy sessions as active in agent-observe summaries", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			sessionFile: undefined,
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isRetrying: false,
			hasAcceptedPromptInFlight: false,
			unfinishedActionCount: 1,
			isSessionActive: true,
			session: {
				sessionManager: { getCwd: () => "/tmp" },
				model: undefined,
				thinkingLevel: "off",
				getSessionActionSnapshot: () => ({ queuedCount: 1, steering: [], followUps: [] }),
				messages: [],
				state: { pendingToolCalls: new Set(), streamingMessage: undefined },
				hasRunningRlmChildren: () => false,
			},
			runtime: { diagnostics: [], modelFallbackMessage: undefined },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		expect((await internals.createAgentObserveListResult(targetState)).current.status).toBe("busy");

		(targetState.runtime.session as { isCompacting: boolean; unfinishedActionCount: number }).isCompacting = true;
		(targetState.runtime.session as { isCompacting: boolean; unfinishedActionCount: number }).unfinishedActionCount =
			0;

		expect((await internals.createAgentObserveListResult(targetState)).current.status).toBe("compacting");
	});

	it("canonicalizes symlinked family paths before comparison", async () => {
		await withTempDir("optimus-family-paths-", async (tempDir) => {
			const realDir = join(tempDir, "real");
			const aliasDir = join(tempDir, "alias");
			mkdirSync(realDir);
			symlinkSync(realDir, aliasDir, "dir");
			const daemon = makeDaemon({
				socketPath: "/tmp/optimus-family-paths.sock",
				agentDir: tempDir,
				cwd: tempDir,
				createRuntime: vi.fn(),
			});
			const parent = makeState("parent");
			const child = makeState("child", "parent");
			parent.runtime = {
				...parent.runtime,
				metadata: { ...parent.runtime.metadata, kind: "top-level" },
				session: { sessionId: "session-parent", sessionFile: join(realDir, "parent.jsonl") },
			} as never;
			child.runtime = {
				...child.runtime,
				metadata: {
					...child.runtime.metadata,
					parentSessionId: "session-parent",
					parentSessionFile: join(aliasDir, "parent.jsonl"),
				},
				session: { sessionId: "session-child", sessionFile: join(realDir, "child.jsonl") },
			} as never;
			const internals = daemonInternals(daemon);

			expect(() => internals.assertAgentFamilyReachable(parent, child)).not.toThrow();
		});
	});

	it("resolves a reopened child's persisted header parent relative to its session file", async () => {
		await withTempDir("optimus-header-family-", async (tempDir) => {
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				createRuntime: vi.fn(),
			});
			const parent = makeState("parent");
			const child = makeState("reopened-child");
			const otherRoot = makeState("other-root");
			applySession(parent, {
				kind: "top-level",
				sessionId: "session-parent",
				sessionFile: join(tempDir, "parent.jsonl"),
				session: { sessionManager: { getHeader: () => ({ parentSession: undefined }) } },
			});
			applySession(child, {
				kind: "top-level",
				sessionId: "session-child",
				sessionFile: join(tempDir, "children", "child.jsonl"),
				depth: 1,
				session: { sessionManager: { getHeader: () => ({ parentSession: "../parent.jsonl" }) } },
			});
			applySession(otherRoot, {
				kind: "top-level",
				sessionId: "session-other",
				sessionFile: join(tempDir, "other.jsonl"),
				session: { sessionManager: { getHeader: () => ({ parentSession: undefined }) } },
			});
			const internals = daemonInternals(daemon);

			expect(() => internals.assertAgentFamilyReachable(child, parent)).not.toThrow();
			expect(() => internals.assertAgentFamilyReachable(child, otherRoot)).toThrow(AGENT_FAMILY_REACH_ERROR);
		});
	});

	it("uses the persisted header parent after a runtime session replacement", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-applied-family.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const originalParent = makeState("original-parent");
		const persistedParent = makeState("persisted-parent");
		const child = makeState("child");
		applySession(originalParent, {
			kind: "top-level",
			sessionId: "session-original",
			sessionFile: "/tmp/original-parent.jsonl",
		});
		applySession(persistedParent, {
			kind: "top-level",
			sessionId: "session-persisted",
			sessionFile: "/tmp/persisted-parent.jsonl",
		});
		applySession(child, {
			kind: "subagent",
			parentSessionId: "session-original",
			sessionId: "session-child",
			sessionFile: "/tmp/child.jsonl",
			depth: 1,
			metadata: { parentSessionFile: "/tmp/original-parent.jsonl" },
			session: { sessionManager: { getHeader: () => ({ parentSession: "/tmp/persisted-parent.jsonl" }) } },
		});
		const internals = daemonInternals(daemon);

		expect(() => internals.assertAgentFamilyReachable(child, persistedParent)).not.toThrow();
		expect(() => internals.assertAgentFamilyReachable(child, originalParent)).toThrow(AGENT_FAMILY_REACH_ERROR);
	});

	it("labels a reopened header-linked child and parent consistently with family reach", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-header-relationship.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const parent = makeState("parent");
		const child = makeState("reopened-child");
		applySession(parent, {
			kind: "top-level",
			sessionId: "session-parent",
			sessionFile: "/tmp/parent.jsonl",
			session: { sessionManager: { getHeader: () => ({ parentSession: undefined }) } },
		});
		applySession(child, {
			kind: "top-level",
			sessionId: "session-child",
			sessionFile: "/tmp/children/child.jsonl",
			depth: 1,
			session: { sessionManager: { getHeader: () => ({ parentSession: "../parent.jsonl" }) } },
		});
		const internals = daemonInternals(daemon);

		expect(internals.agentMessageRelationship(child, parent)).toBe("child");
		expect(internals.agentMessageRelationship(parent, child)).toBe("parent");
	});

	it("limits agent send and observation to the nuclear family", async () => {
		const daemon = stubDaemon({
			socketPath: "/tmp/optimus-family-reach.sock",
			agentDir: "/tmp/optimus-test-agent",
			cwd: "/tmp",
		});

		const states = [
			makeState("root"),
			makeState("child", "root"),
			makeState("sibling", "root"),
			makeState("grandchild", "child"),
			makeState("cousin", "sibling"),
		];
		const sessionIds = new Map(states.map((state) => [state.activeSessionId, `session-${state.activeSessionId}`]));
		for (const state of states) {
			const parentActiveSessionId = state.runtime.metadata.parentActiveSessionId;
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				diagnostics: [],
				modelFallbackMessage: undefined,
				metadata: {
					...state.runtime.metadata,
					kind: parentActiveSessionId ? "subagent" : "top-level",
					...(parentActiveSessionId
						? {
								parentSessionId: sessionIds.get(parentActiveSessionId),
								parentSessionFile: `/tmp/${parentActiveSessionId}.jsonl`,
							}
						: {}),
				},
				session: {
					sessionId: sessionIds.get(state.activeSessionId),
					sessionName: state.activeSessionId,
					sessionFile: `/tmp/${state.activeSessionId}.jsonl`,
					sessionManager: {
						getCwd: () => "/tmp",
						getHeader: () => ({ created: new Date(0).toISOString() }),
						getSessionArtifactDir: () => undefined,
					},
					runtimeKind: parentActiveSessionId ? "subagent" : "top-level",
					rlmDepth: parentActiveSessionId
						? state.activeSessionId === "grandchild" || state.activeSessionId === "cousin"
							? 2
							: 1
						: 0,
					isStreaming: false,
					isCompacting: false,
					isBashRunning: false,
					isRetrying: false,
					isSessionActive: false,
					hasAcceptedPromptInFlight: false,
					unfinishedActionCount: 0,
					messages: [],
					state: { pendingToolCalls: new Set(), streamingMessage: undefined },
					hasRunningRlmChildren: () => false,
					getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				},
			} as never;
		}
		const internals = daemonInternals(daemon);
		for (const state of states) internals.sessions.set(state.activeSessionId, state);
		const child = states[1]!;
		const messaging = internals.createAgentMessageController(() => child);
		const observe = internals.createAgentObserveController(() => child);

		expect((await observe.listAgents()).agents.map((agent: any) => agent.activeSessionId)).toEqual([
			"root",
			"child",
			"sibling",
			"grandchild",
		]);
		await expect(observe.getAgent("cousin")).rejects.toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
		await expect(observe.recentMessages({ target: "cousin" })).rejects.toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
		await expect(messaging.sendAgentMessage({ target: "cousin", message: "no" })).rejects.toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
	});

	it("resolves a duplicate session name to the only family-reachable agent", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-family-name-resolution.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const observer = makeAgentFamilyState("observer", "observer");
		const familyHelper = makeAgentFamilyState("family-helper", "helper", observer.state);
		const otherRoot = makeAgentFamilyState("other-root", "other-root");
		const unrelatedHelper = makeAgentFamilyState("unrelated-helper", "helper", otherRoot.state);
		const internals = daemonInternals(daemon);
		for (const fixture of [observer, familyHelper, otherRoot, unrelatedHelper]) {
			internals.sessions.set(fixture.state.activeSessionId, fixture.state);
		}

		const observe = internals.createAgentObserveController(() => observer.state);
		await expect(observe.getAgent("helper")).resolves.toMatchObject({
			agent: { activeSessionId: familyHelper.state.activeSessionId },
		});
		await expect(observe.recentMessages({ target: "helper" })).resolves.toMatchObject({
			agent: { activeSessionId: familyHelper.state.activeSessionId },
		});
		await expect(
			internals
				.createAgentMessageController(() => observer.state)
				.sendAgentMessage({ target: "helper", message: "report progress" }),
		).resolves.toMatchObject({ target: { activeSessionId: familyHelper.state.activeSessionId } });
		expect(familyHelper.acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(unrelatedHelper.acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("keeps a session ID ambiguous when a reachable agent uses it as its name", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-family-id-ambiguity.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const parent = makeAgentFamilyState("parent", "parent");
		const observer = makeAgentFamilyState("observer", "observer", parent.state);
		const sibling = makeAgentFamilyState("sibling", parent.state.runtime.session.sessionId, parent.state);
		const internals = daemonInternals(daemon);
		for (const fixture of [parent, observer, sibling]) {
			internals.sessions.set(fixture.state.activeSessionId, fixture.state);
		}
		const expectedError = `Ambiguous active session "${parent.state.runtime.session.sessionId}"`;

		await expect(
			internals.createAgentObserveController(() => observer.state).getAgent(parent.state.runtime.session.sessionId),
		).rejects.toThrow(expectedError);
		await expect(
			internals
				.createAgentMessageController(() => observer.state)
				.sendAgentMessage({ target: parent.state.runtime.session.sessionId, message: "report progress" }),
		).rejects.toThrow(expectedError);
		expect(parent.acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(sibling.acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("keeps a duplicate session name ambiguous when two family agents are reachable", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-family-name-ambiguity.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const parent = makeAgentFamilyState("parent", "helper");
		const observer = makeAgentFamilyState("observer", "observer", parent.state);
		const sibling = makeAgentFamilyState("sibling", "helper", parent.state);
		const internals = daemonInternals(daemon);
		for (const fixture of [parent, observer, sibling]) {
			internals.sessions.set(fixture.state.activeSessionId, fixture.state);
		}
		const expectedError = 'Ambiguous active session "helper"';

		await expect(internals.createAgentObserveController(() => observer.state).getAgent("helper")).rejects.toThrow(
			expectedError,
		);
		await expect(
			internals
				.createAgentMessageController(() => observer.state)
				.sendAgentMessage({ target: "helper", message: "report progress" }),
		).rejects.toThrow(expectedError);
		expect(parent.acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(sibling.acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("serializes concurrent agent messages to an idle target", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const promptResolves: Array<() => void> = [];
		const prompt = vi.fn(
			(_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) =>
				new Promise<void>((resolve) => {
					promptResolves.push(resolve);
				}),
		);
		const followUp = vi.fn(async () => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { prompt, followUp },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		const second = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "second",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(1);

		promptResolves[0]?.();
		await expect(first).resolves.toMatchObject({ message: "first" });
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(followUp).not.toHaveBeenCalled();
		promptResolves[1]?.();
		await expect(second).resolves.toMatchObject({ message: "second" });
	});

	it("queues agent messages behind an idle target with a pending retry", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const prompt = vi.fn(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
		const followUp = vi.fn(async () => true);
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			isRetrying: true,
			unfinishedActionCount: 0,
			session: { prompt, followUp, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind retry",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(followUp).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("queues agent messages behind existing pending work on an idle target", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const prompt = vi.fn(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
		const followUp = vi.fn(async () => true);
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 1,
			session: { prompt, followUp, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind existing work",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(followUp).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("queues agent messages while the target is compacting", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const prompt = vi.fn(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			isCompacting: true,
			unfinishedActionCount: 0,
			session: { prompt, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind compaction",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("queues agent messages while target bash is running", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			isBashRunning: true,
			unfinishedActionCount: 0,
			session: { acceptAgentMessagePrompt, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind bash",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("acknowledges queued agent messages after queue insertion", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		let resolveQueuedDelivery: () => void = () => {};
		const waitForAgentMessagePromptDelivery = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveQueuedDelivery = resolve;
				}),
		);
		const queueAgentMessagePrompt = vi.fn(async () => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: true,
			unfinishedActionCount: 0,
			session: { queueAgentMessagePrompt, waitForAgentMessagePromptDelivery },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(waitForAgentMessagePromptDelivery).not.toHaveBeenCalled();
		resolveQueuedDelivery();
	});

	it("recomputes agent message streaming behavior after waiting for the target lock", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const promptResolves: Array<() => void> = [];
		const prompt = vi.fn(
			(_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) =>
				new Promise<void>((resolve) => {
					promptResolves.push(resolve);
				}),
		);
		const followUp = vi.fn(async () => true);
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { prompt, followUp, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		const second = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "second",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(1);
		(targetState.runtime.session as { isStreaming: boolean }).isStreaming = true;
		promptResolves[0]?.();
		await expect(first).resolves.toMatchObject({ message: "first" });
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(followUp).not.toHaveBeenCalled();
		await expect(second).resolves.toMatchObject({ message: "second" });
	});

	it("rejects agent messages when queued delivery is coalesced", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const queueAgentMessagePrompt = vi.fn(async () => false);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: true,
			unfinishedActionCount: 1,
			session: { queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "coalesced",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent message was not queued");
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
	});

	it("rejects agent messages when direct delivery preflight fails", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(false);
				return Promise.resolve();
			},
		);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { acceptAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "not accepted",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent message was not accepted");
	});

	it("queues agent messages while daemon prompts prepare to stream", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let resolvePrompt: () => void = () => {};
		let reportPreflight: ((didSucceed: boolean) => void) | undefined;
		const prompt = vi.fn((_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			reportPreflight = options?.preflightResult;
			return new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		});
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { prompt, acceptAgentMessagePrompt, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);
		const promptClient = makeClient("client-1", targetState.activeSessionId);
		(promptClient.socket as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn();

		internals.handleCommand(promptClient, {
			id: "command-1",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "normal prompt",
		});
		await Promise.resolve();
		await Promise.resolve();
		reportPreflight?.(true);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});
		await Promise.resolve();
		await send;
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		resolvePrompt();
	});

	it("waits for an in-flight agent-message accept before starting daemon prompts", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let resolveAccept: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolveAccept = resolve;
				});
			},
		);
		const prompt = vi.fn(async (_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			options?.preflightResult?.(true);
		});
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { prompt, acceptAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();

		const promptClient = makeClient("client-1", targetState.activeSessionId);
		(promptClient.socket as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn();
		internals.handleCommand(promptClient, {
			id: "command-1",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "normal prompt",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();

		resolveAccept();
		await send;
		for (let attempt = 0; attempt < 10 && prompt.mock.calls.length === 0; attempt++) {
			await Promise.resolve();
		}

		expect(prompt).toHaveBeenCalledOnce();
	});

	it("releases cron preparing state after prompt admission", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let resolvePrompt: () => void = () => {};
		const prompt = vi.fn(
			(_message: string, _options?: unknown) =>
				new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		const promptUntilAccepted = vi.fn(async () => {});
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			isBashRunning: false,
			unfinishedActionCount: 0,
			session: { prompt, promptUntilAccepted, acceptAgentMessagePrompt, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const cronRun = internals.runCronJob(
			makeCronJob({ id: "cron-1", source: "cron", activeSessionId: targetState.activeSessionId }),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(promptUntilAccepted).toHaveBeenCalledOnce();
		expect(prompt).not.toHaveBeenCalled();

		await internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});

		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt).not.toHaveBeenCalled();
		resolvePrompt();
		await cronRun;
	});

	it("keeps the preparing state until every concurrent prompt settles", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		const promptResolves: Array<() => void> = [];
		const prompt = vi.fn(
			(_message: string, _options?: unknown) =>
				new Promise<void>((resolve) => {
					promptResolves.push(resolve);
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { prompt, acceptAgentMessagePrompt, queueAgentMessagePrompt },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);
		const promptClient = makeClient("client-1", targetState.activeSessionId);
		(promptClient.socket as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn();

		internals.handleCommand(promptClient, {
			id: "command-1",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "first prompt",
		});
		internals.handleCommand(promptClient, {
			id: "command-2",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "second prompt",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(prompt).toHaveBeenCalledTimes(2);

		// The first prompt settles; the second is still in preflight, so agent
		// messages must keep queueing (a plain Set would have lost the flag here).
		promptResolves[0]?.();
		await Promise.resolve();
		await Promise.resolve();

		await internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});

		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		promptResolves[1]?.();
	});

	it("re-checks agent message queue capacity after waiting for the target lock", async () => {
		const daemon = stubDaemon();

		const fromState = makeState("source");
		const targetState = makeState("target");
		applySession(fromState, { sessionId: "session-source", sessionName: "Source" });
		let resolveFirstPrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveFirstPrompt = resolve;
				}),
		);
		const followUp = vi.fn(async () => true);
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { acceptAgentMessagePrompt, followUp },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		const second = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "second",
			fromState,
			origin: "agent",
		});
		// "first" must actually be parked inside acceptAgentMessagePrompt — holding the target lock
		// and its queue reservation, past its own capacity check — before the pending count is
		// bumped. Microtask pumps do not reliably cross the awaits in between, so wait on the mock.
		await vi.waitFor(() => expect(acceptAgentMessagePrompt).toHaveBeenCalledTimes(1));
		(targetState.runtime.session as { unfinishedActionCount: number }).unfinishedActionCount = 20;

		// Capture both settlements before releasing the lock: "second" rejects as soon as "first"
		// hands the target lock over, and bun:test reports a rejection whose handler is attached
		// only afterwards as an unhandled rejection.
		const secondError = second.then(
			() => undefined,
			(error: unknown) => error,
		);
		resolveFirstPrompt();
		await expect(first).resolves.toMatchObject({ message: "first" });
		const rejection = await secondError;
		expect(rejection).toBeInstanceOf(Error);
		expect(String(rejection)).toContain("Target session has too many pending messages");
		expect(followUp).not.toHaveBeenCalled();
	});

	it("rate limits CLI agent messages by stable daemon identity", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			prompt: vi.fn(async () => {}),
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.handleCommand(makeClient(`client-${i}`, targetState.activeSessionId), {
					id: `command-${i}`,
					type: "send_message",
					targetActiveSessionId: targetState.activeSessionId,
					message: `message ${i}`,
				}),
			).resolves.toMatchObject({ success: true });
		}
		await expect(
			internals.handleCommand(makeClient("client-4", targetState.activeSessionId), {
				id: "command-4",
				type: "send_message",
				targetActiveSessionId: targetState.activeSessionId,
				message: "over limit",
			}),
		).rejects.toThrow("Agent messaging rate limit exceeded");
	});

	it("holds the target lock while clearing queued agent messages", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let resolvePrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			},
		);
		const clearQueuedUserMessagesMatching = vi.fn(() => ({ steering: [], followUp: [] }));
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { acceptAgentMessagePrompt, clearQueuedUserMessagesMatching },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();
		expect(clearQueuedUserMessagesMatching).not.toHaveBeenCalled();

		resolvePrompt();
		await send;
		await clear;
		expect(clearQueuedUserMessagesMatching).toHaveBeenCalledOnce();
	});

	it("rejects agent messages when pause wins the target lock", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let resolveBlockedClear: () => void = () => {};
		const clearQueuedUserMessagesMatching = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { acceptAgentMessagePrompt, clearQueuedUserMessagesMatching },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const pause = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});
		await Promise.resolve();
		await Promise.resolve();

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "after pause requested",
			origin: "agent",
		});
		await Promise.resolve();
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();

		resolveBlockedClear();
		await pause;
		await expect(send).rejects.toThrow("Agent messaging is paused");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages when the target session changes before delivery", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		let resolveBlockedClear: () => void = () => {};
		const clearQueuedUserMessagesMatching = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		applySession(targetState, {
			cwd: "/tmp",
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: { acceptAgentMessagePrompt, clearQueuedUserMessagesMatching },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();
		await Promise.resolve();

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "after session switch",
			origin: "agent",
		});
		await Promise.resolve();
		(targetState.runtime.session as { sessionId: string }).sessionId = "session-replacement";
		resolveBlockedClear();
		await clear;

		await expect(send).rejects.toThrow("Target session changed before agent message delivery");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages when the target session closes before delivery", async () => {
		const daemon = stubDaemon();

		const targetState = makeState("target");
		targetState.extensionUiRequests = new Map();
		let resolveBlockedClear: () => void = () => {};
		const clearQueuedUserMessagesMatching = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const dispose = vi.fn(async () => {});
		applySession(targetState, {
			cwd: "/tmp",
			kind: "subagent",
			metadata: { createdAt: 1 },
			sessionId: "session-target",
			sessionName: "Target",
			isStreaming: false,
			unfinishedActionCount: 0,
			session: {
				messages: [],
				acceptAgentMessagePrompt,
				clearQueuedUserMessagesMatching,
				abort: vi.fn(async () => {}),
				dispose: vi.fn(),
				sessionManager: { appendSessionState: vi.fn(), hasUserContent: () => true },
			},
			runtime: { dispose },
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();
		await Promise.resolve();

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "after close requested",
			origin: "agent",
		});
		await Promise.resolve();

		const close = internals.handleCommand(makeClient("client-2", targetState.activeSessionId), {
			id: "command-2",
			type: "kill",
			activeSessionId: targetState.activeSessionId,
		});
		await close;
		expect(dispose).toHaveBeenCalledOnce();

		resolveBlockedClear();
		await clear;
		await expect(send).rejects.toThrow("Target session is closing before agent message delivery");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages to the sending session", async () => {
		const daemon = stubDaemon();

		const state = makeState("self");
		applySession(state, {
			cwd: "/tmp",
			sessionId: "session-self",
			sessionName: "Self",
			isStreaming: false,
			unfinishedActionCount: 0,
			prompt: vi.fn(async () => {}),
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: state.activeSessionId,
				message: "self",
				fromState: state,
				origin: "agent",
			}),
		).rejects.toThrow("Agent messaging cannot target the sending session");
		expect(state.runtime.session.prompt).not.toHaveBeenCalled();
	});

	it("sends dialog extension UI requests only to UI-capable clients", () => {
		const lineClient = makeClient("line-client", "active", false);
		const uiClient = makeClient("ui-client", "active", true);
		const dialogRequest = {
			type: "extension_ui_request",
			activeSessionId: "active",
			id: "request-1",
			method: "confirm",
			payload: {},
		} as const;

		expect(shouldSendDaemonOutboundToClient(lineClient, dialogRequest)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(lineClient, {
				...dialogRequest,
				method: "notify",
			}),
		).toBe(true);

		setDaemonClientSessionCapabilities(uiClient, "active", new Set(["extension_ui"]));
		setDaemonClientSessionCapabilities(uiClient, "other", new Set());
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(uiClient, {
				...dialogRequest,
				activeSessionId: "other",
			}),
		).toBe(false);
	});

	it("delivers session closure while a client is snapshotting and backpressured", () => {
		const daemon = stubDaemon();

		const state = makeState("active");
		state.eventGeneration = "generation-1";
		const write = vi.fn((_data: unknown) => false);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
		client.snapshotActiveSessionIds = new Set([state.activeSessionId]);
		client.snapshotStreaming = true;
		client.backpressured = true;
		client.catchupActiveSessionIds = new Set([state.activeSessionId]);
		state.clients.add(client);
		const internals = daemonInternals(daemon);

		internals.broadcastToSession(state, {
			type: "session_closed",
			activeSessionId: state.activeSessionId,
			reason: "killed",
		});

		expect(write).toHaveBeenCalledOnce();
		expect(String(write.mock.calls[0]?.[0])).toContain('"type":"session_closed"');
		expect(client.catchupActiveSessionIds).not.toContain(state.activeSessionId);
	});

	it("catches up on drain only after events are skipped behind a backpressured write", async () => {
		const daemon = stubDaemon();

		const state = makeState("active");
		state.eventGeneration = "generation-1";
		const writes: string[] = [];
		const write = vi.fn((data: unknown) => {
			writes.push(String(data));
			return writes.length === 1;
		});
		const socket = Object.assign(new EventEmitter(), { destroyed: false, write }) as unknown as Socket;
		const internals = daemonInternals(daemon);
		internals.handleConnection(socket);
		const client = [...internals.clients][0]!;
		client.attachedActiveSessionIds.add(state.activeSessionId);
		state.clients.add(client);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = () =>
			({
				activeSessionId: state.activeSessionId,
				snapshot: { lastEventSequence: state.lastEventSequence },
				lastEventSequence: state.lastEventSequence,
			}) as unknown as DaemonAttachResult;

		internals.broadcastToSession(state, {
			type: "extension_error",
			activeSessionId: state.activeSessionId,
			extensionPath: "x".repeat(1024 * 1024),
			event: "load",
			error: "first",
		});

		expect(client.backpressured).toBe(true);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(writes).toHaveLength(2);
		expect(writes[1]).toContain('"error":"first"');

		internals.broadcastToSession(state, {
			type: "extension_error",
			activeSessionId: state.activeSessionId,
			extensionPath: "/tmp/extension.ts",
			event: "load",
			error: "skipped",
		});

		expect(writes).toHaveLength(2);
		expect(client.catchupActiveSessionIds).toEqual(new Set([state.activeSessionId]));

		write.mockImplementation((data: unknown) => {
			writes.push(String(data));
			return true;
		});
		socket.emit("drain");
		await vi.waitFor(() => expect(writes).toHaveLength(3));

		expect(JSON.parse(writes[2] ?? "{}")).toMatchObject({
			type: "session_resynced",
			activeSessionId: state.activeSessionId,
			meta: { sequence: 2, cursor: { generation: "generation-1", sequence: 2 } },
			snapshot: { lastEventSequence: 2 },
		});
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it("automatically retries every pending catch-up after snapshot creation rejects", async () => {
		const daemon = stubDaemon();

		const firstState = makeState("first");
		const secondState = makeState("second");
		firstState.eventGeneration = "generation-1";
		secondState.eventGeneration = "generation-2";
		const write = vi.fn((_data: unknown) => true);
		const client = makeClient("client-1", firstState.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
		firstState.clients.add(client);
		secondState.clients.add(client);
		const createAttachResult = vi.fn(async (_client: DaemonSocketClient, state: ActiveSessionState) => {
			if (createAttachResult.mock.calls.length === 1) {
				throw new Error("snapshot creation failed");
			}
			return {
				activeSessionId: state.activeSessionId,
				snapshot: {
					activeSessionId: state.activeSessionId,
					state: { activeSessionId: state.activeSessionId },
					messages: [],
					lastEventSequence: state.lastEventSequence,
				},
				lastEventSequence: state.lastEventSequence,
			} as unknown as DaemonAttachResult;
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(firstState.activeSessionId, firstState);
		internals.sessions.set(secondState.activeSessionId, secondState);
		internals.createAttachResult = createAttachResult;
		internals.queueClientCatchup(client, firstState.activeSessionId, "replacement");
		internals.queueClientCatchup(client, secondState.activeSessionId, "resync");

		await internals.catchUpBackpressuredClient(client);

		expect(client.catchupActiveSessionIds).toEqual(
			new Set([firstState.activeSessionId, secondState.activeSessionId]),
		);
		expect(client.catchupPurposes).toEqual(
			new Map([
				[firstState.activeSessionId, "replacement"],
				[secondState.activeSessionId, "resync"],
			]),
		);
		expect(createAttachResult).toHaveBeenCalledOnce();

		await vi.waitFor(() => expect(createAttachResult).toHaveBeenCalledTimes(3));

		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(client.catchupPurposes).toEqual(new Map());
		const messages = write.mock.calls.map(([data]) => JSON.parse(String(data)) as { type: string });
		expect(messages.map((message) => message.type)).toEqual(["session_replaced", "session_resynced"]);
	});

	it("clears a scheduled catch-up retry when the client disconnects", async () => {
		const daemon = stubDaemon();

		const state = makeState("active");
		state.extensionUiRequests = new Map();
		const socketState = { destroyed: false };
		const socket = Object.assign(new EventEmitter(), {
			get destroyed() {
				return socketState.destroyed;
			},
			write: vi.fn((_data: unknown) => true),
		}) as unknown as Socket;
		const createAttachResult = vi.fn(async () => {
			throw new Error("snapshot creation failed");
		});
		const internals = daemonInternals(daemon);
		internals.handleConnection(socket);
		const client = [...internals.clients][0]!;
		client.attachedActiveSessionIds.add(state.activeSessionId);
		state.clients.add(client);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = createAttachResult;
		internals.queueClientCatchup(client, state.activeSessionId);

		await internals.catchUpBackpressuredClient(client);

		expect(client.catchupRetryTimer).toBeDefined();
		socketState.destroyed = true;
		socket.emit("close");
		expect(client.catchupRetryTimer).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(createAttachResult).toHaveBeenCalledOnce();
	});

	it("does not attach a non-chunked client until its snapshot is ready", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-test.sock",
			agentDir: "/tmp/optimus-test-agent",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const state = makeState("active");
		const client = makeClient("client-1", state.activeSessionId);
		client.attachedActiveSessionIds.clear();
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const result = {
			activeSessionId: state.activeSessionId,
			snapshot: { summary: {}, state: {}, messages: [] },
			lastEventSequence: 0,
		} as unknown as DaemonAttachResult;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = vi.fn(async () => {
			await snapshotGate;
			return result;
		});

		const attach = internals.handleCommand(client, { type: "attach", activeSessionId: state.activeSessionId });
		await vi.waitFor(() => expect(internals.createAttachResult).toHaveBeenCalledOnce());
		expect(state.clients).not.toContain(client);
		expect(client.attachedActiveSessionIds).not.toContain(state.activeSessionId);
		releaseSnapshot();
		await attach;
		expect(state.clients).toContain(client);
		expect(client.attachedActiveSessionIds).toContain(state.activeSessionId);
	});

	it("rejects an attach when its session closes during snapshot creation", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-test.sock",
			agentDir: "/tmp/optimus-test-agent",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const state = makeState("active");
		const client = makeClient("client-1", state.activeSessionId);
		client.attachedActiveSessionIds.clear();
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = vi.fn(async () => {
			await snapshotGate;
			return { activeSessionId: state.activeSessionId, snapshot: {}, lastEventSequence: 0 };
		});

		const attach = internals.handleCommand(client, { type: "attach", activeSessionId: state.activeSessionId });
		await vi.waitFor(() => expect(state.pendingAttaches).toBe(1));
		internals.sessions.delete(state.activeSessionId);
		releaseSnapshot();

		await expect(attach).rejects.toThrow(`Active session ${state.activeSessionId} closed during attach`);
		expect(state.pendingAttaches).toBe(0);
		expect(state.clients).not.toContain(client);
		expect(client.attachedActiveSessionIds).not.toContain(state.activeSessionId);
	});

	it("drops a backpressure catch-up when the client detaches during snapshot creation", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-test.sock",
			agentDir: "/tmp/optimus-test-agent",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const state = makeState("active");
		const write = vi.fn(() => true);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
		client.catchupActiveSessionIds = new Set([state.activeSessionId]);
		state.clients.add(client);
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const result = {
			activeSessionId: state.activeSessionId,
			snapshot: { summary: {}, state: {}, messages: [], lastEventSequence: 0 },
			lastEventSequence: 0,
		} as unknown as DaemonAttachResult;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = vi.fn(async () => {
			await snapshotGate;
			return result;
		});

		const catchup = internals.drainBackpressuredClientCatchups(client);
		await vi.waitFor(() => expect(internals.createAttachResult).toHaveBeenCalledOnce());
		state.clients.delete(client);
		client.attachedActiveSessionIds.delete(state.activeSessionId);
		releaseSnapshot();
		await catchup;
		expect(write).not.toHaveBeenCalled();
	});

	it("marks a chunked attach as snapshotting before deferred streaming", async () => {
		await withTempDir("optimus-daemon-snapshot-order-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const state = makeState("active");
			state.eventGeneration = "generation-1";
			const client = makeClient("client-1", state.activeSessionId);
			client.transport = "private-framed";
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: { summary: {}, state: {}, messages: [] },
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const streamWorkerSnapshot = vi.fn(async () => undefined);
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = () => result;
			internals.streamWorkerSnapshot = streamWorkerSnapshot;

			await internals.handleCommand(client, {
				type: "attach",
				activeSessionId: state.activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			});

			expect(client.snapshotActiveSessionIds).toContain(state.activeSessionId);
			expect(client.snapshotStreaming).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(streamWorkerSnapshot).toHaveBeenCalledOnce();
		});
	});

	it("keeps overlapping snapshots active until every stream finishes", () => {
		const client = makeClient("client-1", "active");

		markClientSnapshotStreaming(client, "active");
		markClientSnapshotStreaming(client, "active");
		finishClientSnapshotStreaming(client, "active");

		expect(client.snapshotStreaming).toBe(true);
		expect(client.snapshotActiveSessionIds).toContain("active");
		expect(client.snapshotActiveSessionCounts?.get("active")).toBe(1);

		finishClientSnapshotStreaming(client, "active");
		expect(client.snapshotStreaming).toBe(false);
		expect(client.snapshotActiveSessionIds).not.toContain("active");
	});

	it("falls back to a full replacement when snapshot cache creation fails", async () => {
		await withTempDir("optimus-daemon-replacement-fallback-", async (root) => {
			const invalidAgentDir = join(root, "not-a-directory");
			writeFileSync(invalidAgentDir, "file");
			const daemon = stubDaemon({ socketPath: join(root, "daemon.sock"), agentDir: invalidAgentDir, cwd: root });

			const state = makeState("active");
			state.eventGeneration = "generation-1";
			const write = vi.fn((_data: unknown) => true);
			const client = makeClient("client-1", state.activeSessionId);
			client.socket = { destroyed: false, write } as unknown as Socket;
			client.transport = "private-framed";
			setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
			state.clients.add(client);
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: {
					summary: {},
					state: {},
					messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 1), timestamp: 0 }],
				},
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = async () => result;

			internals.broadcastToSession(state, {
				type: "session_replaced",
				activeSessionId: state.activeSessionId,
				state: {},
				messages: [],
			});

			await vi.waitFor(() => expect(write).toHaveBeenCalled());
			const frames = write.mock.calls.map((call) => String(call[0])).join("\n");
			expect(frames).toContain('"type":"session_replaced"');
			expect(frames).toContain('"snapshotFollows":true');
			expect(frames).toContain('"type":"session_snapshot_begin"');
		});
	});

	it.each(["resolved", "rejected"] as const)(
		"does not send a replacement snapshot after the session closes while preparation is %s",
		async (outcome) => {
			const daemon = stubDaemon();

			const state = makeState("active");
			state.eventGeneration = "generation-1";
			state.extensionUiRequests = new Map();
			state.unsubscribe = vi.fn();
			applySession(state, {
				sessionId: "session-active",
				sessionFile: undefined,
				isBashRunning: false,
				session: { abort: vi.fn(async () => {}), sessionManager: { appendSessionState: vi.fn() } },
				runtime: { dispose: vi.fn(async () => {}) },
			});
			const write = vi.fn((_data: unknown) => true);
			const client = makeClient("client-1", state.activeSessionId);
			client.socket = { destroyed: false, write } as unknown as Socket;
			client.transport = "private-framed";
			setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
			state.clients.add(client);
			let resolveAttach: (result: DaemonAttachResult) => void = () => {};
			let rejectAttach: (error: Error) => void = () => {};
			const pendingAttach = new Promise<DaemonAttachResult>((resolve, reject) => {
				resolveAttach = resolve;
				rejectAttach = reject;
			});
			const streamWorkerSnapshot = vi.fn(async () => {});
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = vi.fn(() => pendingAttach);
			internals.streamWorkerSnapshot = streamWorkerSnapshot;
			internals.closeChildSessions = vi.fn(async () => undefined);
			internals.isEmptyDraftContent = vi.fn(() => true);
			internals.abortBashForClose = vi.fn(async () => {});
			internals.recordWorkerRecoveryState = vi.fn();
			internals.cancelScheduledJobsForSession = vi.fn();

			internals.broadcastToSession(state, {
				type: "session_replaced",
				activeSessionId: state.activeSessionId,
				state: {},
				messages: [],
			});
			const snapshotSignal = client.snapshotTransferAbortControllers?.get(state.activeSessionId)?.signal;
			expect(snapshotSignal?.aborted).toBe(false);

			await internals.closeSession(state, "killed");
			expect(snapshotSignal?.aborted).toBe(true);

			if (outcome === "resolved") {
				resolveAttach({
					activeSessionId: state.activeSessionId,
					snapshot: { summary: {}, state: {}, messages: [] },
					lastEventSequence: 0,
				} as unknown as DaemonAttachResult);
			} else {
				rejectAttach(new Error("snapshot preparation failed after close"));
			}
			await vi.waitFor(() => expect(client.snapshotStreaming).toBe(false));

			const frames = write.mock.calls.map((call) => String(call[0])).join("\n");
			expect(frames).toContain('"type":"session_closed"');
			expect(frames).not.toContain('"type":"session_replaced"');
			expect(frames).not.toContain('"type":"session_snapshot_begin"');
			expect(streamWorkerSnapshot).not.toHaveBeenCalled();
		},
	);

	it("drains queued catch-up after replacement snapshot preparation outlives its session", async () => {
		const daemon = stubDaemon();

		const state = makeState("closing");
		state.eventGeneration = "generation-1";
		const otherState = makeState("queued");
		const client = makeClient("client-1", state.activeSessionId);
		client.transport = "private-framed";
		setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
		state.clients.add(client);
		let resolveAttach: (result: DaemonAttachResult) => void = () => {};
		const pendingAttach = new Promise<DaemonAttachResult>((resolve) => {
			resolveAttach = resolve;
		});
		const catchUpBackpressuredClient = vi.fn(async (target: DaemonSocketClient) => {
			target.catchupActiveSessionIds?.clear();
		});
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.sessions.set(otherState.activeSessionId, otherState);
		internals.createAttachResult = vi.fn(() => pendingAttach);
		internals.catchUpBackpressuredClient = catchUpBackpressuredClient;

		internals.broadcastToSession(state, {
			type: "session_replaced",
			activeSessionId: state.activeSessionId,
			state: {},
			messages: [],
		} as unknown as DaemonOutbound);
		client.catchupActiveSessionIds = new Set([otherState.activeSessionId]);
		internals.sessions.delete(state.activeSessionId);
		resolveAttach({
			activeSessionId: state.activeSessionId,
			snapshot: { summary: {}, state: {}, messages: [] },
			lastEventSequence: 0,
		} as unknown as DaemonAttachResult);

		await vi.waitFor(() => expect(catchUpBackpressuredClient).toHaveBeenCalledWith(client));
		expect(client.snapshotStreaming).toBe(false);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it.each([
		["explicit session file", (sessionPath: string) => ({ type: "create" as const, sessionPath })],
		["continue recent", (_sessionPath: string) => ({ type: "create" as const, continueRecent: true })],
	])("deduplicates concurrent creates after resolving the %s", async (_label, commandFor) => {
		await withTempDir("optimus-daemon-open-race-", async (tempDir) => {
			const recent = SessionManager.create(tempDir, tempDir);
			const sessionPath = recent.materializeSessionFile();
			recent.appendSessionInfo("Recent");
			let releaseCreate: () => void = () => {};
			const createBarrier = new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				await createBarrier;
				return {
					session: makeRuntimeSession(options.sessionManager),
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			const first = create(commandFor(sessionPath));
			const second = create(commandFor(sessionPath));
			// The pre-create session resolution is async (continueRecent scans the
			// session dir); wait on a deadline, not a fixed number of ticks.
			await vi.waitFor(() => {
				expect(createRuntime).toHaveBeenCalledTimes(1);
			});
			releaseCreate();
			const [firstState, secondState] = await Promise.all([first, second]);
			expect(secondState).toBe(firstState);
			expect(firstState.runtime.session.sessionFile).toBe(sessionPath);
			expect(createRuntime).toHaveBeenCalledTimes(1);
		});
	});

	it("adopts client env on session reuse only when the session has none", async () => {
		await withTempDir("optimus-daemon-env-", async (tempDir) => {
			const sessionPath = join(tempDir, "session.jsonl");
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				return {
					session: makeRuntimeSession(options.sessionManager),
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			// Created env-less (e.g. by a cron job), then opened by an env-carrying
			// client: the session adopts the client's allowlisted identity.
			const state = await create({ type: "create", sessionPath });
			expect(state.clientEnv).toBeUndefined();
			const adopted = await create({
				type: "create",
				sessionPath,
				env: { HERDR_PANE_ID: "w1:p1", PATH: "/evil" },
			});
			expect(adopted).toBe(state);
			expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });

			// A later client with a different env must not rebind the identity
			// that extensions already captured.
			await create({ type: "create", sessionPath, env: { HERDR_PANE_ID: "w2:p9" } });
			expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });
		});
	});

	it("uses the binding session as its own list and roster context", async () => {
		await withTempDir("optimus-daemon-controller-race-", async (tempDir) => {
			let listedAgentsDuringBind = 0;
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					const controller = options.sessionOptions?.agentMessageController;
					const result = await controller?.listAgents();
					expect(result?.current?.activeSessionId).toBeTruthy();
					await expect(controller?.roster?.()).resolves.toMatchObject({
						current: { id: session.sessionId },
					});
					listedAgentsDuringBind++;
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			await create({ type: "create", sessionPath: join(tempDir, "session-1.jsonl") });
			await create({ type: "create", sessionPath: join(tempDir, "session-2.jsonl") });

			expect(listedAgentsDuringBind).toBe(2);
		});
	});

	it("restores a completed subagent through its parent when an RLM heartbeat becomes due", async () => {
		await withTempDir("optimus-daemon-restore-subagent-heartbeat-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "active" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}

			const childId = "heartbeat-child";
			const childSessionDir = join(parentArtifactDir, childId);
			const childManager = SessionManager.create(tempDir, childSessionDir);
			childManager.newSession({ parentSession: parentSessionFile });
			childManager.appendSessionInfo("heartbeat-child");
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId,
					sessionName: "heartbeat-child",
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
				})}\n`,
			);

			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["extensionsResult"],
				services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["services"],
				diagnostics: [],
			}));
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childManager.getSessionId(),
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			const childState = await internals.getOrCreateCronJobSession(heartbeat, true);

			expect(childState.runtime.metadata).toMatchObject({
				kind: "subagent",
				rlmChildId: childId,
			});
			expect(createRuntime).toHaveBeenCalledTimes(2);
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				activeSessionId: childState.activeSessionId,
				sessionId: childManager.getSessionId(),
			});
		});
	});

	it("replaces a resident top-level RLM child when restoring its heartbeat", async () => {
		await withTempDir("optimus-daemon-replace-child-heartbeat-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentManager = SessionManager.open(fixture.parentSessionFile);
			parentManager.appendSessionState({ status: "active" });
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrCreateCronJobSession(
					job: AgentCronJob,
					requirePersistedJob: boolean,
				): Promise<ActiveSessionState | undefined>;
			};
			const topLevelState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
			});
			expect(topLevelState.runtime.metadata.kind).toBe("top-level");
			const topLevelAbort = topLevelState.runtime.session.abort as ReturnType<typeof vi.fn>;
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: topLevelState.runtime.session.sessionId,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			const childState = await internals.getOrCreateCronJobSession(heartbeat, true);

			expect(childState).toBeDefined();
			expect(childState).not.toBe(topLevelState);
			expect(childState?.runtime.metadata).toMatchObject({
				kind: "subagent",
				rlmChildId: fixture.childId,
			});
			expect(topLevelAbort).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				activeSessionId: childState?.activeSessionId,
			});
		});
	});

	it("cancels an RLM heartbeat for a resident top-level session that is not a registered child", async () => {
		await withTempDir("optimus-daemon-nonchild-heartbeat-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "active" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}
			const sessionManager = SessionManager.create(tempDir, join(parentArtifactDir, "unregistered-child"));
			sessionManager.newSession({ parentSession: parentSessionFile });
			sessionManager.appendSessionState({ status: "active" });
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Missing session file");
			}
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["extensionsResult"],
				services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["services"],
				diagnostics: [],
			}));
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const topLevelState = await internals.createRuntime({ type: "create", sessionPath: sessionFile });
			const abort = topLevelState.runtime.session.abort as ReturnType<typeof vi.fn>;
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: topLevelState.activeSessionId,
				sessionId: sessionManager.getSessionId(),
				sessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			await expect(internals.getOrCreateCronJobSession(heartbeat, true)).resolves.toBeUndefined();
			expect(abort).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
			expect(createRuntime).toHaveBeenCalledTimes(2);
			expect(createRuntime.mock.calls[1]?.[0].sessionManager.getSessionFile()).toBe(parentSessionFile);
		});
	});

	it("waits for a concurrently hydrating heartbeat child to finish binding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-heartbeat-hydration-race-"));
		let releasePassiveList!: () => void;
		const passiveListGate = new Promise<void>((resolve) => {
			releasePassiveList = resolve;
		});
		let markPassiveListStarted!: () => void;
		const passiveListStarted = new Promise<void>((resolve) => {
			markPassiveListStarted = resolve;
		});
		let releaseBinding!: () => void;
		const bindingGate = new Promise<void>((resolve) => {
			releaseBinding = resolve;
		});
		let markBindingStarted!: () => void;
		const bindingStarted = new Promise<void>((resolve) => {
			markBindingStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childBindingStarted: markBindingStarted,
				childBindingGate: bindingGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<unknown[]>;
				restoreRlmHeartbeatSession(job: AgentCronJob): Promise<ActiveSessionState | undefined>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childInfo.id,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			const listPassive = internals.listPassiveRlmSubagents.bind(fixture.daemon);
			let blockNextList = true;
			internals.listPassiveRlmSubagents = vi.fn(async () => {
				if (blockNextList) {
					blockNextList = false;
					markPassiveListStarted();
					await passiveListGate;
				}
				return listPassive();
			});

			let restored = false;
			const restoration = internals.restoreRlmHeartbeatSession(heartbeat).then((state) => {
				restored = true;
				return state;
			});
			await passiveListStarted;
			const hydration = internals.getOrHydrateBoundSessionState(fixture.childId);
			await bindingStarted;
			releasePassiveList();
			await Promise.resolve();
			expect(restored).toBe(false);
			releaseBinding();

			const [restoredState, hydratedState] = await Promise.all([restoration, hydration]);
			expect(restoredState).toBe(hydratedState);
		} finally {
			releasePassiveList();
			releaseBinding();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels a detached subagent heartbeat when its parent is archived", async () => {
		await withTempDir("optimus-daemon-archived-subagent-heartbeat-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "archived" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}
			const childManager = SessionManager.create(tempDir, join(parentArtifactDir, "child-1"));
			childManager.newSession({ parentSession: parentSessionFile });
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}

			const createRuntime = vi.fn(async () => {
				throw new Error("archived parent must not be restored");
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childManager.getSessionId(),
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			await expect(internals.getOrCreateCronJobSession(heartbeat, true)).resolves.toBeUndefined();
			expect(createRuntime).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
		});
	});

	it("reports failed passive children as errors without creating child runtimes", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-list-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			// Simulate children written before rlmDepth was added to the extensible header.
			// Their persisted registry rows remain the compatibility source after restart.
			for (const sessionFile of [fixture.childSessionFile, fixture.grandchildSessionFile]) {
				const lines = readFileSync(sessionFile, "utf8").split("\n");
				const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
				delete header.rlmDepth;
				lines[0] = JSON.stringify(header);
				writeFileSync(sessionFile, lines.join("\n"));
			}
			const parentRegistry = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const failedEntry = JSON.parse(readFileSync(parentRegistry, "utf8").trim()) as Record<string, unknown>;
			// Failed children retain their last "running" registry row after the runtime is released.
			writeFileSync(parentRegistry, `${JSON.stringify({ ...failedEntry, status: "running" })}\n`);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				buildRlmChildSnapshotsWithPassiveRlmSubagents(
					state: ActiveSessionState,
				): Promise<NonNullable<DaemonAttachResult["snapshot"]["children"]>>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};

			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			expect([...internals.sessions.values()]).toEqual([parentState]);
			const children = await internals.buildRlmChildSnapshotsWithPassiveRlmSubagents(parentState);
			expect(children).toEqual([
				expect.objectContaining({
					id: fixture.childId,
					status: "error",
				}),
				expect.objectContaining({
					id: fixture.grandchildId,
					parentId: fixture.childId,
					status: "done",
				}),
			]);
			expect(children.every((child) => child.activeSessionId === undefined)).toBe(true);
			// Snapshotting must reuse the passive registry walk without hydrating children.
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			const listedAgents = await internals.createAgentMessageController(() => parentState).listAgents();
			expect(listedAgents.agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: expect.any(String),
					sessionId: expect.any(String),
					sessionName: "renamed-worker",
					runtimeKind: "subagent",
					parentActiveSessionId: parentState.activeSessionId,
					status: "inactive",
					rlmChildId: fixture.childId,
					rlmChildRegistryStatus: "running",
				}),
			);
			expect(listedAgents.agents).toContainEqual(
				expect.objectContaining({
					sessionName: "nested-worker",
					status: "inactive",
					rlmChildId: fixture.grandchildId,
					rlmChildRegistryStatus: "completed",
				}),
			);
			const observeController = (
				fixture.daemon as unknown as {
					createAgentObserveController(getCurrentState: () => ActiveSessionState): AgentObserveController;
				}
			).createAgentObserveController(() => parentState);
			const observedAgents = await observeController.listAgents();
			expect(observedAgents.agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: expect.any(String),
					sessionName: "renamed-worker",
					runtimeKind: "subagent",
					status: "idle",
					messageCount: 1,
					rlmChildId: fixture.childId,
				}),
			);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();

			const messageController = internals.createAgentMessageController(() => parentState);
			await expect(messageController.roster?.()).resolves.toMatchObject({
				current: { id: parentState.runtime.session.sessionId, depth: 0 },
				entries: [
					expect.objectContaining({ relationship: "child", name: "renamed-worker", depth: 1, status: "inactive" }),
				],
			});
			await expect(
				messageController.assertSessionNameAvailable?.({
					name: "renamed-worker",
					depth: 1,
					parentSessionId: parentState.runtime.session.sessionId,
					parentSessionPath: fixture.parentSessionFile,
				}),
			).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
			const listResponse = (await internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
				type: "list",
				all: true,
			})) as { data: { sessions: Array<Record<string, unknown>> } };
			const passiveRow = listResponse.data.sessions.find(
				(session) => session.sessionFile === fixture.childSessionFile,
			);
			expect(passiveRow).toMatchObject({
				lifecycle: "live",
				sessionName: "renamed-worker",
				runtimeKind: "subagent",
				parentActiveSessionId: parentState.activeSessionId,
				rlmChildId: fixture.childId,
				parentSessionPath: fixture.parentSessionFile,
				rlmDepth: 1,
			});
			expect(passiveRow?.activeSessionId).toBeUndefined();
			const nestedRow = listResponse.data.sessions.find(
				(session) => session.sessionFile === fixture.grandchildSessionFile,
			);
			expect(nestedRow).toMatchObject({
				sessionName: "nested-worker",
				runtimeKind: "subagent",
				rlmChildId: fixture.grandchildId,
				parentSessionPath: fixture.childSessionFile,
				rlmDepth: 2,
			});

			const activeOnlyResponse = (await internals.handleCommand(
				makeClient("client-2", parentState.activeSessionId),
				{ type: "list" },
			)) as { data: { sessions: Array<Record<string, unknown>> } };
			expect(activeOnlyResponse.data.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ sessionFile: fixture.childSessionFile, rlmChildId: fixture.childId }),
					expect.objectContaining({
						sessionFile: fixture.grandchildSessionFile,
						rlmChildId: fixture.grandchildId,
						parentSessionPath: fixture.childSessionFile,
					}),
				]),
			);
		});
	});

	it("lists passive descendants under a nonresident saved root", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-nonresident-root-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentManager = SessionManager.open(fixture.parentSessionFile);
			parentManager.appendMessage({ role: "user", content: "parent task", timestamp: 0 });
			parentManager.flushNow();
			const parentInfo = await readSessionInfo(fixture.parentSessionFile);
			if (!parentInfo) throw new Error("Missing parent session info");
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				buildSessionListWithPassiveRlmSubagents(
					activeSessions: ActiveSessionState[],
					savedSessions: SessionInfo[],
					scheduledJobs: AgentCronJob[],
				): Promise<SessionSummary[]>;
			};

			expect(internals.sessions.size).toBe(0);
			const sessions = await internals.buildSessionListWithPassiveRlmSubagents([], [parentInfo], []);
			const child = sessions.find((session) => session.sessionFile === fixture.childSessionFile);
			expect(child).toMatchObject({
				runtimeKind: "subagent",
				parentSessionId: fixture.parentSessionId,
				parentSessionPath: fixture.parentSessionFile,
				rlmChildId: fixture.childId,
				rlmDepth: 1,
			});
			expect(child?.parentActiveSessionId).toBeUndefined();

			const grandchild = sessions.find((session) => session.sessionFile === fixture.grandchildSessionFile);
			expect(grandchild).toMatchObject({
				runtimeKind: "subagent",
				parentSessionPath: fixture.childSessionFile,
				rlmChildId: fixture.grandchildId,
				rlmDepth: 2,
			});
			expect(grandchild?.parentActiveSessionId).toBeUndefined();
			expect(fixture.createRuntime).not.toHaveBeenCalled();
		});
	});

	it("prefers registry depth when listing a passive legacy child", async () => {
		await withTempDir("optimus-daemon-passive-legacy-depth-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentManager = SessionManager.open(fixture.parentSessionFile);
			parentManager.appendMessage({ role: "user", content: "parent task", timestamp: 0 });
			parentManager.flushNow();
			const lines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
			delete header.rlmDepth;
			lines[0] = JSON.stringify(header);
			writeFileSync(fixture.childSessionFile, lines.join("\n"));
			const registryFile = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, unknown>;
			registryEntry.rlmDepth = 5;
			registryEntry.rlmMaxDepth = 8;
			writeFileSync(registryFile, `${JSON.stringify(registryEntry)}\n`);
			const parentInfo = await readSessionInfo(fixture.parentSessionFile);
			if (!parentInfo) throw new Error("Missing parent session info");
			const internals = fixture.daemon as unknown as {
				buildSessionListWithPassiveRlmSubagents(
					activeSessions: ActiveSessionState[],
					savedSessions: SessionInfo[],
					scheduledJobs: AgentCronJob[],
				): Promise<SessionSummary[]>;
			};

			const sessions = await internals.buildSessionListWithPassiveRlmSubagents([], [parentInfo], []);
			expect(sessions.find((session) => session.sessionFile === fixture.childSessionFile)?.rlmDepth).toBe(5);
		});
	});

	it("prefers the per-child display file over the legacy registry for passive metadata", async () => {
		await withTempDir("optimus-daemon-display-over-registry-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			// A post-consolidation write: the display file is fresher than the
			// stale pre-ledger registry entry left behind by an old daemon.
			writeFileSync(
				join(fixture.childSessionDir, "rlm-subagent.json"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: fixture.childId,
					sessionName: "renamed-worker",
					sessionDir: fixture.childSessionDir,
					sessionFile: fixture.childSessionFile,
					rlmMaxDepth: 6,
					rlmParentNodeId: fixture.childId,
					prompt: "fresher prompt",
					status: "completed",
					createdAt: 3,
					updatedAt: "2026-01-02T00:00:00.000Z",
				})}\n`,
			);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<
					Array<{ entry: { childId: string; prompt?: string; rlmMaxDepth?: number } }>
				>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			const passive = (await internals.listPassiveRlmSubagents()).find(
				({ entry }) => entry.childId === fixture.childId,
			);
			expect(passive?.entry).toMatchObject({ prompt: "fresher prompt", rlmMaxDepth: 6 });
		});
	});

	it("falls back to the legacy registry for a pre-ledger child without a display file", async () => {
		await withTempDir("optimus-daemon-legacy-metadata-fallback-", async (tempDir) => {
			// The fixture writes registries exactly as the pre-consolidation daemon
			// did and no display files: the pure migration state.
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryPath, "utf8").trim()) as Record<string, unknown>;
			registryEntry.prompt = "legacy prompt";
			registryEntry.spawnCode = "await rlm('legacy prompt')";
			registryEntry.model = { provider: "test", modelId: "legacy-model" };
			writeFileSync(registryPath, `${JSON.stringify(registryEntry)}\n`);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<
					Array<{
						entry: {
							childId: string;
							prompt?: string;
							spawnCode?: string;
							model?: { provider: string; modelId: string };
							rlmMaxDepth?: number;
							status: string;
						};
					}>
				>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			const passive = (await internals.listPassiveRlmSubagents()).find(
				({ entry }) => entry.childId === fixture.childId,
			);
			expect(passive?.entry).toMatchObject({
				prompt: "legacy prompt",
				spawnCode: "await rlm('legacy prompt')",
				model: { provider: "test", modelId: "legacy-model" },
				rlmMaxDepth: 4,
				status: "completed",
			});
		});
	});

	it("ignores a crashed registry tail and protects a nested cycle back to the root", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-lazy-rlm-corrupt-registry-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentRegistry = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			writeFileSync(parentRegistry, `${readFileSync(parentRegistry, "utf8")}{"type":"rlm_subagent","childId":`);

			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const childRegistry = join(
				fixture.parentArtifactDir,
				"session-artifacts",
				childInfo.id,
				"rlm-subagents.jsonl",
			);
			writeFileSync(
				childRegistry,
				`${readFileSync(childRegistry, "utf8")}${JSON.stringify({
					type: "rlm_subagent",
					childId: "cycle-to-root",
					sessionName: "cycle-to-root",
					sessionDir: join(tempDir, "sessions"),
					sessionFile: fixture.parentSessionFile,
					parentSessionId: childInfo.id,
					parentSessionFile: fixture.childSessionFile,
					status: "completed",
					createdAt: 3,
					updatedAt: "2026-01-01T00:00:02.000Z",
				})}
`,
			);

			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const response = (await internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
				type: "list",
			})) as { data: { sessions: Array<{ rlmChildId?: string }> } };

			expect(response.data.sessions.map((session) => session.rlmChildId).filter(Boolean)).toEqual([
				fixture.childId,
				fixture.grandchildId,
			]);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recomputes snapshot children when the runtime session changes during the passive walk", async () => {
		await withTempDir("optimus-daemon-snapshot-replacement-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSessionSnapshot(state: ActiveSessionState): Promise<DaemonAttachResult["snapshot"]>;
				createConnectionState: ReturnType<typeof vi.fn>;
				buildRlmChildSnapshotsWithPassiveRlmSubagents: ReturnType<typeof vi.fn>;
			};
			const state = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const originalSession = state.runtime.session;
			const replacementSession = Object.create(originalSession) as typeof originalSession;
			Object.defineProperty(replacementSession, "messages", {
				value: [{ role: "user", content: "new transcript", timestamp: 1 }],
			});
			internals.createConnectionState = vi.fn(() => ({}));
			let calls = 0;
			internals.buildRlmChildSnapshotsWithPassiveRlmSubagents = vi.fn(async () => {
				calls++;
				if (calls === 1)
					(state.runtime as unknown as { _session: typeof originalSession })._session =
						replacementSession as typeof originalSession;
				return [{ id: calls === 1 ? "old-child" : "new-child", status: "done", sessionDir: tempDir }];
			});

			const snapshot = await internals.createSessionSnapshot(state);

			expect(internals.buildRlmChildSnapshotsWithPassiveRlmSubagents).toHaveBeenCalledTimes(2);
			expect(snapshot.children).toEqual([expect.objectContaining({ id: "new-child" })]);
			expect(snapshot.messages).toBe(replacementSession.messages);
		});
	});

	it("bounds snapshot stabilization when every child build replaces the runtime session", async () => {
		await withTempDir("optimus-daemon-snapshot-stabilization-bound-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSessionSnapshot(state: ActiveSessionState): Promise<DaemonAttachResult["snapshot"]>;
				createConnectionState: ReturnType<typeof vi.fn>;
				buildRlmChildSnapshotsWithPassiveRlmSubagents: ReturnType<typeof vi.fn>;
			};
			const state = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			internals.createConnectionState = vi.fn(() => ({}));
			let calls = 0;
			internals.buildRlmChildSnapshotsWithPassiveRlmSubagents = vi.fn(async () => {
				calls++;
				const replacementSession = Object.create(state.runtime.session) as typeof state.runtime.session;
				Object.defineProperties(replacementSession, {
					messages: {
						value: [{ role: "user", content: `transcript ${calls}`, timestamp: calls }],
					},
					sessionId: { value: `session-${calls}` },
				});
				(state.runtime as unknown as { _session: typeof replacementSession })._session = replacementSession;
				return [{ id: `child-${calls}`, status: "done", sessionDir: tempDir }];
			});

			await expect(internals.createSessionSnapshot(state)).resolves.toMatchObject({
				children: [expect.objectContaining({ id: "child-4" })],
				messages: [{ content: "transcript 4" }],
				summary: { sessionId: "session-4" },
			});
			expect(internals.buildRlmChildSnapshotsWithPassiveRlmSubagents).toHaveBeenCalledTimes(4);
		});
	});

	it("validates a requested passive child name before hydration", async () => {
		await withTempDir("optimus-daemon-passive-name-preflight-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				assertFamilySessionNameAvailable: ReturnType<typeof vi.fn>;
				hydratePassiveRlmSubagent: ReturnType<typeof vi.fn>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const nameError = new Error("sibling name collision");
			internals.assertFamilySessionNameAvailable = vi.fn(async () => {
				throw nameError;
			});
			internals.hydratePassiveRlmSubagent = vi.fn();

			await expect(
				internals.createRuntime({
					type: "create",
					sessionPath: fixture.childSessionFile,
					name: "  sibling  ",
				}),
			).rejects.toBe(nameError);
			expect(internals.assertFamilySessionNameAvailable).toHaveBeenCalledWith({
				name: "sibling",
				depth: 1,
				parentSessionId: parentState.runtime.session.sessionId,
				parentSessionPath: fixture.parentSessionFile,
				ignoreSessionId: expect.any(String),
			});
			expect(internals.hydratePassiveRlmSubagent).not.toHaveBeenCalled();
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			expect([...internals.sessions.values()]).toEqual([parentState]);
		});
	});

	it("hydrates a passive child on agent message and delivers to it", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-message-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({
						target: "renamed-worker",
						message: "report progress",
					}),
			).resolves.toMatchObject({
				deliveryStatus: "delivered",
				target: { runtimeKind: "subagent", sessionName: "renamed-worker" },
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledOnce();
			expect(
				[...internals.sessions.values()].filter((state) => state.runtime.metadata.kind === "subagent"),
			).toHaveLength(1);
		});
	});

	it("rehydrates a legacy child with depth inferred from its session file path", async () => {
		await withTempDir("optimus-daemon-legacy-rlm-depth-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const lines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
			delete header.rlmDepth;
			lines[0] = JSON.stringify(header);
			writeFileSync(fixture.childSessionFile, lines.join("\n"));
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			await internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: "renamed-worker", message: "report progress" });

			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionOptions?.rlmDepth).toBe(1);
		});
	});

	it("does not match a renamed passive child by its stale registry name", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-renamed-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const siblingId = "child-2";
			const siblingSessionDir = join(fixture.parentArtifactDir, siblingId);
			const siblingManager = SessionManager.create(tempDir, siblingSessionDir);
			siblingManager.newSession({ parentSession: fixture.parentSessionFile });
			siblingManager.appendSessionInfo("spawn-worker");
			siblingManager.flushNow();
			const siblingSessionFile = siblingManager.getSessionFile();
			if (!siblingSessionFile) throw new Error("Missing sibling session file");
			const parentRegistry = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			writeFileSync(
				parentRegistry,
				`${readFileSync(parentRegistry, "utf8")}${JSON.stringify({
					type: "rlm_subagent",
					childId: siblingId,
					sessionName: "spawn-worker",
					sessionDir: siblingSessionDir,
					sessionFile: siblingSessionFile,
					parentSessionId: fixture.parentSessionId,
					parentSessionFile: fixture.parentSessionFile,
					status: "completed",
					createdAt: 2,
					updatedAt: "2026-01-01T00:00:01.000Z",
				})}\n`,
			);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({ target: "spawn-worker", message: "report progress" }),
			).resolves.toMatchObject({
				deliveryStatus: "delivered",
				target: { runtimeKind: "subagent", sessionName: "spawn-worker" },
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionManager.getSessionFile()).toBe(siblingSessionFile);
		});
	});

	it("rehydrates completed children without rewriting their persisted completion", async () => {
		await withTempDir("optimus-daemon-idempotent-rlm-hydration-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				recordRlmSubagentState: ReturnType<typeof vi.fn>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const before = readFileSync(registryPath, "utf8");
			internals.recordRlmSubagentState = vi.fn(() => false);

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({ target: "renamed-worker", message: "report progress" }),
			).resolves.toMatchObject({ deliveryStatus: "delivered" });

			expect(internals.recordRlmSubagentState).not.toHaveBeenCalled();
			expect(readFileSync(registryPath, "utf8")).toBe(before);
			expect(existsSync(join(fixture.childSessionDir, "rlm-subagent.json"))).toBe(false);
		});
	});

	it("rehydrates a legacy passive subagent at depth one", async () => {
		await withTempDir("optimus-daemon-legacy-rlm-depth-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const childLines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const childHeader = JSON.parse(childLines[0] ?? "{}") as Record<string, unknown>;
			delete childHeader.rlmDepth;
			childLines[0] = JSON.stringify(childHeader);
			writeFileSync(fixture.childSessionFile, childLines.join("\n"));

			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryPath, "utf8").trim()) as Record<string, unknown>;
			delete registryEntry.rlmDepth;
			writeFileSync(registryPath, `${JSON.stringify(registryEntry)}\n`);

			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: "renamed-worker", message: "report progress" });

			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionOptions?.rlmDepth).toBe(1);
		});
	});

	it("prefers the persisted header depth when a legacy registry entry lacks one", async () => {
		await withTempDir("optimus-daemon-legacy-header-depth-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const childLines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const childHeader = JSON.parse(childLines[0] ?? "{}") as Record<string, unknown>;
			childHeader.rlmDepth = 2;
			childLines[0] = JSON.stringify(childHeader);
			writeFileSync(fixture.childSessionFile, childLines.join("\n"));

			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryPath, "utf8").trim()) as Record<string, unknown>;
			delete registryEntry.rlmDepth;
			writeFileSync(registryPath, `${JSON.stringify(registryEntry)}\n`);

			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: "renamed-worker", message: "report progress" });

			// The nested header depth must win over the legacy depth-1 default so the
			// woken child does not come up shallower than persisted.
			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionOptions?.rlmDepth).toBe(2);
		});
	});

	it("rejects direct messages to nested passive grandchildren without hydrating them", async () => {
		await withTempDir("optimus-daemon-lazy-nested-message-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const reachError = "Agent reach is limited to parent, siblings, and children";

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({
						target: "nested-worker",
						message: "report nested progress",
					}),
			).rejects.toThrow(reachError);
			const observe = internals.createAgentObserveController(() => parentState);
			await expect(observe.getAgent("nested-worker")).rejects.toThrow(reachError);
			await expect(observe.recentMessages({ target: "nested-worker" })).rejects.toThrow(reachError);

			expect([...internals.sessions.values()]).toEqual([parentState]);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		});
	});

	it("hydrates a passive child when agent_observe reads it", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-observe-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const controller = internals.createAgentObserveController(() => parentState);

			await expect(controller.getAgent("renamed-worker")).resolves.toMatchObject({
				agent: { runtimeKind: "subagent", sessionName: "renamed-worker" },
			});
			await expect(controller.recentMessages({ target: "renamed-worker" })).resolves.toMatchObject({
				agent: { runtimeKind: "subagent" },
				messages: [],
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
		});
	});

	it("waits for an explicit open reservation before hydrating a passive child", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-lazy-rlm-reservation-race-"));
		let releaseOpen!: () => void;
		const openGate = new Promise<void>((resolveGate) => {
			releaseOpen = resolveGate;
		});
		let markOpenStarted!: () => void;
		const openStarted = new Promise<void>((resolveStarted) => {
			markOpenStarted = resolveStarted;
		});
		const originalOpenAsync = SessionManager.openAsync;
		let openAsyncSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				reservingSessionOpens: Map<string, Promise<void>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(target: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const findPassiveRlmSubagent = internals.findPassiveRlmSubagent.bind(fixture.daemon);
			const passive = await findPassiveRlmSubagent(fixture.childId);
			if (!passive) throw new Error("Missing passive child");
			internals.findPassiveRlmSubagent = vi.fn(async (target: string) => {
				if (resolve(target) === resolve(fixture.childSessionFile)) {
					return undefined;
				}
				return findPassiveRlmSubagent(target);
			});
			openAsyncSpy = vi
				.spyOn(SessionManager, "openAsync")
				.mockImplementation(async (path, sessionDir, cwdOverride) => {
					if (resolve(path) === resolve(fixture.childSessionFile)) {
						markOpenStarted();
						await openGate;
					}
					return originalOpenAsync(path, sessionDir, cwdOverride);
				});

			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			await openStarted;
			expect(internals.reservingSessionOpens.has(resolve(fixture.childSessionFile))).toBe(true);

			const hydration = internals.hydratePassiveRlmSubagent(passive);
			const joined = Promise.all([explicitOpen, hydration]);
			releaseOpen();

			const [openedState, hydratedState] = await joined;
			expect(openedState.runtime.session.sessionFile).toBe(fixture.childSessionFile);
			expect(hydratedState.runtime.session.sessionFile).toBe(fixture.childSessionFile);
			// Kind fidelity may replace a non-subagent explicit open with a proper
			// subagent rehydration; either way the lazy path must join the explicit
			// open's lease instead of failing with a lease conflict, and exactly one
			// resident state may own the session file afterwards.
			const internalsAfter = fixture.daemon as unknown as { sessions: Map<string, ActiveSessionState> };
			const owners = [...internalsAfter.sessions.values()].filter(
				(state) => state.runtime.session.sessionFile === fixture.childSessionFile,
			);
			expect(owners).toHaveLength(1);
			expect(owners[0]).toBe(hydratedState);
		} finally {
			releaseOpen();
			openAsyncSpy?.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("loads a passive child under the create command client env", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-passive-create-env-"));
		const inheritedPaneId = process.env.HERDR_PANE_ID;
		delete process.env.HERDR_PANE_ID;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const envAtRuntimeCreation: Array<string | undefined> = [];
			const createRuntime = fixture.createRuntime.getMockImplementation();
			if (!createRuntime) throw new Error("Missing fixture runtime factory");
			fixture.createRuntime.mockImplementation(async (runtimeOptions) => {
				envAtRuntimeCreation.push(process.env.HERDR_PANE_ID);
				return createRuntime(runtimeOptions);
			});
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			expect(parentState.clientEnv).toBeUndefined();

			const childState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
				env: { HERDR_PANE_ID: "pane-42" },
			});

			expect(envAtRuntimeCreation).toEqual([undefined, "pane-42"]);
			expect(parentState.clientEnv).toEqual({ HERDR_PANE_ID: "pane-42" });
			expect(childState.clientEnv).toEqual({ HERDR_PANE_ID: "pane-42" });
		} finally {
			if (inheritedPaneId === undefined) delete process.env.HERDR_PANE_ID;
			else process.env.HERDR_PANE_ID = inheritedPaneId;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not adopt a failed passive opener env on the root parent", async () => {
		await withTempDir("optimus-daemon-failed-passive-env-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const createRuntime = fixture.createRuntime.getMockImplementation();
			if (!createRuntime) throw new Error("Missing fixture runtime factory");
			let failHydration = true;
			const childEnvAtRuntimeCreation: Array<string | undefined> = [];
			fixture.createRuntime.mockImplementation(async (runtimeOptions) => {
				if (runtimeOptions.sessionManager.getSessionFile() === fixture.childSessionFile) {
					childEnvAtRuntimeCreation.push(process.env.HERDR_PANE_ID);
					if (failHydration) {
						failHydration = false;
						throw new Error("hydration failed");
					}
				}
				return createRuntime(runtimeOptions);
			});

			await expect(
				internals.createRuntime({
					type: "create",
					sessionPath: fixture.childSessionFile,
					env: { HERDR_PANE_ID: "failed-pane" },
				}),
			).rejects.toThrow("hydration failed");
			expect(parentState.clientEnv).toBeUndefined();

			const childState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
				env: { HERDR_PANE_ID: "successful-pane" },
			});
			expect(childEnvAtRuntimeCreation).toEqual(["failed-pane", "successful-pane"]);
			expect(parentState.clientEnv).toEqual({ HERDR_PANE_ID: "successful-pane" });
			expect(childState.clientEnv).toEqual({ HERDR_PANE_ID: "successful-pane" });
		});
	});

	it("joins binding when advertised session ID resolution races passive hydration", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-lazy-rlm-resolve-race-"));
		let releasePassiveList!: () => void;
		const passiveListGate = new Promise<void>((resolve) => {
			releasePassiveList = resolve;
		});
		let releaseBinding!: () => void;
		const bindingGate = new Promise<void>((resolve) => {
			releaseBinding = resolve;
		});
		let markBindingStarted!: () => void;
		const bindingStarted = new Promise<void>((resolve) => {
			markBindingStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childBindingStarted: markBindingStarted,
				childBindingGate: bindingGate,
			});
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<unknown[]>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const listPassive = internals.listPassiveRlmSubagents.bind(fixture.daemon);
			let blockNextList = true;
			internals.listPassiveRlmSubagents = vi.fn(async () => {
				if (blockNextList) {
					blockNextList = false;
					await passiveListGate;
				}
				return listPassive();
			});

			let advertisedResolved = false;
			const advertisedLookup = internals.getOrHydrateBoundSessionState(childInfo.id).then((state) => {
				advertisedResolved = true;
				return state;
			});
			await Promise.resolve();
			const hydration = internals.getOrHydrateBoundSessionState(fixture.childId);
			await bindingStarted;
			releasePassiveList();
			await Promise.resolve();
			expect(advertisedResolved).toBe(false);
			releaseBinding();

			const hydrated = await hydration;
			await expect(advertisedLookup).resolves.toBe(hydrated);
		} finally {
			releasePassiveList();
			releaseBinding();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects an ambiguous live selector before consulting passive children", async () => {
		await withTempDir("optimus-daemon-ambiguous-passive-selector-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			for (const id of ["live-one", "live-two"]) {
				const state = makeState(id);
				Object.assign(state.runtime, {
					session: { sessionId: `${id}-session`, sessionName: "renamed-worker" },
					metadata: { kind: "root", createdAt: 1 },
				});
				internals.sessions.set(id, state);
			}

			await expect(internals.getOrHydrateBoundSessionState("renamed-worker")).rejects.toThrow(
				'Ambiguous active session "renamed-worker"',
			);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		});
	});

	it("leaves passive hydration resident when its runtime-open guard is cancelled", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-guarded-hydration-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolve) => {
			markHydrationStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childRuntimeStarted: markHydrationStarted,
				childRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getRunnableCronJob(id: string): AgentCronJob | undefined;
				runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSession.releaseRlmChildSession = vi.fn(() => vi.fn());
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childInfo.id,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "must not run",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			let runnable = true;
			internals.getRunnableCronJob = vi.fn(() => (runnable ? heartbeat : undefined));

			const run = internals.runCronJob(heartbeat);
			await hydrationStarted;
			runnable = false;
			releaseHydration();

			await expect(run).resolves.toBe("skipped");
			internals.cronStore.cancel(heartbeat.id);
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === fixture.childId,
			);
			expect(childState).toBeDefined();
			expect(fixture.runtimeSessions[1]?.disposeAsync).not.toHaveBeenCalled();
			expect(parentSession.releaseRlmChildSession).not.toHaveBeenCalled();

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(1);
			expect(internals.sessions.has(childState!.activeSessionId)).toBe(false);
			expect(fixture.runtimeSessions[1]?.disposeAsync).toHaveBeenCalledOnce();
			expect(parentSession.releaseRlmChildSession).toHaveBeenCalledWith(
				fixture.childId,
				childState!.runtime.session,
			);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an attach-owned passive hydration usable when a joining heartbeat is cancelled", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-shared-guarded-hydration-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolve) => {
			markHydrationStarted = resolve;
		});
		let markHeartbeatJoinStarted!: () => void;
		const heartbeatJoinStarted = new Promise<void>((resolve) => {
			markHeartbeatJoinStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childRuntimeStarted: markHydrationStarted,
				childRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				getRunnableCronJob(id: string): AgentCronJob | undefined;
				runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
				registerRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSession.releaseRlmChildSession = vi.fn(() => vi.fn());
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childInfo.id,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "must not run",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			let runnable = true;
			internals.getRunnableCronJob = vi.fn(() => (runnable ? heartbeat : undefined));

			const attach = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			await hydrationStarted;
			const hydratePassive = internals.hydratePassiveRlmSubagent.bind(fixture.daemon);
			internals.hydratePassiveRlmSubagent = vi.fn(async (passive) => {
				markHeartbeatJoinStarted();
				return hydratePassive(passive);
			});
			const run = internals.runCronJob(heartbeat);
			await heartbeatJoinStarted;
			runnable = false;
			releaseHydration();

			const attachedState = await attach;
			await expect(run).resolves.toBe("skipped");
			expect(internals.sessions.get(attachedState.activeSessionId)).toBe(attachedState);
			expect(fixture.runtimeSessions[1]?.disposeAsync).not.toHaveBeenCalled();
			expect(parentSession.releaseRlmChildSession).not.toHaveBeenCalled();
			expect(parentSession.registerRlmChildSession).toHaveBeenCalledWith(
				fixture.childId,
				attachedState.runtime.session,
			);

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({ target: fixture.childId, message: "still usable" }),
			).resolves.toMatchObject({ deliveryStatus: "delivered", target: { runtimeKind: "subagent" } });
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledWith(
				expect.stringContaining("still usable"),
				expect.any(Object),
			);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("repairs a wrong-kind pending open while preserving the passive row id", async () => {
		await withTempDir("optimus-daemon-wrong-kind-open-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				openingSessions: Map<string, Promise<ActiveSessionState>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = (await internals.findPassiveRlmSubagent(fixture.childId)) as { info: { id: string } };
			const wrongState = makeState("wrong-kind");
			Object.assign(wrongState, { extensionUiRequests: new Map(), eventGeneration: "wrong", lastEventSequence: 0 });
			Object.assign(wrongState.runtime, {
				dispose: vi.fn(async () => {}),
				metadata: { kind: "root", createdAt: 1 },
				session: makeRuntimeSession(SessionManager.open(fixture.childSessionFile, fixture.childSessionDir)),
			});
			internals.sessions.set(wrongState.activeSessionId, wrongState);
			internals.openingSessions.set(resolve(fixture.childSessionFile), Promise.resolve(wrongState));

			const childState = await internals.hydratePassiveRlmSubagent(passive);

			expect(childState.activeSessionId).toBe(passive.info.id);
			expect(childState.runtime.metadata).toMatchObject({ kind: "subagent", rlmChildId: fixture.childId });
			expect(internals.sessions.has(wrongState.activeSessionId)).toBe(false);
		});
	});

	it("rejects passive hydration while an update restart is fenced", async () => {
		await withTempDir("optimus-daemon-update-hydration-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				updateRestart: unknown;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			internals.updateRestart = { phase: "prepared" };

			await expect(internals.getOrHydrateBoundSessionState(fixture.childId)).rejects.toThrow(
				"Daemon is preparing an update restart",
			);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		});
	});

	it("coalesces a gated hydration with concurrent messaging and an explicit open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-lazy-rlm-race-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolveGate) => {
			releaseHydration = resolveGate;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolveStarted) => {
			markHydrationStarted = resolveStarted;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childRuntimeStarted: markHydrationStarted,
				childRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const controller = internals.createAgentMessageController(() => parentState);

			const firstMessage = controller.sendAgentMessage({ target: fixture.childId, message: "first" });
			await hydrationStarted;
			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const secondMessage = controller.sendAgentMessage({ target: fixture.childId, message: "second" });
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);

			releaseHydration();
			const [, openedState] = await Promise.all([firstMessage, explicitOpen, secondMessage]);

			expect(openedState.runtime.metadata).toMatchObject({ kind: "subagent", rlmChildId: fixture.childId });
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			expect(
				[...internals.sessions.values()].filter((state) => state.runtime.metadata.kind === "subagent"),
			).toHaveLength(1);
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledTimes(2);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a parent resident while one of its passive descendants is hydrating", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-hydration-passivation-race-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolve) => {
			markHydrationStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				grandchildRuntimeStarted: markHydrationStarted,
				grandchildRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const rootState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
			});
			const rootSession = rootState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			rootSession.releaseRlmChildSession = vi.fn(() => vi.fn());

			const hydration = internals.getOrHydrateBoundSessionState(fixture.grandchildId);
			await hydrationStarted;
			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(internals.sessions.get(parentState.activeSessionId)).toBe(parentState);
			expect(rootSession.releaseRlmChildSession).not.toHaveBeenCalled();

			releaseHydration();
			const grandchildState = await hydration;
			expect(internals.sessions.get(parentState.activeSessionId)).toBe(parentState);
			expect(grandchildState.runtime.metadata).toMatchObject({
				parentActiveSessionId: parentState.activeSessionId,
				rlmChildId: fixture.grandchildId,
			});
			expect(
				(parentState.runtime.session as unknown as { registerRlmChildSession: ReturnType<typeof vi.fn> })
					.registerRlmChildSession,
			).toHaveBeenCalledWith(fixture.grandchildId, grandchildState.runtime.session);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns a resident target when a concurrent opener wins a parent-change restart", async () => {
		await withTempDir("optimus-daemon-parent-change-open-race-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				openingSessions: Map<string, Promise<ActiveSessionState>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
				rehydrateCompletedRlmSubagent(
					parent: ActiveSessionState,
					entry: { childId: string; sessionFile: string },
				): Promise<ActiveSessionState>;
				waitForPassivation(sessionFile: string): Promise<void>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = await internals.findPassiveRlmSubagent(fixture.grandchildId);
			if (!passive) throw new Error("Missing passive grandchild");
			const staleParent = makeState("stale-parent", rootState.activeSessionId);
			Object.assign(staleParent.runtime, { session: { sessionFile: fixture.childSessionFile } });
			const residentGrandchild = makeState("resident-grandchild", staleParent.activeSessionId);
			Object.assign(residentGrandchild.runtime, {
				metadata: {
					kind: "subagent",
					createdAt: 1,
					parentActiveSessionId: staleParent.activeSessionId,
					rlmChildId: fixture.grandchildId,
				},
				session: { sessionFile: fixture.grandchildSessionFile },
			});
			let hydrationAttempts = 0;
			internals.rehydrateCompletedRlmSubagent = vi.fn(async () => {
				if (++hydrationAttempts === 1) {
					internals.sessions.set(staleParent.activeSessionId, staleParent);
					return staleParent;
				}
				return residentGrandchild;
			});
			const findPassiveRlmSubagent = internals.findPassiveRlmSubagent.bind(fixture.daemon);
			internals.findPassiveRlmSubagent = vi.fn(async (id: string) => {
				if (id === fixture.grandchildSessionFile) return passive;
				return findPassiveRlmSubagent(id);
			});
			internals.waitForPassivation = vi.fn(async (sessionFile) => {
				if (sessionFile !== fixture.grandchildSessionFile) return;
				internals.sessions.delete(staleParent.activeSessionId);
				internals.sessions.set(residentGrandchild.activeSessionId, residentGrandchild);
				internals.openingSessions.set(resolve(fixture.grandchildSessionFile), Promise.resolve(residentGrandchild));
			});

			await expect(internals.hydratePassiveRlmSubagent(passive)).resolves.toBe(residentGrandchild);
		});
	});

	it("re-walks the passive chain when an intermediate parent passivates between entries", async () => {
		await withTempDir("optimus-daemon-chain-parent-passivation-race-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<
					| {
							rootParentState: ActiveSessionState;
							entry: { childId: string; sessionFile: string };
							chain: Array<{ childId: string; sessionFile: string }>;
					  }
					| undefined
				>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
				waitForPassivation(sessionFile: string): Promise<void>;
				rehydrateCompletedRlmSubagent(
					parent: ActiveSessionState,
					entry: { childId: string; sessionFile: string },
				): Promise<ActiveSessionState>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = await internals.findPassiveRlmSubagent(fixture.grandchildId);
			if (!passive) throw new Error("Missing passive grandchild");

			const staleParent = makeState("stale-parent", rootState.activeSessionId);
			const refreshedParent = makeState("refreshed-parent", rootState.activeSessionId);
			const grandchild = makeState("rehydrated-grandchild", refreshedParent.activeSessionId);
			for (const [state, sessionFile] of [
				[staleParent, fixture.childSessionFile],
				[refreshedParent, fixture.childSessionFile],
				[grandchild, fixture.grandchildSessionFile],
			] as const) {
				Object.assign(state.runtime, { session: { sessionFile } });
			}

			let childHydrations = 0;
			internals.rehydrateCompletedRlmSubagent = vi.fn(async (_parent, entry) => {
				const hydrated =
					entry.childId === fixture.childId
						? ++childHydrations === 1
							? staleParent
							: refreshedParent
						: grandchild;
				internals.sessions.set(hydrated.activeSessionId, hydrated);
				return hydrated;
			});
			let grandchildWaits = 0;
			internals.waitForPassivation = vi.fn(async (sessionFile) => {
				if (sessionFile === fixture.grandchildSessionFile && ++grandchildWaits === 1) {
					internals.sessions.delete(staleParent.activeSessionId);
				}
			});
			internals.findPassiveRlmSubagent = vi.fn(async () => passive);

			await expect(internals.hydratePassiveRlmSubagent(passive)).resolves.toBe(grandchild);
			expect(childHydrations).toBe(2);
			expect(internals.rehydrateCompletedRlmSubagent).toHaveBeenCalledWith(
				refreshedParent,
				passive.entry,
				expect.anything(),
				undefined,
			);
			expect(internals.rehydrateCompletedRlmSubagent).not.toHaveBeenCalledWith(
				staleParent,
				passive.entry,
				expect.anything(),
				undefined,
			);
		});
	});

	it("retries hydration when the target child starts passivating after the initial wait", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-child-hydration-passivation-race-"));
		let releasePassivation!: () => void;
		const passivationGate = new Promise<void>((resolve) => {
			releasePassivation = resolve;
		});
		let markRaceStarted!: () => void;
		const raceStarted = new Promise<void>((resolve) => {
			markRaceStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				closingSessions: Map<string, { promise: Promise<void>; reason: "shutdown"; killedEffects?: Promise<void> }>;
				passivatingSessions: Map<string, Promise<void>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
				rehydrateCompletedRlmSubagent(
					parent: ActiveSessionState,
					entry: { childId: string; sessionFile: string },
				): Promise<ActiveSessionState>;
				waitForBoundSession(state: ActiveSessionState): Promise<ActiveSessionState>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = await internals.findPassiveRlmSubagent(fixture.childId);
			if (!passive) throw new Error("Missing passive child");
			const closingChild = makeState("closing-child", rootState.activeSessionId);
			const refreshedChild = makeState("refreshed-child", rootState.activeSessionId);
			Object.assign(closingChild.runtime, { session: { sessionFile: fixture.childSessionFile } });
			Object.assign(refreshedChild.runtime, { session: { sessionFile: fixture.childSessionFile } });
			const passivation = passivationGate.then(() => {
				internals.sessions.delete(closingChild.activeSessionId);
				internals.closingSessions.delete(closingChild.activeSessionId);
				throw new Error("passivation failed");
			});
			let hydrationAttempts = 0;
			internals.rehydrateCompletedRlmSubagent = vi.fn(async () => {
				if (++hydrationAttempts === 1) {
					internals.sessions.set(closingChild.activeSessionId, closingChild);
					internals.closingSessions.set(closingChild.activeSessionId, {
						promise: passivation,
						reason: "shutdown",
					});
					internals.passivatingSessions.set(resolve(fixture.childSessionFile), passivation);
					markRaceStarted();
					return internals.waitForBoundSession(closingChild);
				}
				internals.sessions.set(refreshedChild.activeSessionId, refreshedChild);
				return refreshedChild;
			});
			internals.findPassiveRlmSubagent = vi.fn(async () => passive);

			const hydration = internals.hydratePassiveRlmSubagent(passive);
			await raceStarted;
			releasePassivation();

			await expect(hydration).resolves.toBe(refreshedChild);
			expect(hydrationAttempts).toBe(2);
		} finally {
			releasePassivation();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rehydrates a passivated parent before publishing its racing child", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-parent-passivation-race-"));
		let releaseParentDispose!: () => void;
		const parentDisposeGate = new Promise<void>((resolve) => {
			releaseParentDispose = resolve;
		});
		let markParentDisposeStarted!: () => void;
		const parentDisposeStarted = new Promise<void>((resolve) => {
			markParentDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childDisposeStarted: markParentDisposeStarted,
				childDisposeGate: parentDisposeGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				rootState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());

			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await parentDisposeStarted;
			const hydration = internals.getOrHydrateBoundSessionState(fixture.grandchildId);
			let hydrationSettled = false;
			void hydration.finally(() => {
				hydrationSettled = true;
			});
			await Promise.resolve();
			expect(hydrationSettled).toBe(false);
			releaseParentDispose();

			await expect(passivation).resolves.toBe(1);
			const grandchildState = await hydration;
			const reboundParentId = grandchildState.runtime.metadata.parentActiveSessionId;
			expect(internals.sessions.has(parentState.activeSessionId)).toBe(false);
			expect(reboundParentId).toBeDefined();
			expect(internals.sessions.has(reboundParentId!)).toBe(true);
			expect(grandchildState.runtime.metadata.rlmChildId).toBe(fixture.grandchildId);
		} finally {
			releaseParentDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a child resident while an attach snapshot is in flight", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-attach-passivation-race-"));
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAttachResult: ReturnType<typeof vi.fn>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const client = makeClient("attach-client", childState.activeSessionId);
			client.attachedActiveSessionIds.clear();
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => true);
			internals.createAttachResult = vi.fn(async () => {
				await snapshotGate;
				return { activeSessionId: childState.activeSessionId, snapshot: {}, lastEventSequence: 0 };
			});

			const attach = internals.handleCommand(client, {
				type: "attach",
				activeSessionId: childState.activeSessionId,
			});
			await vi.waitFor(() => expect(childState.pendingAttaches).toBe(1));
			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			expect(parentState.runtime.session.releaseRlmChildSession).not.toHaveBeenCalled();

			releaseSnapshot();
			await attach;
			expect(childState.pendingAttaches).toBe(0);
			expect(childState.clients).toContain(client);
			expect(client.attachedActiveSessionIds).toContain(childState.activeSessionId);
		} finally {
			releaseSnapshot();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not passivate a child that starts streaming during the fence snapshot", async () => {
		await withTempDir("optimus-daemon-passivation-stream-race-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents: ReturnType<typeof vi.fn>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const childSession = childState.runtime.session as unknown as {
				isStreaming: boolean;
				isSessionActive: boolean;
				abort: ReturnType<typeof vi.fn>;
			};
			let passiveListCalls = 0;
			internals.listPassiveRlmSubagents = vi.fn(async () => {
				passiveListCalls++;
				if (passiveListCalls === 2) {
					childSession.isStreaming = true;
					childSession.isSessionActive = true;
				}
				return [];
			});

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(passiveListCalls).toBe(2);
			expect(childSession.abort).not.toHaveBeenCalled();
			expect(parentState.runtime.session.releaseRlmChildSession).not.toHaveBeenCalled();
		});
	});

	it("re-adopts a resident child when its passivation close fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-passivation-close-failure-"));
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		let markAbortStarted!: () => void;
		const abortStarted = new Promise<void>((resolve) => {
			markAbortStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
				registerRlmChildSession: ReturnType<typeof vi.fn>;
			};
			let parentOwnsChild = true;
			let forwarderActive = true;
			const parentUpdates: string[] = [];
			const emitChildUpdate = (recap: string) => {
				if (forwarderActive) parentUpdates.push(recap);
			};
			const unsubscribeForwarder = vi.fn(() => {
				forwarderActive = false;
			});
			parentSession.releaseRlmChildSession = vi.fn(() => {
				if (!parentOwnsChild) return false;
				parentOwnsChild = false;
				return unsubscribeForwarder;
			});
			parentSession.registerRlmChildSession = vi.fn(
				(_childId: string, _childSession: unknown, unsubscribe: () => void) => {
					parentOwnsChild = true;
					forwarderActive = unsubscribe === unsubscribeForwarder;
					return true;
				},
			);
			childState.unsubscribe = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error("unsubscribe failed");
				})
				.mockImplementation(() => undefined);
			const childSession = childState.runtime.session as unknown as { abort: ReturnType<typeof vi.fn> };
			childSession.abort = vi.fn(async () => {
				markAbortStarted();
				await abortGate;
			});

			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await abortStarted;
			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const delivery = internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: fixture.childId, message: "continue after failed passivation" });
			releaseAbort();

			await expect(passivation).rejects.toThrow("unsubscribe failed");
			await expect(explicitOpen).resolves.toBe(childState);
			await expect(delivery).resolves.toMatchObject({ deliveryStatus: "delivered" });
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			expect(parentOwnsChild).toBe(true);
			expect(parentSession.registerRlmChildSession).toHaveBeenCalledWith(
				fixture.childId,
				childState.runtime.session,
				unsubscribeForwarder,
			);
			expect(unsubscribeForwarder).not.toHaveBeenCalled();
			emitChildUpdate("recap after failed close");
			expect(parentUpdates).toEqual(["recap after failed close"]);

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(1);
			expect(parentSession.releaseRlmChildSession).toHaveBeenCalledTimes(2);
			expect(unsubscribeForwarder).toHaveBeenCalledOnce();
			emitChildUpdate("recap after successful close");
			expect(parentUpdates).toEqual(["recap after failed close"]);
			expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
		} finally {
			releaseAbort();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("limits each worker sweep and leaves non-leaf children resident", async () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/optimus-passivation-cap.sock",
			agentDir: "/tmp",
			cwd: "/tmp",
			createRuntime: vi.fn(),
		});
		const root = makeState("root");
		const oldestLeaf = makeState("oldest-leaf", "root");
		const nextLeaf = makeState("next-leaf", "root");
		const queuedLeaf = makeState("queued-leaf", "root");
		const nonLeaf = makeState("non-leaf", "root");
		const nested = makeState("nested", "non-leaf");
		const states = [root, oldestLeaf, nextLeaf, queuedLeaf, nonLeaf, nested];
		const internals = daemonInternals(daemon);
		for (const state of states) internals.sessions.set(state.activeSessionId, state);
		const order = new Map([
			[oldestLeaf, 1],
			[nextLeaf, 2],
			[queuedLeaf, 3],
			[nested, 4],
			[nonLeaf, 5],
			[root, 6],
		]);
		internals.listPassiveRlmSubagents = vi.fn(async () => []);
		internals.sessionPassivationSnapshot = vi.fn(async (state: ActiveSessionState) => ({
			isSessionActive: false,
			attachedClients: 0,
			hasRegisteredHeartbeat: false,
			hasRegisteredCronJob: false,
			lastActivityAt: order.get(state) ?? 99,
			hasParent: state !== root,
			hasNonPassiveDescendants: state === nonLeaf,
			isHydrating: false,
		}));
		internals.passivateSession = vi.fn(async () => true);

		await expect(internals.passivateIdleChildren(90, 200 * 60_000, 2)).resolves.toBe(2);
		expect(internals.sessionPassivationSnapshot).toHaveBeenCalledTimes(states.length);
		expect(internals.passivateSession).toHaveBeenCalledTimes(2);
		expect(internals.passivateSession.mock.calls.map((call: any) => call[0])).toEqual([oldestLeaf, nextLeaf]);
		expect(internals.passivateSession).not.toHaveBeenCalledWith(nonLeaf, expect.anything(), expect.anything());
		expect(internals.passivateSession).not.toHaveBeenCalledWith(queuedLeaf, expect.anything(), expect.anything());
	});

	it("passivates an idle leaf and makes list, attach, and message use the normal passive wake path", async () => {
		await withTempDir("optimus-daemon-passivate-child-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				passivateIdleChildren(threshold: number | "off", now: number, limit: number): Promise<number>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const firstChild = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSession.releaseRlmChildSession = vi.fn(() => vi.fn());

			expect(await internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 2)).toBe(1);
			expect(internals.sessions.has(firstChild.activeSessionId)).toBe(false);
			expect(parentSession.releaseRlmChildSession).toHaveBeenCalledWith(fixture.childId, firstChild.runtime.session);
			expect(fixture.runtimeSessions[1]?.disposeAsync).toHaveBeenCalledOnce();

			const listed = (await internals.handleCommand(makeClient("list-client", parentState.activeSessionId), {
				type: "list",
			})) as { data: { sessions: Array<Record<string, unknown>> } };
			const passiveRow = listed.data.sessions.find((row) => row.sessionFile === fixture.childSessionFile);
			expect(passiveRow).toMatchObject({ rlmChildId: fixture.childId, sessionName: "renamed-worker" });
			expect(passiveRow?.activeSessionId).toBeUndefined();

			const attachedState = await (
				fixture.daemon as unknown as {
					getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				}
			).getOrHydrateBoundSessionState(String(passiveRow?.sessionId));
			expect(attachedState.runtime.metadata).toMatchObject({ rlmChildId: fixture.childId });

			// Detach so the same runtime can passivate again and prove a2a wake/delivery.
			attachedState?.clients.clear();
			const parentSessionAgain = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSessionAgain.releaseRlmChildSession = vi.fn(() => vi.fn());
			expect(await internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 2)).toBe(1);
			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({
						target: fixture.childId,
						message: "wake after passivation",
					}),
			).resolves.toMatchObject({ deliveryStatus: "delivered", target: { runtimeKind: "subagent" } });
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledWith(
				expect.stringContaining("wake after passivation"),
				expect.any(Object),
			);
		});
	});

	it("keeps an idle child resident while an agent message waits for admission", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-admission-passivation-race-"));
		let releaseAdmission!: () => void;
		const admissionGate = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		let markAdmissionStarted!: () => void;
		const admissionStarted = new Promise<void>((resolve) => {
			markAdmissionStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childAdmissionStarted: markAdmissionStarted,
				childAdmissionGate: admissionGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());

			const delivery = internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: fixture.childId, message: "admit after gate" });
			await admissionStarted;

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			releaseAdmission();
			await expect(delivery).resolves.toMatchObject({ deliveryStatus: "delivered" });
		} finally {
			releaseAdmission();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("waits for passivation before rehydrating and delivering a racing a2a message", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-passivation-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childDisposeStarted: markDisposeStarted,
				childDisposeGate: disposeGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());

			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await disposeStarted;
			// The child is still resident and closing while dispose is blocked. A child-ID
			// selector must join passivation instead of treating that resident state as targetable.
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			const delivery = internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({
					target: fixture.childId,
					message: "arrived while passivating",
				});
			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			await Promise.resolve();
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			releaseDispose();

			await expect(passivation).resolves.toBe(1);
			await expect(delivery).resolves.toMatchObject({ deliveryStatus: "delivered" });
			await expect(explicitOpen).resolves.toMatchObject({
				runtime: { metadata: { rlmChildId: fixture.childId } },
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(3);
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledWith(
				expect.stringContaining("arrived while passivating"),
				expect.any(Object),
			);
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("hydrates a passive child when it is opened from its saved-session row", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-open-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			const childState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
				name: "explicit-new-name",
				env: { HERDR_PANE_ID: "pane-42" },
			});

			expect(childState.runtime.metadata).toMatchObject({ kind: "subagent", rlmChildId: fixture.childId });
			expect(childState.runtime.session.sessionName).toBe("explicit-new-name");
			expect(childState.clientEnv).toEqual({ HERDR_PANE_ID: "pane-42" });
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
		});
	});

	it("keeps a passive child row id when attach hydrates it", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-attach-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const client = makeClient("client-1", parentState.activeSessionId);
			client.socket.write = vi.fn(() => true);
			const listResponse = (await internals.handleCommand(client, { type: "list" })) as {
				data: { sessions: SessionSummary[] };
			};
			const passiveRow = listResponse.data.sessions.find(
				(session) => session.sessionFile === fixture.childSessionFile,
			);
			if (!passiveRow) throw new Error("Missing passive child row");
			expect(passiveRow.activeSessionId).toBeUndefined();

			const attachResponse = (await internals.handleCommand(client, {
				type: "attach",
				activeSessionId: passiveRow.id,
			})) as { data: DaemonAttachResult };

			expect(attachResponse.data.activeSessionId).toBe(passiveRow.id);
			expect(internals.sessions.get(passiveRow.id)?.activeSessionId).toBe(passiveRow.id);
			expect(client.attachedActiveSessionIds).toContain(passiveRow.id);
		});
	});

	it("keeps cancel pure when a retained or unknown child has no active run", async () => {
		await withTempDir("optimus-daemon-rlm-cancel-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				cancelRlmChildRun: ReturnType<typeof vi.fn>;
				deleteRlmSubagent: ReturnType<typeof vi.fn>;
			};
			parentSession.cancelRlmChildRun = vi.fn(() => false);
			parentSession.deleteRlmSubagent = vi.fn();

			for (const childId of [fixture.childId, "unknown-child"]) {
				const result = (await internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
					type: "cancel_rlm_child",
					activeSessionId: parentState.activeSessionId,
					childId,
				})) as { data: { cancelled: boolean } };
				expect(result.data.cancelled).toBe(false);
			}
			expect(parentSession.deleteRlmSubagent).not.toHaveBeenCalled();
		});
	});

	it("refuses to delete a busy hydrated child and deletes it after it becomes idle", async () => {
		await withTempDir("optimus-daemon-hydrated-rlm-delete-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			let isStreaming = true;
			Object.defineProperty(childState.runtime.session, "isStreaming", { get: () => isStreaming });
			Object.defineProperty(childState.runtime.session, "unfinishedActionCount", { get: () => 0 });
			const parentSession = parentState.runtime.session as unknown as {
				deleteInactiveRlmSubagent: ReturnType<typeof vi.fn>;
			};
			const deleteSpy = vi.fn(async (childId: string, isExternallyRunning: () => boolean) => {
				if (isExternallyRunning()) return "running" as const;
				await (
					fixture.daemon as unknown as {
						createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
					}
				)
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime(childId, childState.runtime.session);
				return "deleted" as const;
			});
			parentSession.deleteInactiveRlmSubagent = deleteSpy;
			const client = makeClient("client-1", parentState.activeSessionId);

			const busy = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean; reason?: string } };
			expect(busy.data).toEqual({ deleted: false, reason: "running" });
			expect(deleteSpy).not.toHaveBeenCalled();
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);

			isStreaming = false;
			const idle = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean } };
			expect(idle.data).toEqual({ deleted: true });
			expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
		});
	});

	it("refuses to delete a busy nested resident child through the root session", async () => {
		await withTempDir("optimus-daemon-nested-rlm-delete-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const nestedState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const nestedSession = nestedState.runtime.session;
			nestedState.runtime = {
				...nestedState.runtime,
				metadata: {
					...nestedState.runtime.metadata,
					parentActiveSessionId: "intermediate-active",
				},
				session: nestedSession,
			} as ActiveSessionState["runtime"];
			Object.defineProperty(nestedState.runtime.session, "isStreaming", { get: () => true });
			Object.defineProperty(nestedState.runtime.session, "unfinishedActionCount", { get: () => 0 });
			const rootSession = rootState.runtime.session as unknown as {
				deleteInactiveRlmSubagent: ReturnType<typeof vi.fn>;
			};
			const deleteSpy = vi.fn(async () => "deleted" as const);
			rootSession.deleteInactiveRlmSubagent = deleteSpy;

			const result = (await internals.handleCommand(makeClient("client-1", rootState.activeSessionId), {
				type: "delete_rlm_subagent",
				activeSessionId: rootState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean; reason?: string } };

			expect(result.data).toEqual({ deleted: false, reason: "running" });
			expect(deleteSpy).not.toHaveBeenCalled();
			expect(internals.sessions.get(nestedState.activeSessionId)).toBe(nestedState);
		});
	});

	it("deletes a passive child without hydrating it and treats unknown children benignly", async () => {
		await withTempDir("optimus-daemon-lazy-rlm-delete-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				deleteInactiveRlmSubagent: (childId: string) => Promise<"deleted" | "not_found">;
			};
			parentSession.deleteInactiveRlmSubagent = async (childId) => {
				if (childId !== fixture.childId) return "not_found";
				await (
					fixture.daemon as unknown as {
						createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
					}
				)
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime(childId);
				return "deleted";
			};
			const client = makeClient("client-1", parentState.activeSessionId);

			const unknown = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: "unknown-child",
			})) as { data: { deleted: boolean } };
			expect(unknown.data).toEqual({ deleted: false });

			const result = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean } };
			expect(result.data).toEqual({ deleted: true });
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			expect(existsSync(fixture.childSessionFile)).toBe(true);
			// The tombstone is durable in the child's display file ("deleted
			// deliberately, transcript retained") and in the ledger.
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				childId: string;
				status: string;
			};
			expect(display).toMatchObject({ childId: fixture.childId, status: "deleted" });
			const ledgerDir = join(tempDir, "rlm-ledger");
			const ledgerFile = readdirSync(ledgerDir).find((name) => name.endsWith(".jsonl"));
			if (!ledgerFile) throw new Error("Missing RLM ledger file");
			const ledgerOps = readFileSync(join(ledgerDir, ledgerFile), "utf8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line) as { op: string; childId?: string });
			expect(ledgerOps.at(-1)).toMatchObject({ op: "delete", childId: fixture.childId });

			// A retried delete of the now-tombstoned child still resolves the
			// session path and cancels its scheduled jobs.
			const cronStore = (fixture.daemon as unknown as { cronStore: AgentCronJobStore }).cronStore;
			const retryJob = cronStore.create({
				activeSessionId: "gone",
				sessionId: "gone",
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "left-behind heartbeat",
			});
			await (
				fixture.daemon as unknown as { createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost }
			)
				.createSubagentRuntimeHost(parentState)
				.deleteRlmSubagentRuntime(fixture.childId);
			expect(cronStore.list().find((candidate) => candidate.id === retryJob.id)?.status).toBe("cancelled");
		});
	});

	it("removes a deleted child's nested artifact dir but keeps its transcript and display tombstone", async () => {
		await withTempDir("optimus-daemon-artifact-cleanup-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "payload");
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const host = internals.createSubagentRuntimeHost(parentState);
			await host.deleteRlmSubagentRuntime(fixture.childId);

			// Runtime cache gone; transcript + display tombstone (durable record) stay.
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
			// Depth-2 boundary: deleting a child never touches descendant transcripts.
			expect(existsSync(fixture.grandchildSessionFile)).toBe(true);
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				status: string;
			};
			expect(display).toMatchObject({ status: "deleted" });

			// Retry heal: a crash between the tombstone writes and the sweep (or a
			// pre-cleanup build) leaves the dir behind; a retried delete of the
			// tombstoned child sweeps it again.
			mkdirSync(fixture.childArtifactDir, { recursive: true });
			writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "leftover");
			await host.deleteRlmSubagentRuntime(fixture.childId);
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
		});
	});

	// chmod-based read-only dirs don't block root, so skip when running as uid 0.
	it.skipIf(process.getuid?.() === 0)("does not fail a deletion when the artifact dir cannot be removed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-artifact-rm-failure-"));
		let lockedRoot: string | undefined;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const nestedArtifactsRoot = resolve(fixture.childArtifactDir, "..");
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			chmodSync(nestedArtifactsRoot, 0o555);
			lockedRoot = nestedArtifactsRoot;

			// Cache cleanup is best-effort: the rm failure must not surface.
			await internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId);

			expect(existsSync(fixture.childArtifactDir)).toBe(true);
			// Both tombstones are still durable.
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				status: string;
			};
			expect(display).toMatchObject({ status: "deleted" });
			const ledgerFile = readdirSync(join(tempDir, "rlm-ledger")).find((name) => name.endsWith(".jsonl"));
			if (!ledgerFile) throw new Error("Missing RLM ledger file");
			const ledgerOps = readFileSync(join(tempDir, "rlm-ledger", ledgerFile), "utf8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line) as { op: string; childId?: string });
			expect(ledgerOps.some((record) => record.op === "delete" && record.childId === fixture.childId)).toBe(true);
		} finally {
			if (lockedRoot) chmodSync(lockedRoot, 0o755);
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("still sweeps and resolves when scheduled-job cancellation throws", async () => {
		await withTempDir("optimus-daemon-artifact-cancel-throw-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "payload");
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
				cancelScheduledJobsForSessionFile(sessionFile: string): void;
			};
			internals.cancelScheduledJobsForSessionFile = vi.fn(() => {
				throw new Error("corrupt scheduled-jobs.json");
			});
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			// Jobs-store bookkeeping must not fail the deletion or skip the sweep.
			await internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId);

			expect(internals.cancelScheduledJobsForSessionFile).toHaveBeenCalledOnce();
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
		});
	});

	it("sweeps the artifact dir even when child teardown throws", async () => {
		await withTempDir("optimus-daemon-artifact-teardown-throw-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			// A dispose that flushes a fresh kernel snapshot (recreating the
			// artifact dir) and then fails.
			const throwingSession = {
				disposeAsync: vi.fn(async () => {
					mkdirSync(fixture.childArtifactDir, { recursive: true });
					writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "flushed");
					throw new Error("dispose failed");
				}),
			} as unknown as ActiveSessionState["runtime"]["session"];

			await expect(
				internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId, throwingSession),
			).rejects.toThrow("dispose failed");

			expect(throwingSession.disposeAsync).toHaveBeenCalledOnce();
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
		});
	});

	it("cancels scheduled jobs when deleting a pre-ledger legacy child without hydrating it", async () => {
		await withTempDir("optimus-daemon-legacy-delete-jobs-", async (tempDir) => {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
				rlmSpawnLedger(): { appendDelete(input: unknown): Promise<void>; edges(all?: boolean): Promise<unknown[]> };
				cronStore: AgentCronJobStore;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			// Simulate a pre-ledger child the seed missed: only the legacy
			// registry knows it. Remove its seeded edge by deleting the ledger
			// files entirely and pointing the daemon at a fresh (empty) ledger.
			rmSync(join(tempDir, "rlm-ledger"), { recursive: true, force: true });
			(fixture.daemon as unknown as { rlmSpawnLedgerInstance?: unknown }).rlmSpawnLedgerInstance =
				new RlmSpawnLedger(tempDir, join(tempDir, "sessions"));
			const job = internals.cronStore.create({
				activeSessionId: "gone",
				sessionId: "gone",
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "legacy heartbeat",
			});

			await internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId);

			expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)?.status).toBe("cancelled");
			// The durable tombstone lands in the child's display file.
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				status: string;
			};
			expect(display).toMatchObject({ status: "deleted" });
		});
	});

	it("gives RLM subagents messaging controllers for their own nested children", async () => {
		await withTempDir("optimus-daemon-nested-controller-", async (tempDir) => {
			const sessionNamesDuringBind: Array<string | undefined> = [];
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					sessionNamesDuringBind.push(options.sessionManager.getSessionName());
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: join(tempDir, "parent.jsonl"),
			});
			const childSessionName = createDefaultRlmSubagentSessionName("spawn a nested worker", "child-1");
			let publishedWhileBinding = false;
			await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "spawn a nested worker",
				sessionName: childSessionName,
				sessionDir: join(tempDir, "child"),
				model: {} as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmParentNodeId: "child-1",
				onSessionPublished: (session: any) => {
					expect(session.sessionName).toBe(childSessionName);
					const state = [...internals.sessions.values()].find(
						(candidate) => candidate.runtime.session === session,
					);
					publishedWhileBinding = !!state && internals.bindingSessions.has(state.activeSessionId);
				},
			});
			expect(publishedWhileBinding).toBe(true);

			const childOptions = createRuntime.mock.calls[1]?.[0];
			const childController = childOptions?.sessionOptions?.agentMessageController;
			expect(childController).toBeDefined();
			const currentChild = (await childController?.listAgents())?.current;
			const childActiveSessionId = currentChild?.activeSessionId;
			expect(childActiveSessionId).toBeTruthy();
			expect(currentChild?.sessionName).toBe(childSessionName);
			expect(sessionNamesDuringBind[1]).toBeUndefined();

			const grandchildState = makeState("grandchild", childActiveSessionId);
			grandchildState.runtime = {
				...grandchildState.runtime,
				cwd: tempDir,
				metadata: { ...grandchildState.runtime.metadata, rlmChildId: "grandchild-1" },
				session: {
					sessionId: "session-grandchild",
					sessionName: "Grandchild",
					isStreaming: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				},
			} as never;
			internals.sessions.set(grandchildState.activeSessionId, grandchildState);
			expect((await childController?.listAgents())?.agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: grandchildState.activeSessionId,
					parentActiveSessionId: childActiveSessionId,
					rlmChildId: "grandchild-1",
				}),
			);

			const sessionsBeforeCancelledStartup = internals.sessions.size;
			vi.mocked(parentState.runtime.session.getRlmChildRunStatus).mockReturnValue("cancelled");
			await expect(
				internals.createRlmSubagentRuntime(parentState, {
					parentSession: parentState.runtime.session,
					id: "cancelled-child",
					prompt: "delete during daemon startup",
					sessionName: "cancelled-worker",
					sessionDir: join(tempDir, "cancelled-child"),
					model: {} as Model<Api>,
					thinkingLevel: "off",
					serviceTier: null,
					scopedModels: [],
					activeToolNames: [],
					customTools: [],
					includeGoals: false,
					includeCompactSkill: false,
					rlmDepth: 1,
					rlmMaxDepth: 2,
					rlmParentNodeId: "cancelled-child",
				}),
			).rejects.toThrow();
			expect(parentState.runtime.session.getRlmChildRunStatus).toHaveBeenCalledWith("cancelled-child");
			expect(internals.sessions.size).toBe(sessionsBeforeCancelledStartup);
		});
	});

	it("disposes a newly opened runtime when its requested root name collides", async () => {
		await withTempDir("optimus-daemon-root-name-failure-", async (tempDir) => {
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				services: { cwd: options.cwd, agentDir: options.agentDir } as never,
				diagnostics: [],
			}));
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			await internals.createRuntime({ type: "create", sessionPath: join(tempDir, "first.jsonl"), name: "taken" });
			await expect(
				internals.createRuntime({ type: "create", sessionPath: join(tempDir, "second.jsonl"), name: "taken" }),
			).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");

			const failedSession = createRuntime.mock.results[1]?.value
				? (await createRuntime.mock.results[1].value).session
				: undefined;
			expect(failedSession?.disposeAsync).toHaveBeenCalledOnce();
		});
	});

	it("closes a registered RLM runtime when its requested session name cannot be persisted", async () => {
		await withTempDir("optimus-daemon-child-name-failure-", async (tempDir) => {
			let failingChildSession: ReturnType<typeof makeRuntimeSession> | undefined;
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				if (createRuntime.mock.calls.length > 1) {
					failingChildSession = session;
					session.setSessionName = vi.fn(() => {
						throw new Error("name persistence failed");
					});
				}
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: join(tempDir, "parent.jsonl"),
			});
			await expect(
				internals.createRlmSubagentRuntime(parentState, {
					parentSession: parentState.runtime.session,
					id: "child-name-failure",
					prompt: "fail while naming",
					sessionName: "requested-name",
					sessionDir: join(tempDir, "child"),
					model: {} as Model<Api>,
					thinkingLevel: "off",
					serviceTier: null,
					scopedModels: [],
					activeToolNames: [],
					customTools: [],
					includeGoals: false,
					includeCompactSkill: false,
					rlmDepth: 1,
					rlmMaxDepth: 2,
					rlmParentNodeId: "child-name-failure",
				}),
			).rejects.toThrow("name persistence failed");

			expect(failingChildSession).toBeDefined();
			expect(failingChildSession?.disposeAsync).toHaveBeenCalledOnce();
			expect(internals.sessions.size).toBe(1);
		});
	});

	it("waits for extension binding before targeting half-bound sessions", async () => {
		await withTempDir("optimus-daemon-binding-gate-", async (tempDir) => {
			let releaseBind: () => void = () => {};
			const bindBarrier = new Promise<void>((resolve) => {
				releaseBind = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.prompt = vi.fn(async () => {});
				session.bindExtensions = vi.fn(async () => {
					await bindBarrier;
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = makeDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: tempDir,
				createRuntime: createRuntime,
			});
			const internals = daemonInternals(daemon);
			const fromState = makeState("source");
			applySession(fromState, {
				cwd: tempDir,
				sessionId: "session-source",
				sessionName: "Source",
				isStreaming: false,
				unfinishedActionCount: 0,
				runtime: { diagnostics: [] },
			});
			internals.sessions.set(fromState.activeSessionId, fromState);

			const created = internals.createRuntime({ type: "create", sessionPath: join(tempDir, "session.jsonl") });
			for (let attempt = 0; attempt < 50 && internals.sessions.size < 2; attempt++) {
				await Promise.resolve();
			}
			const bindingId = [...internals.sessions.keys()].find((id) => id !== fromState.activeSessionId);
			expect(bindingId).toBeTruthy();

			const message = internals.sendAgentSessionMessage({
				targetSelector: bindingId as string,
				message: "wait for binding",
				fromState,
				origin: "agent",
			});
			const attach = Promise.resolve(
				internals.handleCommand(makeClient("client-1", bindingId as string), {
					id: "command-1",
					type: "attach",
					activeSessionId: bindingId as string,
				}),
			);
			let messageSettled = false;
			let attachSettled = false;
			void message.then(
				() => {
					messageSettled = true;
				},
				() => {
					messageSettled = true;
				},
			);
			void attach.then(
				() => {
					attachSettled = true;
				},
				() => {
					attachSettled = true;
				},
			);
			await Promise.resolve();
			expect(messageSettled).toBe(false);
			expect(attachSettled).toBe(false);
			expect(
				(await internals.createAgentMessageListResult(fromState)).agents.map((agent: any) => agent.activeSessionId),
			).toEqual([fromState.activeSessionId]);

			releaseBind();
			await created;
			await expect(message).resolves.toBeDefined();
			await attach.catch(() => undefined);

			expect(
				(await internals.createAgentMessageListResult(fromState)).agents.map((agent: any) => agent.activeSessionId),
			).toEqual(expect.arrayContaining([fromState.activeSessionId, bindingId]));
		});
	});

	it("includes paused jobs in the default cron list", async () => {
		await withTempDir("optimus-daemon-cron-list-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const internals = daemonInternals(daemon);
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			internals.cronStore.pauseHeartbeat("active-1", new Date("2026-01-01T12:01:00.000Z"));

			const response = (await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "cron_list",
			})) as { data: { jobs: AgentCronJob[] } };

			expect(response.data.jobs).toEqual([expect.objectContaining({ id: heartbeat.id, status: "paused" })]);
		});
	});

	it("cancels scheduled jobs when a live session is killed", async () => {
		await withTempDir("optimus-daemon-kill-cron-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const sessionFile = join(tempDir, "session.jsonl");
			const removeQueuedFollowUp = vi.fn();
			const abort = vi.fn(async () => {});
			const dispose = vi.fn(async () => {});
			const appendSessionState = vi.fn();
			const state = makeState("active-1") as ActiveSessionState;
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "top-level", createdAt: 1 },
				cwd: tempDir,
				dispose,
				session: {
					sessionId: "session-1",
					sessionFile,
					messages: ["user message"],
					sessionManager: {
						appendSessionState,
						hasUserContent: () => true,
					},
					abort,
					removeQueuedFollowUp,
				},
			} as never;
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check long run",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep working",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			internals.cronStore.pauseHeartbeat(state.activeSessionId, new Date("2026-01-01T12:01:00.000Z"));
			const rlmHeartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				runtimeKind: "top-level",
				scheduleText: "every 10m",
				prompt: "keep internal work moving",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});

			for (const id of [cron.id, heartbeat.id, rlmHeartbeat.id]) {
				expect(internals.cronStore.list().find((job: any) => job.id === id)).toMatchObject({ status: "cancelled" });
				expect(internals.cronStore.list().find((job: any) => job.id === id)).not.toHaveProperty("nextRunAt");
			}
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${heartbeat.id}`);
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${rlmHeartbeat.id}`);
			expect(abort).toHaveBeenCalledOnce();
			expect(dispose).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		});
	});

	it("applies killed effects when kill joins a passivation close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-kill-passivation-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const sessionFile = join(tempDir, "session.jsonl");
			const appendSessionState = vi.fn();
			const state = makeState("active-1");
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "subagent", createdAt: 1 },
				cwd: tempDir,
				dispose: vi.fn(async () => {
					markDisposeStarted();
					await disposeGate;
				}),
				session: {
					sessionId: "session-1",
					sessionFile,
					messages: ["user message"],
					isBashRunning: false,
					sessionManager: { appendSessionState, hasUserContent: () => true },
					abort: vi.fn(async () => {}),
				},
			} as never;
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check long run",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const passivationClose = internals.closeSession(state, "shutdown", true, false);
			await disposeStarted;
			const kill = internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});
			releaseDispose();

			await expect(Promise.all([passivationClose, kill])).resolves.toBeDefined();
			expect(internals.cronStore.list().find((job: any) => job.id === cron.id)).toMatchObject({
				status: "cancelled",
			});
			expect(appendSessionState).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("applies a stronger reason after the joined close rejects", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-kill-failed-close-race-"));
		let rejectClose!: (error: Error) => void;
		const failedClose = new Promise<void>((_resolve, reject) => {
			rejectClose = reject;
		});
		try {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const appendSessionState = vi.fn();
			const state = makeState("active-1");
			applySession(state, {
				cwd: tempDir,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				session: { sessionManager: { appendSessionState } },
			});
			const existingClose = {
				promise: failedClose,
				reason: "shutdown" as const,
				descendants: new Set<ActiveSessionState>(),
			};
			const internals = daemonInternals(daemon);
			internals.closingSessions.set(state.activeSessionId, existingClose);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "scheduled work",
			});

			const kill = internals.closeSession(state, "killed");
			rejectClose(new Error("dispose failed"));

			await expect(kill).rejects.toThrow("dispose failed");
			expect(internals.cronStore.list().find((job: any) => job.id === cron.id)).toMatchObject({
				status: "cancelled",
			});
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
			expect(existingClose.reason).toBe("killed");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("finishes a reason upgrade after one target fails to archive", async () => {
		await withTempDir("optimus-daemon-kill-archive-failure-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const parent = makeState("parent");
			const child = makeState("child", parent.activeSessionId);
			const parentArchive = vi.fn(() => {
				throw new Error("archive failed");
			});
			const childArchive = vi.fn();
			for (const [state, sessionId, appendSessionState] of [
				[parent, "session-parent", parentArchive],
				[child, "session-child", childArchive],
			] as const) {
				applySession(state, {
					cwd: tempDir,
					sessionFile: join(tempDir, `${sessionId}.jsonl`),
					session: { sessionId, sessionManager: { appendSessionState } },
				});
			}
			const existingClose = {
				promise: Promise.resolve(),
				reason: "shutdown" as "shutdown" | "killed",
				descendants: new Set([child]),
			};
			const internals = daemonInternals(daemon);
			internals.closingSessions.set(parent.activeSessionId, existingClose);
			const jobs = [parent, child].map((state) =>
				internals.cronStore.create({
					activeSessionId: state.activeSessionId,
					sessionId: state.runtime.session.sessionId,
					sessionFile: state.runtime.session.sessionFile!,
					cwd: tempDir,
					scheduleText: "in 1h",
					prompt: "scheduled work",
				}),
			);

			await expect(internals.closeSession(parent, "killed")).rejects.toThrow("archive failed");

			for (const job of jobs) {
				expect(internals.cronStore.list().find((candidate: any) => candidate.id === job.id)).toMatchObject({
					status: "cancelled",
				});
			}
			expect(parentArchive).toHaveBeenCalledOnce();
			expect(childArchive).toHaveBeenCalledWith({ status: "archived" });
			expect(existingClose.reason).toBe("killed");
			await expect(internals.closeSession(parent, "killed")).resolves.toBeUndefined();
			expect(parentArchive).toHaveBeenCalledOnce();
			expect(childArchive).toHaveBeenCalledOnce();
		});
	});

	it("upgrades resident descendants when kill joins a parent shutdown close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-kill-parent-shutdown-race-"));
		let releaseParentDispose!: () => void;
		const parentDisposeGate = new Promise<void>((resolve) => {
			releaseParentDispose = resolve;
		});
		let markParentDisposeStarted!: () => void;
		const parentDisposeStarted = new Promise<void>((resolve) => {
			markParentDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			parentState.runtime.dispose = vi.fn(async () => {
				markParentDisposeStarted();
				await parentDisposeGate;
			});
			const childJob = internals.cronStore.create({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "scheduled child work",
			});

			const shutdownClose = internals.closeSession(parentState, "shutdown");
			await parentDisposeStarted;
			const kill = internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: parentState.activeSessionId,
			});
			releaseParentDispose();

			await expect(Promise.all([shutdownClose, kill])).resolves.toBeDefined();
			expect(internals.cronStore.list().find((job) => job.id === childJob.id)).toMatchObject({
				status: "cancelled",
			});
			expect(SessionManager.open(fixture.childSessionFile).getSessionState()).toEqual({ status: "archived" });
		} finally {
			releaseParentDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate effects when kill joins a completed close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "optimus-daemon-kill-completed-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const appendSessionState = vi.fn();
			const state = makeState("active-1");
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "subagent", createdAt: 1 },
				cwd: tempDir,
				dispose: vi.fn(async () => {
					markDisposeStarted();
					await disposeGate;
				}),
				session: {
					sessionId: "session-1",
					sessionFile: join(tempDir, "session.jsonl"),
					messages: ["user message"],
					isBashRunning: false,
					sessionManager: { appendSessionState, hasUserContent: () => true },
				},
			} as never;
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check completed run",
			});

			const completedClose = internals.closeSession(state, "completed");
			await disposeStarted;
			const kill = internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});
			releaseDispose();

			await expect(Promise.all([completedClose, kill])).resolves.toBeDefined();
			expect(internals.cronStore.list().find((job: any) => job.id === cron.id)).toMatchObject({
				status: "cancelled",
			});
			expect(appendSessionState).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels scheduled jobs when a saved session is deleted", async () => {
		await withTempDir("optimus-daemon-delete-cron-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const internals = daemonInternals(daemon);
			const sessionFile = join(tempDir, "saved-session.jsonl");
			const otherSessionFile = join(tempDir, "other-session.jsonl");
			const cron = internals.cronStore.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check saved session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep saved session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const unrelated = internals.cronStore.create({
				activeSessionId: "active-2",
				sessionId: "session-2",
				sessionFile: otherSessionFile,
				cwd: tempDir,
				scheduleText: "in 2h",
				prompt: "keep other session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			});

			expect(internals.cronStore.list().find((job: any) => job.id === cron.id)).toMatchObject({
				status: "cancelled",
			});
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
			expect(internals.cronStore.list().find((job: any) => job.id === unrelated.id)).toMatchObject({
				status: "active",
			});
		});
	});

	it("streams detached saved-session catalog requests", async () => {
		await withTempDir("optimus-daemon-saved-session-catalog-", async (tempDir) => {
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(tempDir, sessionDir);
			session.appendSessionState({ status: "active" });
			session.appendAgentStatus({
				summary: "Finished the task",
				taskState: "completed",
				basedOnMessageCount: 0,
			});
			session.appendSessionState({ status: "active" });
			const daemon = stubDaemon({
				socketPath: join(tempDir, "daemon.sock"),
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir,
			});

			const internals = daemonInternals(daemon);
			const writes: string[] = [];
			const client = {
				...makeClient("client-1", "detached"),
				socket: {
					destroyed: false,
					write: (line: string) => {
						writes.push(line);
						return true;
					},
				} as unknown as Socket,
			};

			const response = (await internals.handleCommand(client, {
				id: "list-1",
				type: "list_saved_sessions",
				cwd: tempDir,
				sessionDir,
				scope: "current",
			})) as {
				data: {
					sessions: Array<{
						id: string;
						agentStatus?: {
							summary: string;
							taskState?: "needs_input" | "completed";
							basedOnMessageCount: number;
						};
					}>;
				};
			};
			const updates = writes.map((line) => JSON.parse(line) as { type: string; activeSessionId?: string });

			expect(response.data.sessions).toEqual([
				expect.objectContaining({
					id: session.getSessionId(),
					agentStatus: { summary: "Finished the task", taskState: "completed", basedOnMessageCount: 0 },
				}),
			]);
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "list-1",
						type: "session_list_progress",
						command: "list_saved_sessions",
						loaded: 1,
						total: 1,
					}),
					expect.objectContaining({
						id: "list-1",
						type: "session_list_item",
						command: "list_saved_sessions",
						session: expect.objectContaining({
							id: session.getSessionId(),
							agentStatus: { summary: "Finished the task", taskState: "completed", basedOnMessageCount: 0 },
						}),
					}),
				]),
			);
			expect(updates.every((update) => update.activeSessionId === undefined)).toBe(true);
		});
	});

	it("keeps saved session jobs when file deletion fails", async () => {
		await withTempDir("optimus-daemon-delete-cron-fail-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const deleteSavedSessionFile = vi.fn(async () => ({ ok: false, error: "delete failed" }) as const);
			const internals = daemonInternals(daemon);
			internals.deleteSavedSessionFile = deleteSavedSessionFile;
			const sessionFile = join(tempDir, "saved-session.jsonl");
			const cron = internals.cronStore.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check saved session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep saved session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const response = await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			});

			expect(response).toMatchObject({ data: { ok: false, error: "delete failed" } });
			expect(deleteSavedSessionFile).toHaveBeenCalledWith(sessionFile, {
				afterFileRemoved: expect.any(Function),
			});
			expect(internals.cronStore.list().find((job: any) => job.id === cron.id)).toMatchObject({ status: "active" });
			expect(internals.cronStore.list().find((job: any) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
			});
		});
	});

	it("preserves omitted global scope on daemon refine commands", async () => {
		const daemon = stubDaemon();

		const refine = vi.fn(async () => ({
			id: "refine_daemon",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		}));
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					refine: typeof refine;
				};
			};
		};
		state.runtime.session = { refine } as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "refine",
			activeSessionId: state.activeSessionId,
			instructions: "record local lesson",
		});

		expect(refine).toHaveBeenCalledWith({
			instructions: "record local lesson",
			rollbackId: undefined,
			global: undefined,
		});
	});

	it("routes queued message mutation to the active session", async () => {
		const daemon = stubDaemon();

		const mutateQueuedMessage = vi.fn(() => "applied" as const);
		const state = makeState("active-1") as ActiveSessionState;
		(state.runtime as { session: unknown }).session = { mutateQueuedMessage };
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		const mutation = { type: "replace", text: "edited", lane: "followUp" } as const;
		await expect(
			internals.handleCommand(client, {
				type: "mutate_queued_message",
				activeSessionId: state.activeSessionId,
				lane: "followUp",
				index: 0,
				expectedText: "edited",
				mutation,
			}),
		).resolves.toMatchObject({ success: true, data: { status: "applied" } });
		expect(mutateQueuedMessage).toHaveBeenCalledWith("followUp", 0, "edited", mutation);
	});

	it("gets and sets RLM max depth directly on the active session", async () => {
		const daemon = stubDaemon();

		const getRlmMaxDepthStatus = vi.fn(() => ({ maxDepth: 2, source: "chat" as const }));
		const setRlmMaxDepth = vi.fn(async () => ({
			maxDepth: 3,
			source: "chat" as const,
			globalSaved: true,
		}));
		const state = makeState("active-1") as ActiveSessionState;
		(state.runtime as { session: unknown }).session = { getRlmMaxDepthStatus, setRlmMaxDepth };
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);

		await expect(
			internals.handleCommand(client, {
				type: "get_rlm_max_depth_status",
				activeSessionId: state.activeSessionId,
			}),
		).resolves.toMatchObject({ success: true, data: { maxDepth: 2, source: "chat" } });
		await expect(
			internals.handleCommand(client, {
				type: "set_rlm_max_depth",
				activeSessionId: state.activeSessionId,
				maxDepth: 3,
				global: true,
			}),
		).resolves.toMatchObject({ success: true, data: { maxDepth: 3, globalSaved: true } });
		expect(setRlmMaxDepth).toHaveBeenCalledWith(3, { global: true });
	});

	it.each([
		{
			name: "defers busy heartbeat cron jobs instead of queueing a follow-up",
			activity: { isStreaming: true },
			jobs: [{ id: "heartbeat-1", source: "heartbeat", deliveryMode: "follow_up" }],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: false,
		},
		{
			name: "defers separate RLM heartbeat cron jobs while the session is busy",
			activity: { isStreaming: true },
			jobs: [
				{ id: "rlm-1", source: "rlm_heartbeat", deliveryMode: "follow_up" },
				{ id: "rlm-2", source: "rlm_heartbeat", deliveryMode: "follow_up" },
			],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: false,
		},
		{
			name: "does not enqueue another heartbeat when one is already pending",
			activity: { isStreaming: true, hasPendingSessionWork: true, unfinishedActionCount: 1 },
			jobs: [{ id: "heartbeat-1", source: "heartbeat" }],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: true,
		},
		{
			name: "defers heartbeat cron jobs while the target is accepting an agent message",
			activity: {},
			jobs: [{ id: "heartbeat-1", source: "heartbeat" }],
			acceptingAgentMessage: true,
			assertQueuedHeartbeatUntouched: false,
		},
		{
			name: "defers heartbeat cron jobs while an accepted agent message prompt is in flight",
			activity: { unfinishedActionCount: 1 },
			jobs: [{ id: "heartbeat-1", source: "heartbeat" }],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: false,
		},
	] as const)("$name", async ({ activity, jobs, acceptingAgentMessage, assertQueuedHeartbeatUntouched }) => {
		const fixture = makeCronAdmissionFixture(activity, { acceptingAgentMessage });

		const results = [];
		for (const job of jobs) {
			results.push(await fixture.runCronJob(makeCronJob({ ...job, activeSessionId: fixture.activeSessionId })));
		}

		expect(results).toEqual(jobs.map(() => "skipped"));
		expect(fixture.prompt).not.toHaveBeenCalled();
		expect(fixture.promptHeartbeat).not.toHaveBeenCalled();
		expect(fixture.followUp).not.toHaveBeenCalled();
		if (assertQueuedHeartbeatUntouched) {
			expect(fixture.removeQueuedFollowUp).not.toHaveBeenCalled();
		}
	});

	it.each([
		{
			name: "queues generic cron jobs while the target is accepting an agent message",
			activity: {},
			acceptingAgentMessage: true,
		},
		{
			name: "queues generic cron jobs behind accepted agent message prompts",
			activity: { unfinishedActionCount: 1 },
			acceptingAgentMessage: false,
		},
		{
			name: "queues generic cron jobs behind pending messages",
			activity: { unfinishedActionCount: 1 },
			acceptingAgentMessage: false,
		},
	] as const)("$name", async ({ activity, acceptingAgentMessage }) => {
		const fixture = makeCronAdmissionFixture(activity, { acceptingAgentMessage });

		await fixture.runCronJob(makeCronJob({ id: "cron-1", source: "cron", activeSessionId: fixture.activeSessionId }));

		expect(fixture.followUp).toHaveBeenCalledWith("heartbeat prompt", undefined, { resumeIfIdle: true });
		expect(fixture.prompt).not.toHaveBeenCalled();
		expect(fixture.promptHeartbeat).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "delivers heartbeats with a steering behavior by default",
			job: { id: "heartbeat-1", source: "heartbeat" },
			streamingBehavior: "steer",
			method: "promptHeartbeat",
		},
		{
			name: "delivers follow-up heartbeats with a followUp behavior and coalescing key",
			job: { id: "heartbeat-1", source: "heartbeat", deliveryMode: "follow_up" },
			streamingBehavior: "followUp",
			method: "promptHeartbeat",
		},
		{
			name: "prompts idle generic cron jobs without a heartbeat coalescing key",
			job: { id: "cron-1", source: "cron" },
			streamingBehavior: "followUp",
			method: "prompt",
		},
	] as const)("$name", async ({ job, streamingBehavior, method }) => {
		const fixture = makeCronAdmissionFixture();

		await fixture.runCronJob(makeCronJob({ ...job, activeSessionId: fixture.activeSessionId }));

		const expectedOptions = expect.objectContaining({ streamingBehavior, source: "rpc" });
		if (method === "promptHeartbeat") {
			expect(fixture.promptHeartbeat).toHaveBeenCalledWith(
				expect.objectContaining({ id: job.id, prompt: "heartbeat prompt" }),
				expectedOptions,
			);
			expect(fixture.promptHeartbeat.mock.calls[0]?.[1]).toMatchObject({
				followUpQueueKey: `heartbeat:${job.id}`,
			});
			expect(fixture.prompt).not.toHaveBeenCalled();
		} else {
			expect(fixture.prompt).toHaveBeenCalledWith("heartbeat prompt", expectedOptions);
			expect(fixture.prompt.mock.calls[0]?.[1]).not.toHaveProperty("followUpQueueKey");
			expect(fixture.promptHeartbeat).not.toHaveBeenCalled();
		}
		expect(fixture.followUp).not.toHaveBeenCalled();
	});

	it("delivers steer heartbeats after an RPC prompt finishes preflight while its turn is still streaming", async () => {
		const daemon = stubDaemon();

		let releasePrompt = () => {};
		const promptFinished = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		let reportPromptStarted = () => {};
		const promptStarted = new Promise<void>((resolve) => {
			reportPromptStarted = resolve;
		});
		const sessionState = {
			isStreaming: false,
			isBashRunning: false,
			hasPendingSessionWork: false,
			unfinishedActionCount: 1,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		const prompt = vi.fn(async (_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			sessionState.isStreaming = true;
			options?.preflightResult?.(true);
			reportPromptStarted();
			await promptFinished;
		});
		const promptHeartbeat = vi.fn(
			async (
				_job: AgentCronJob,
				options?: { streamingBehavior?: "steer" | "followUp"; preflightResult?: (didSucceed: boolean) => void },
			) => {
				options?.preflightResult?.(true);
			},
		);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: typeof sessionState & {
					prompt: typeof prompt;
					promptHeartbeat: typeof promptHeartbeat;
				};
			};
		};
		state.runtime.session = Object.assign(sessionState, { prompt, promptHeartbeat }) as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);

		const promptPromise = internals.promptWithAgentMessagePreparingGuard(state, "long-running prompt");
		await promptStarted;
		const preparingReleased = !internals.agentMessagePreparingTargets.has(state.activeSessionId);
		const result = await internals.runCronJob(
			makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }),
		);
		releasePrompt();
		await promptPromise;

		expect(preparingReleased).toBe(true);
		expect(result).toBeUndefined();
		expect(promptHeartbeat).toHaveBeenCalledWith(
			expect.objectContaining({ id: "heartbeat-1" }),
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
	});

	it.each(["steer", "follow_up"] as const)(
		"idle daemon %s inserts into its scheduler lane exactly once",
		async (type) => {
			const daemon = stubDaemon();

			const steer = vi.fn(async () => {});
			const followUp = vi.fn(async () => true);
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: { isStreaming: boolean; steer: typeof steer; followUp: typeof followUp };
				};
			};
			state.runtime = { ...state.runtime, session: { isStreaming: false, steer, followUp } } as never;
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);
			internals.recordWorkerRecoveryState = vi.fn();

			await expect(
				internals.handleCommand(makeClient("client-1", state.activeSessionId), {
					id: "command-1",
					type,
					activeSessionId: state.activeSessionId,
					message: "idle queued turn",
				}),
			).resolves.toMatchObject({
				success: true,
				command: type,
				...(type === "follow_up" ? { data: { queued: true } } : {}),
			});
			const queue = type === "steer" ? steer : followUp;
			expect(queue).toHaveBeenCalledOnce();
			expect(queue).toHaveBeenCalledWith("idle queued turn", undefined, {
				queueKey: undefined,
				agentMessageId: undefined,
				resumeIfIdle: true,
			});
			if (type === "follow_up") {
				expect(internals.recordWorkerRecoveryState).toHaveBeenCalledWith(state, "follow_up_queued", true);
			}
		},
	);

	it("clears prompt admission registered before unauthenticated worker rejection", async () => {
		const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

		const client = makeClient("unauthenticated", "active-1");
		const end = vi.fn();
		client.socket = { destroyed: false, write: vi.fn(() => true), end } as unknown as Socket;
		const internals = daemonInternals(daemon);

		await internals.handleLine(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: "active-1",
				message: "unauthorized",
				admissionId: "leaked-admission",
			}),
		);

		expect(end).toHaveBeenCalledOnce();
		expect(internals.promptAdmissions.size).toBe(0);
	});

	it("clears prompt admission when restart fencing rejects before dispatch", async () => {
		const daemon = stubDaemon({
			socketPath: "/tmp/optimus-worker-test.sock",
			agentDir: "/tmp/optimus-test-agent",
			cwd: "/tmp",
		});

		const client = makeClient("client", "active-1");
		client.socket = { destroyed: false, write: vi.fn(() => true), end: vi.fn() } as unknown as Socket;
		const internals = daemonInternals(daemon);
		internals.updateRestart = { phase: "fencing" };

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "active-1",
				message: "blocked",
				admissionId: "retryable-admission",
			}),
		);

		expect(internals.promptAdmissions.size).toBe(0);
	});

	it.each(["success", "late-failure", "replacement"] as const)(
		"handles cancellation followed by supervisor-claim %s without affecting the wrong socket binding",
		async (outcome) => {
			const daemon = stubDaemon({ worker: { authenticationToken: "worker-token" } });

			const client = makeClient("authenticated", "active-1");
			client.authenticated = true;
			const end = vi.fn();
			client.socket = { destroyed: false, write: vi.fn(() => true), end } as unknown as Socket;
			const claim = {
				supervisorGeneration: "generation",
				supervisorPid: process.pid,
				supervisorSocketPath: "/tmp/supervisor.sock",
			};
			let resolveClaim!: (fingerprint: string) => void;
			let rejectClaim!: (error: Error) => void;
			const claimCheck = new Promise<string>((resolve, reject) => {
				resolveClaim = resolve;
				rejectClaim = reject;
			});
			const internals = daemonInternals(daemon);
			const originalBinding = { claim, ownerFingerprint: "owner" };
			internals.supervisorClaims.set(client, originalBinding);
			internals.assertSupervisorClaimCurrent = vi.fn(() => claimCheck);

			const handling = internals.handleLine(
				client,
				JSON.stringify({
					type: "prompt",
					activeSessionId: "active-1",
					message: "cancel during claim check",
					admissionId: "claim-admission",
				}),
			);
			await vi.waitFor(() => expect(internals.promptAdmissions.size).toBe(1));
			await internals.handleCommand(client, {
				type: "cancel_prompt_admission",
				activeSessionId: "active-1",
				admissionId: "claim-admission",
			});
			await handling;

			expect(internals.promptAdmissions.size).toBe(0);
			expect(end).not.toHaveBeenCalled();
			if (outcome === "replacement") {
				internals.supervisorClaims.set(client, { claim: { ...claim }, ownerFingerprint: "replacement" });
			}
			if (outcome === "success") resolveClaim("refreshed");
			else rejectClaim(new Error("late stale claim"));
			await Promise.resolve();
			await Promise.resolve();

			if (outcome === "late-failure") {
				expect(end).toHaveBeenCalledOnce();
				expect(internals.supervisorClaims.has(client)).toBe(false);
			} else {
				expect(end).not.toHaveBeenCalled();
			}
			if (outcome === "success") expect(originalBinding.ownerFingerprint).toBe("owner");
			if (outcome === "replacement")
				expect(internals.supervisorClaims.get(client)?.ownerFingerprint).toBe("replacement");
		},
	);

	it("cancels only pre-ownership prompt admission and cleans up its controller", async () => {
		const daemon = stubDaemon();

		let promptOptions: { signal?: AbortSignal; admissionCommitted?: () => void } | undefined;
		let rejectPrompt: ((error: Error) => void) | undefined;
		const promptUntilAccepted = vi.fn(
			async (_message: string, options?: { signal?: AbortSignal; admissionCommitted?: () => void }) => {
				promptOptions = options;
				await new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				});
			},
		);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & { session: { promptUntilAccepted: typeof promptUntilAccepted } };
		};
		state.runtime = { ...state.runtime, session: { promptUntilAccepted } } as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write: vi.fn(() => true) } as unknown as Socket;

		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: state.activeSessionId,
				message: "blocked",
				admissionId: "admission-1",
			}),
		);
		internals.handleCommand(client, {
			id: "prompt-1",
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "blocked",
			admissionId: "admission-1",
		});
		await vi.waitFor(() => expect(promptUntilAccepted).toHaveBeenCalledOnce());
		await expect(
			internals.handleCommand(client, {
				id: "cancel-1",
				type: "cancel_prompt_admission",
				activeSessionId: state.activeSessionId,
				admissionId: "admission-1",
			}),
		).resolves.toMatchObject({ success: true, data: { status: "cancelled" } });
		await vi.waitFor(() => expect(internals.promptAdmissions.size).toBe(0));

		// Once ownership commits the same cancellation is a no-op.
		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: state.activeSessionId,
				message: "owned",
				admissionId: "admission-2",
			}),
		);
		internals.handleCommand(client, {
			id: "prompt-2",
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "owned",
			admissionId: "admission-2",
		});
		await vi.waitFor(() => expect(promptUntilAccepted).toHaveBeenCalledTimes(2));
		promptOptions?.admissionCommitted?.();
		await expect(
			internals.handleCommand(client, {
				id: "cancel-2",
				type: "cancel_prompt_admission",
				activeSessionId: state.activeSessionId,
				admissionId: "admission-2",
			}),
		).resolves.toMatchObject({ success: true, data: { status: "owned" } });
		rejectPrompt?.(new Error("test cleanup"));
	});

	it("settles cancellation while prompt routing waits on the target lock", async () => {
		const daemon = stubDaemon();

		const promptUntilAccepted = vi.fn(async () => {});
		const state = makeState("active-lock") as ActiveSessionState;
		state.runtime = { ...state.runtime, session: { promptUntilAccepted } } as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		internals.agentMessageTargetLocks.set(state.activeSessionId, new Promise(() => {}));
		const client = makeClient("client-lock", state.activeSessionId);
		client.socket = { destroyed: false, write: vi.fn(() => true) } as unknown as Socket;
		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: state.activeSessionId,
				message: "blocked",
				admissionId: "lock-admission",
			}),
		);
		internals.handleCommand(client, {
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "blocked",
			admissionId: "lock-admission",
		});
		await expect(
			internals.handleCommand(client, {
				type: "cancel_prompt_admission",
				activeSessionId: state.activeSessionId,
				admissionId: "lock-admission",
			}),
		).resolves.toMatchObject({ data: { status: "cancelled" } });
		await vi.waitFor(() => expect(internals.promptAdmissions.size).toBe(0));
		expect(promptUntilAccepted).not.toHaveBeenCalled();
	});

	it("aborts waiting prompt admissions when their session closes", () => {
		const daemon = stubDaemon();

		const internals = daemonInternals(daemon);
		const client = makeClient("client-closing", "closing-session");
		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: "closing-session",
				message: "blocked",
				admissionId: "closing-admission",
			}),
		);
		const admission = [...internals.promptAdmissions.values()][0]!;
		internals.abortWaitingPromptAdmissionsForSession("closing-session");
		expect(admission.status).toBe("cancelled");
		expect(admission.controller?.signal.aborted).toBe(true);
	});

	it("uses the queued default lane for old-client prompts on a new daemon", async () => {
		const daemon = stubDaemon();

		const promptUntilAccepted = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & { session: { promptUntilAccepted: typeof promptUntilAccepted } };
		};
		state.runtime = { ...state.runtime, session: { promptUntilAccepted } } as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("legacy-client", state.activeSessionId);
		const write = vi.fn((_data: unknown) => true);
		client.socket = { destroyed: false, write } as unknown as Socket;

		internals.handleCommand(client, {
			id: "command-1",
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "legacy prompt",
			streamingBehavior: "followUp",
		});

		await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
		expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ success: true, command: "prompt" });
		expect(promptUntilAccepted).toHaveBeenCalledWith(
			"legacy prompt",
			expect.objectContaining({ streamingBehavior: "followUp", queueIfBusy: true }),
		);
	});

	it("routes resume_queue through the session scheduler", async () => {
		const daemon = stubDaemon();

		const resumeQueuedWork = vi.fn(() => true);
		const continueAgent = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: { resumeQueuedWork: typeof resumeQueuedWork; agent: { continue: typeof continueAgent } };
			};
		};
		state.runtime = { ...state.runtime, session: { resumeQueuedWork, agent: { continue: continueAgent } } } as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);

		await expect(
			internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "resume_queue",
				activeSessionId: state.activeSessionId,
			}),
		).resolves.toMatchObject({ success: true, command: "resume_queue" });
		expect(resumeQueuedWork).toHaveBeenCalledOnce();
		expect(continueAgent).not.toHaveBeenCalled();
	});

	it.each(["steer", "follow_up"] as const)("routes correlated daemon %s commands", async (type) => {
		const daemon = stubDaemon();

		const steer = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const restoreSteeringMessage = vi.fn(async () => {});
		const restoreFollowUpMessage = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					steer: typeof steer;
					followUp: typeof followUp;
					restoreSteeringMessage: typeof restoreSteeringMessage;
					restoreFollowUpMessage: typeof restoreFollowUpMessage;
				};
			};
		};
		state.runtime.session = { steer, followUp, restoreSteeringMessage, restoreFollowUpMessage } as never;
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		const base = { type, activeSessionId: state.activeSessionId } as const;

		await internals.handleCommand(client, {
			...base,
			message: "expanded prompt",
			queueKey: "heartbeat:expanded",
			agentMessageId: `agentmsg_expanded_${type}`,
		});
		const queue = type === "steer" ? steer : followUp;
		expect(queue).toHaveBeenCalledWith("expanded prompt", undefined, {
			queueKey: "heartbeat:expanded",
			agentMessageId: `agentmsg_expanded_${type}`,
			resumeIfIdle: true,
		});

		const replayFields = {
			content: [{ type: "text" as const, text: "restored content" }],
			customMessage: {
				role: "custom" as const,
				customType: "restored",
				content: "restored custom message",
				display: false,
				timestamp: 1,
			},
			prefixMessages: [
				{
					role: "custom" as const,
					customType: "restored-prefix",
					content: "restored prefix",
					display: false,
					timestamp: 1,
				},
			],
		};
		for (const expandPromptTemplates of [undefined, true]) {
			await expect(
				internals.handleCommand(client, {
					...base,
					message: "invalid replay",
					expandPromptTemplates,
					...replayFields,
				}),
			).rejects.toThrow("require expandPromptTemplates=false");
		}

		await internals.handleCommand(client, {
			...base,
			message: "restored prompt",
			queueKey: "heartbeat:job-1",
			agentMessageId: `agentmsg_${type}`,
			expandPromptTemplates: false,
			...replayFields,
		});
		const restore = type === "steer" ? restoreSteeringMessage : restoreFollowUpMessage;
		expect(restore).toHaveBeenCalledWith("restored prompt", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: `agentmsg_${type}`,
			...replayFields,
		});
		expect(queue).toHaveBeenCalledOnce();

		await expect(
			internals.handleCommand(client, { ...base, message: "invalid", agentMessageId: "" }),
		).rejects.toThrow("agentMessageId must not be empty");
	});

	function makeRemoveFollowUpState() {
		const removeQueuedFollowUp = vi.fn(() => true);
		const state = makeState("active-1");
		applySession(state, { session: { removeQueuedFollowUp } });
		return { removeQueuedFollowUp, state };
	}

	function makeHeartbeatFixture(tempDir: string, session: Record<string, unknown> = {}) {
		const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });
		const sessionFile = join(tempDir, "session.jsonl");
		const state = makeState("active-1");
		applySession(state, { cwd: tempDir, sessionId: "session-1", session: { sessionFile, ...session } });
		const internals = daemonInternals(daemon);
		internals.sessions.set(state.activeSessionId, state);
		return { sessionFile, state, internals };
	}

	it("rejects invalid heartbeat delivery modes before persisting", async () => {
		await withTempDir("optimus-daemon-heartbeat-delivery-mode-", async (tempDir) => {
			const { state, internals } = makeHeartbeatFixture(tempDir);

			await expect(
				internals.handleCommand(makeClient("client-1", state.activeSessionId), {
					id: "command-1",
					type: "heartbeat_set",
					activeSessionId: state.activeSessionId,
					schedule: "every 5m",
					prompt: "check the run",
					deliveryMode: "followup" as never,
				}),
			).rejects.toThrow('Heartbeat delivery mode must be "steer" or "follow_up"');
			expect(internals.cronStore.getHeartbeat(state.activeSessionId)).toBeUndefined();
		});
	});

	it("preserves the current heartbeat delivery mode when replacement omits it", async () => {
		await withTempDir("optimus-daemon-heartbeat-preserve-delivery-mode-", async (tempDir) => {
			const { state, internals } = makeHeartbeatFixture(tempDir, { removeQueuedFollowUp: vi.fn(() => false) });
			const client = makeClient("client-1", state.activeSessionId);

			await internals.handleCommand(client, {
				id: "command-1",
				type: "heartbeat_set",
				activeSessionId: state.activeSessionId,
				schedule: "every 5m",
				prompt: "first instruction",
				deliveryMode: "follow_up",
			});
			const replacement = await internals.handleCommand(client, {
				id: "command-2",
				type: "heartbeat_set",
				activeSessionId: state.activeSessionId,
				schedule: "every 10m",
				prompt: "replacement instruction",
			});

			expect(replacement.data.heartbeat).toMatchObject({
				prompt: "replacement instruction",
				deliveryMode: "follow_up",
			});
		});
	});

	it("removes queued RLM heartbeat follow-ups when only delivery mode changes", async () => {
		await withTempDir("optimus-daemon-rlm-delivery-mode-", async (tempDir) => {
			const { removeQueuedFollowUp, state } = makeRemoveFollowUpState();
			const internals = daemonInternals(
				stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir }),
			);
			const rlmHeartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check internal state",
				deliveryMode: "follow_up",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const updated = internals.updateRlmHeartbeatForState(state, {
				id: rlmHeartbeat.id,
				deliveryMode: "steer",
			});

			expect(updated).toMatchObject({ id: rlmHeartbeat.id, deliveryMode: "steer" });
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${rlmHeartbeat.id}`);
		});
	});

	it("removes queued heartbeat follow-ups when a heartbeat is cleared", async () => {
		await withTempDir("optimus-daemon-heartbeat-clear-", async (tempDir) => {
			const { removeQueuedFollowUp, state } = makeRemoveFollowUpState();
			const internals = daemonInternals(
				stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir }),
			);
			internals.sessions.set(state.activeSessionId, state);
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "heartbeat_update",
				activeSessionId: state.activeSessionId,
				action: "clear",
			});

			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${heartbeat.id}`);
		});
	});

	it("manages a persisted heartbeat after its session unloads", async () => {
		await withTempDir("optimus-daemon-unloaded-heartbeat-", async (tempDir) => {
			const daemon = stubDaemon({ socketPath: join(tempDir, "daemon.sock"), agentDir: tempDir, cwd: tempDir });

			const internals = daemonInternals(daemon);
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "unloaded-session",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
			});

			const response = await internals.handleCommand(makeClient("client-1", "unloaded-session"), {
				id: "command-1",
				type: "heartbeat_manage",
				activeSessionId: "unloaded-session",
				jobId: heartbeat.id,
				action: "stop",
			});

			expect(response).toMatchObject({
				success: true,
				data: { heartbeat: { id: heartbeat.id, status: "cancelled" } },
			});
		});
	});

	// Table over the set_model / cycle_model quartet: the only variable under test is
	// whether the session is streaming, which decides if model_select handlers must wait.
	const modelSelectWaitCases = [
		{
			name: "sets models without waiting for model_select extension handlers while running",
			commandType: "set_model",
			isStreaming: true,
			waitForExtensions: false,
		},
		{
			name: "waits for model_select extension handlers when setting models while idle",
			commandType: "set_model",
			isStreaming: false,
			waitForExtensions: true,
		},
		{
			name: "cycles models without waiting for model_select extension handlers while running",
			commandType: "cycle_model",
			isStreaming: true,
			waitForExtensions: false,
			direction: "backward" as const,
		},
		{
			name: "waits for model_select extension handlers when cycling models while idle",
			commandType: "cycle_model",
			isStreaming: false,
			waitForExtensions: true,
		},
	];
	for (const modelCase of modelSelectWaitCases) {
		it(modelCase.name, async () => {
			const daemon = stubDaemon();
			const model: Model<Api> = {
				provider: "faux",
				id: "faux-2",
				name: "Two",
				api: "openai-completions",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			};
			const setModel = vi.fn(async () => {});
			const cycleResult = { model, thinkingLevel: "off" as const, isScoped: false };
			const cycleModel = vi.fn(async () => cycleResult);
			const state = makeState("active-1");
			applySession(state, {
				isStreaming: modelCase.isStreaming,
				isCompacting: false,
				session:
					modelCase.commandType === "set_model"
						? { modelRegistry: { refreshAvailableModels: vi.fn(async () => [model]) }, setModel }
						: { cycleModel },
			});
			const internals = daemonInternals(daemon);
			internals.sessions.set(state.activeSessionId, state);

			const command: DaemonCommand =
				modelCase.commandType === "set_model"
					? {
							id: "command-1",
							type: "set_model",
							activeSessionId: state.activeSessionId,
							provider: "faux",
							modelId: "faux-2",
						}
					: {
							id: "command-1",
							type: "cycle_model",
							activeSessionId: state.activeSessionId,
							...(modelCase.direction ? { direction: modelCase.direction } : {}),
						};
			await internals.handleCommand(makeClient("client-1", state.activeSessionId), command);

			if (modelCase.commandType === "set_model") {
				expect(setModel).toHaveBeenCalledWith(model, { waitForExtensions: modelCase.waitForExtensions });
			} else {
				expect(cycleModel).toHaveBeenCalledWith(modelCase.direction, {
					waitForExtensions: modelCase.waitForExtensions,
				});
			}
		});
	}

	it("validates active sessions before reading a heartbeat", async () => {
		const daemon = stubDaemon();

		const handleCommand = (
			daemon as unknown as {
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			}
		).handleCommand.bind(daemon);

		await expect(
			handleCommand(makeClient("client-1", "missing"), {
				id: "command-1",
				type: "heartbeat_get",
				activeSessionId: "missing",
			}),
		).rejects.toThrow("Unknown active session: missing");
	});
});

type CronAdmissionActivity = Partial<{
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	hasPendingSessionWork: boolean;
	unfinishedActionCount: number;
}>;

function makeCronAdmissionFixture(
	activity: CronAdmissionActivity = {},
	options: { acceptingAgentMessage?: boolean } = {},
) {
	const activeSessionId = "active-1";
	const daemon = stubDaemon();

	const prompt = vi.fn(
		async (
			_message: string,
			_options?: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string; source?: string },
		) => {},
	);
	const promptHeartbeat = vi.fn(
		async (
			_job: AgentCronJob,
			_options?: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string; source?: string },
		) => {},
	);
	const followUp = vi.fn(async () => true);
	const removeQueuedFollowUp = vi.fn(() => true);
	const state = makeState(activeSessionId) as ActiveSessionState & {
		runtime: ActiveSessionState["runtime"] & { session: Record<string, unknown> };
	};
	applySession(state, {
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		hasPendingSessionWork: false,
		unfinishedActionCount: 0,
		session: { ...activity, prompt, promptHeartbeat, followUp, removeQueuedFollowUp },
		runtime: { diagnostics: [] },
	});
	const internals = daemonInternals(daemon);
	internals.sessions.set(activeSessionId, state);
	if (options.acceptingAgentMessage) {
		internals.agentMessageAcceptingTargets.add(activeSessionId);
	}

	return {
		activeSessionId,
		prompt,
		promptHeartbeat,
		followUp,
		removeQueuedFollowUp,
		runCronJob: internals.runCronJob.bind(daemon),
	};
}
