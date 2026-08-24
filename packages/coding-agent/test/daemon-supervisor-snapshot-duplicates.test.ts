import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DaemonAttachResult, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor, DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

type HandleWorkerFrame = (worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>) => void;

function supervisorInternals(supervisor: DaemonSupervisor): { handleWorkerFrame: HandleWorkerFrame } {
	const method = Reflect.get(supervisor, "handleWorkerFrame") as HandleWorkerFrame;
	return { handleWorkerFrame: method.bind(supervisor) };
}

const activeSessionId = "active-duplicate";
const snapshotId = "snapshot-duplicate";

interface DuplicateValidation {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface SnapshotGeneration {
	transcript: SnapshotTranscriptCache;
	result: DaemonAttachResult;
	begin?: Buffer;
	end?: Buffer;
	incoming: boolean;
	retired: boolean;
	duplicateChunkIndex?: number;
	duplicateResult?: DaemonAttachResult;
	validation?: DuplicateValidation;
}

interface WorkerHarness {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<string, Map<string, SnapshotGeneration>>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	intentionalStop: boolean;
	stopRevision: number;
}

function summary(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-duplicate",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function workerHarness(): WorkerHarness {
	return {
		descriptor: {
			version: 1,
			workerId: "worker-duplicate",
			pid: 987_654_321,
			socketPath: "/tmp/duplicate-snapshot-worker.sock",
			recoveryJournalPath: "/tmp/duplicate-snapshot-recovery-journal.json",
			supervisorSocketPath: "/tmp/duplicate-snapshot-supervisor.sock",
			authenticationToken: "token-duplicate",
			rootActiveSessionId: activeSessionId,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			lifecycle: "ready",
			createCommand: { type: "create" },
			consecutiveFailures: 0,
		},
		descriptorPath: "/tmp/duplicate-snapshot-descriptor.json",
		summaries: new Map([[activeSessionId, summary()]]),
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

function transcriptMessages(): AgentMessage[] {
	return [{ role: "user", content: "stable", timestamp: 1 }];
}

function divergentMessages(): AgentMessage[] {
	return [{ role: "user", content: "rewritten", timestamp: 2 }];
}

function outboundFrame(
	message: DaemonOutbound,
	payload: Buffer,
	purpose?: "replacement",
): { frame: PrivateFrame<DaemonWorkerFrameHeader>; payload: Buffer } {
	const header: DaemonWorkerFrameHeader = {
		kind: "outbound",
		outboundType: message.type,
		activeSessionId: "activeSessionId" in message ? message.activeSessionId : undefined,
		snapshotId: "snapshotId" in message ? message.snapshotId : undefined,
		payloadEncoding: "jsonl",
		...(purpose ? { snapshotPurpose: purpose } : {}),
	};
	return { frame: { header, payload }, payload };
}

function chunkPayload(messagesValue: AgentMessage[], keyOrder: "canonical" | "reversed"): Buffer {
	if (keyOrder === "canonical") {
		const message: DaemonOutbound = {
			type: "session_snapshot_chunk",
			activeSessionId,
			snapshotId,
			index: 0,
			messages: messagesValue,
		};
		return Buffer.from(JSON.stringify(message));
	}
	// Same chunk content with reversed top-level key order: different bytes, identical messages.
	return Buffer.from(
		`{"messages":${JSON.stringify(messagesValue)},"index":0,"snapshotId":"${snapshotId}",` +
			`"activeSessionId":"${activeSessionId}","type":"session_snapshot_chunk"}`,
	);
}

function beginEndFrames(purpose?: "replacement") {
	const beginMessage: DaemonOutbound = {
		type: "session_snapshot_begin",
		activeSessionId,
		snapshotId,
		snapshot: {
			activeSessionId,
			summary: summary(),
			state: { activeSessionId, sessionId: "session-duplicate" } as DaemonAttachResult["snapshot"]["state"],
			lastEventSequence: 1,
			lastEventCursor: { generation: "gen-duplicate", sequence: 1 },
		},
		messageCount: 1,
		targetChunkBytes: 512 * 1024,
	};
	const endMessage: DaemonOutbound = {
		type: "session_snapshot_end",
		activeSessionId,
		snapshotId,
		chunkCount: 1,
		lastEventSequence: 1,
		lastEventCursor: { generation: "gen-duplicate", sequence: 1 },
	};
	return {
		begin: outboundFrame(beginMessage, Buffer.from(JSON.stringify(beginMessage)), purpose),
		end: outboundFrame(endMessage, Buffer.from(JSON.stringify(endMessage)), purpose),
	};
}

function runFirstTransfer(
	handleWorkerFrame: (worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>) => void,
	worker: WorkerHarness,
): DuplicateValidation | undefined {
	const { begin, end } = beginEndFrames();
	handleWorkerFrame(worker, begin.frame);
	handleWorkerFrame(
		worker,
		outboundFrame(
			{ type: "session_snapshot_chunk", activeSessionId, snapshotId, index: 0, messages: transcriptMessages() },
			chunkPayload(transcriptMessages(), "canonical"),
		).frame,
	);
	handleWorkerFrame(worker, end.frame);
	expect(worker.transcriptCaches.get(activeSessionId)?.complete).toBe(true);
	return worker.snapshotGenerations?.get(activeSessionId)?.get(snapshotId)?.validation;
}

describe("duplicate snapshot resync transfers", () => {
	it("accepts a duplicate chunk whose bytes differ but carry identical messages", async () => {
		const supervisor = new DaemonSupervisor("/tmp/duplicate-snapshot-heal.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/duplicate-snapshot-heal-state",
		});
		const { handleWorkerFrame } = supervisorInternals(supervisor);
		const worker = workerHarness();

		runFirstTransfer(handleWorkerFrame, worker);

		const { begin, end } = beginEndFrames("replacement");
		handleWorkerFrame(worker, begin.frame);
		const generation = worker.snapshotGenerations?.get(activeSessionId)?.get(snapshotId);
		expect(generation?.incoming).toBe(true);
		const validation = generation?.validation;
		if (!validation) {
			throw new Error("duplicate validation was not created");
		}

		handleWorkerFrame(
			worker,
			outboundFrame(
				{ type: "session_snapshot_chunk", activeSessionId, snapshotId, index: 0, messages: transcriptMessages() },
				chunkPayload(transcriptMessages(), "reversed"),
				"replacement",
			).frame,
		);
		expect(generation?.incoming).toBe(true);

		handleWorkerFrame(worker, end.frame);
		await expect(validation.promise).resolves.toBeUndefined();
		expect(generation?.incoming).toBe(false);
		expect(generation?.duplicateChunkIndex).toBeUndefined();
		expect(worker.transcriptCaches.get(activeSessionId)?.complete).toBe(true);
		expect(worker.snapshotCache.has(activeSessionId)).toBe(true);
	});

	it("invalidates the cache and keeps the worker channel on genuinely divergent duplicate chunks", async () => {
		const supervisor = new DaemonSupervisor("/tmp/duplicate-snapshot-diverge.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/duplicate-snapshot-diverge-state",
		});
		const { handleWorkerFrame } = supervisorInternals(supervisor);
		const close = vi.fn();
		const worker = workerHarness();
		Object.assign(worker, {
			client: {
				close,
				request: async () => {
					throw new Error("unexpected worker request");
				},
			},
		});

		runFirstTransfer(handleWorkerFrame, worker);

		const { begin } = beginEndFrames("replacement");
		handleWorkerFrame(worker, begin.frame);
		const generation = worker.snapshotGenerations?.get(activeSessionId)?.get(snapshotId);
		const validation = generation?.validation;
		if (!validation) {
			throw new Error("duplicate validation was not created");
		}

		handleWorkerFrame(
			worker,
			outboundFrame(
				{ type: "session_snapshot_chunk", activeSessionId, snapshotId, index: 0, messages: divergentMessages() },
				chunkPayload(divergentMessages(), "canonical"),
				"replacement",
			).frame,
		);

		await expect(validation.promise).rejects.toThrow(/diverged from the cached transfer/);
		expect(close).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.transcriptCaches.has(activeSessionId)).toBe(false);
		expect(worker.snapshotCache.has(activeSessionId)).toBe(false);
		expect(worker.snapshotGenerations?.has(activeSessionId)).toBe(false);
	});
});
