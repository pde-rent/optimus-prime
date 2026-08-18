import type { AgentMessage, GetContinuationMessagesContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousStatus,
	createAutonomousRuntimeState,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
} from "./autonomous.js";
import type { CustomMessage } from "./messages.js";
import { parseSessionSlashCommand } from "./slash-commands.js";

type AutonomousSlashCommand = { kind: "status" } | { kind: "on" } | { kind: "off" };

type AutonomousRuntimeSnapshot = Pick<
	AutonomousRuntimeState,
	"continuationsUsed" | "gateAttempts" | "lastGateFailure" | "lastGateFailureSnapshot"
>;

export interface AutonomousContinuationManagerDeps {
	getCwd(): string;
	getAgentSignal(): AbortSignal;
	getSessionInputArrivalEpoch(): number;

	// Post-compaction continuation message management (shared with compaction)
	getPostCompactionContinuationMessages(): AgentMessage[];
	addPostCompactionContinuationMessage(message: AgentMessage): void;
	filterPostCompactionContinuationMessages(predicate: (m: AgentMessage) => boolean): void;

	// Continue-after-threshold-compaction flag (shared with compaction)
	setContinueAfterThresholdCompaction(value: boolean): void;

	// Session interaction
	enqueueAutonomousFollowUp(text: string, message: AgentMessage): void;
	removeQueuedMessages(predicate: (m: AgentMessage) => boolean): AgentMessage[];
	cancelSessionActionsForMessages(messages: Set<AgentMessage>, error: Error): void;
	emitQueueUpdate(): void;
	cancelPostCompactionContinue(): void;
	hasQueuedMessages(): boolean;
	getUnfinishedActionCount(): number;

	// For status emission
	pushAgentMessage(message: AgentMessage): void;
	appendCustomMessageEntry(customType: string, content: string, display?: boolean, details?: unknown): void;
	emitSessionEvent(event: AgentSessionEvent): void;
}

export class AutonomousContinuationManager {
	private _autonomousState: AutonomousRuntimeState;
	private _continuationSuppressionDepth = 0;
	private _continuationSuppressedMessages = new WeakSet<AgentMessage>();
	private _queuedThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionMessages: AgentMessage[] = [];

	constructor(
		private readonly _deps: AutonomousContinuationManagerDeps,
		config?: AgentAutonomousConfig,
	) {
		this._autonomousState = createAutonomousRuntimeState(config, {
			cwd: _deps.getCwd(),
		});
	}

	getStatus(): AgentAutonomousStatus {
		return autonomousStatus(this._autonomousState);
	}

	recordHostContinuation(): void {
		addAutonomousContinuation(this._autonomousState);
	}

	async refreshGates(): Promise<void> {
		await refreshAutonomousQualityGates(this._autonomousState, {
			cwd: this._deps.getCwd(),
		});
	}

	addUsage(usage: Usage | undefined): void {
		addAutonomousUsage(this._autonomousState, usage);
	}

	async handleSlashCommand(text: string): Promise<boolean> {
		const command = this._parseSlashCommand(text);
		if (!command) {
			return false;
		}
		if (command.kind === "on") {
			setAutonomousEnabled(this._autonomousState, true, { cwd: this._deps.getCwd() });
		} else if (command.kind === "off") {
			setAutonomousEnabled(this._autonomousState, false);
			this.clearQueuedContinuations();
		}
		this._emitStatus();
		return true;
	}

	async queueContinuationForThresholdCompaction(message: AssistantMessage): Promise<AgentMessage | undefined> {
		const queuedMessage = this._queuedThresholdContinuations.get(message);
		if (queuedMessage && this._deps.getPostCompactionContinuationMessages().includes(queuedMessage)) {
			return queuedMessage;
		}
		const snapshot = this._snapshotState();
		const arrivalEpoch = this._deps.getSessionInputArrivalEpoch();
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, message, {
			cwd: this._deps.getCwd(),
			signal: this._deps.getAgentSignal(),
		});
		if (!autonomousMessage) {
			return undefined;
		}
		if (this._deps.getSessionInputArrivalEpoch() !== arrivalEpoch) {
			this._restoreStateSnapshot(snapshot);
			return undefined;
		}
		this._queuedThresholdContinuations.set(message, autonomousMessage);
		this._queuedContinuationSnapshots.set(autonomousMessage, snapshot);
		this._deps.addPostCompactionContinuationMessage(autonomousMessage);
		this._pendingThresholdCompactionMessages.push(autonomousMessage);
		const text =
			typeof autonomousMessage.content === "string"
				? autonomousMessage.content
				: autonomousMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		this._deps.enqueueAutonomousFollowUp(text, autonomousMessage);
		return autonomousMessage;
	}

	clearQueuedContinuations(options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {}): void {
		const requestedMessages = options.messages ?? [...this._deps.getPostCompactionContinuationMessages()];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this._deps
			.getPostCompactionContinuationMessages()
			.filter((message) => requestedMessageSet.has(message));
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this._deps.filterPostCompactionContinuationMessages((message) => !queuedMessageSet.has(message));
		this._deps.removeQueuedMessages((message) => queuedMessageSet.has(message));
		this._deps.cancelSessionActionsForMessages(
			queuedMessageSet,
			new Error("Queued autonomous continuation was cleared before delivery."),
		);
		this._deps.emitQueueUpdate();
		if (options.restoreAutonomousState) {
			for (const queuedMessage of queuedMessages) {
				const snapshot = this._queuedContinuationSnapshots.get(queuedMessage);
				if (snapshot) {
					this._restoreStateSnapshot(snapshot);
					break;
				}
			}
		}
		for (const queuedMessage of queuedMessages) {
			this._queuedContinuationSnapshots.delete(queuedMessage);
		}
		this._pendingThresholdCompactionMessages = this._pendingThresholdCompactionMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		if (options.messages === undefined) {
			this._deps.setContinueAfterThresholdCompaction(false);
		}
		if (!this._deps.hasQueuedMessages() && this._deps.getUnfinishedActionCount() === 0) {
			this._deps.cancelPostCompactionContinue();
		}
	}

	clearQueuedContinuationsAfterSkippedThresholdCompaction(
		shouldContinueAfterThreshold: boolean,
		queuedMessages: AgentMessage[],
	): void {
		if (shouldContinueAfterThreshold) {
			this.clearQueuedContinuations({
				restoreAutonomousState: true,
				messages: queuedMessages,
			});
		}
	}

	drainPendingThresholdCompactionMessages(): AgentMessage[] {
		return this._pendingThresholdCompactionMessages.splice(0);
	}

	deleteContinuationSnapshot(message: AgentMessage): void {
		this._queuedContinuationSnapshots.delete(message);
	}

	async getAutonomousContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (
			this._continuationSuppressionDepth > 0 ||
			context.newMessages.some((message) => this._continuationSuppressedMessages.has(message))
		) {
			return [];
		}
		const arrivalEpoch = this._deps.getSessionInputArrivalEpoch();
		const autonomousSnapshot = this._snapshotState();
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, context.message, {
			cwd: this._deps.getCwd(),
			signal,
		});
		if (autonomousMessage && this._deps.getSessionInputArrivalEpoch() !== arrivalEpoch) {
			this._restoreStateSnapshot(autonomousSnapshot);
			return [];
		}
		return autonomousMessage ? [autonomousMessage] : [];
	}

	async runWithContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		this._continuationSuppressionDepth++;
		try {
			return await fn();
		} finally {
			this._continuationSuppressionDepth--;
		}
	}

	markContinuationSuppressed(message: AgentMessage): void {
		this._continuationSuppressedMessages.add(message);
	}

	isContinuationSuppressed(): boolean {
		return this._continuationSuppressionDepth > 0;
	}

	isMessageContinuationSuppressed(message: AgentMessage): boolean {
		return this._continuationSuppressedMessages.has(message);
	}

	private _parseSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const rest = command.args.toLowerCase();
		if (!rest || rest === "status") {
			return { kind: "status" };
		}
		if (rest === "on" || rest === "enable" || rest === "enabled") {
			return { kind: "on" };
		}
		if (rest === "off" || rest === "disable" || rest === "disabled") {
			return { kind: "off" };
		}
		throw new Error("Usage: /autonomous [on|off|status]");
	}

	private _formatStatus(): string {
		const status = this.getStatus();
		const state = status.enabled ? "on" : "off";
		return `Autonomous mode: ${state}. Continuations: ${status.continuationsUsed}/${status.limits.maxContinuations}. Turns: ${status.turnsUsed}/${status.limits.maxTurns}. Tokens: ${status.tokensUsed}/${status.limits.maxTokens}.`;
	}

	private _emitStatus(): void {
		const message = {
			role: "custom" as const,
			customType: "autonomous_status",
			content: this._formatStatus(),
			display: true,
			details: this.getStatus(),
			timestamp: Date.now(),
		} satisfies CustomMessage<AgentAutonomousStatus>;
		this._deps.pushAgentMessage(message);
		this._deps.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		this._deps.emitSessionEvent({ type: "message_start", message });
		this._deps.emitSessionEvent({ type: "message_end", message });
	}

	private _snapshotState(): AutonomousRuntimeSnapshot {
		return {
			continuationsUsed: this._autonomousState.continuationsUsed,
			gateAttempts: { ...this._autonomousState.gateAttempts },
			lastGateFailure: this._autonomousState.lastGateFailure
				? { ...this._autonomousState.lastGateFailure }
				: undefined,
			lastGateFailureSnapshot: this._autonomousState.lastGateFailureSnapshot
				? { ...this._autonomousState.lastGateFailureSnapshot }
				: undefined,
		};
	}

	private _restoreStateSnapshot(snapshot: AutonomousRuntimeSnapshot): void {
		this._autonomousState.continuationsUsed = snapshot.continuationsUsed;
		this._autonomousState.gateAttempts = { ...snapshot.gateAttempts };
		this._autonomousState.lastGateFailure = snapshot.lastGateFailure ? { ...snapshot.lastGateFailure } : undefined;
		this._autonomousState.lastGateFailureSnapshot = snapshot.lastGateFailureSnapshot
			? { ...snapshot.lastGateFailureSnapshot }
			: undefined;
	}
}
