/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionMessageReceipt, AgentSessionMessageSafetyStatus } from "../../core/agent-messages.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { AgentConnectionHeartbeat } from "../agent-connection/types.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcObservedSessionEvent,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/** Extended response timeout for refine requests, which run an LLM pass. */
export const REFINE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcObservedSessionListener = (event: RpcObservedSessionEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private observedSessionListeners: RpcObservedSessionListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Collect stderr for debugging
		this.process.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	onObservedSessionEvent(listener: RpcObservedSessionListener): () => void {
		this.observedSessionListeners.push(listener);
		return () => {
			const index = this.observedSessionListeners.indexOf(listener);
			if (index !== -1) {
				this.observedSessionListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return this.request({ type: "new_session", parentSession });
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		return this.request({ type: "get_state" });
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return this.request({ type: "set_model", provider, modelId });
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		return this.request({ type: "cycle_model" });
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		return (await this.request<{ models: ModelInfo[] }>({ type: "get_available_models" })).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		return this.request({ type: "cycle_thinking_level" });
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.request({ type: "compact", customInstructions });
	}

	/**
	 * Refine editable continual harness state.
	 */
	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
	): Promise<RefinementResult> {
		// Refinement runs an LLM pass that routinely exceeds the default 30s response
		// timeout, so use the same extended window as the daemon refine path.
		const command = { type: "refine", instructions: options.instructions, rollbackId: options.rollbackId } as {
			type: "refine";
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		};
		if (options.global !== undefined) {
			command.global = options.global;
		}
		return this.request(command, REFINE_REQUEST_TIMEOUT_MS);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		return this.request({ type: "bash", command });
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		return this.request({ type: "get_session_stats" });
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		return this.request({ type: "export_html", outputPath });
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.request({ type: "switch_session", sessionPath });
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return this.request({ type: "fork", entryId });
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		return this.request({ type: "clone" });
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		return (await this.request<{ text: string | null }>({ type: "get_last_assistant_text" })).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		return (await this.request<{ messages: AgentMessage[] }>({ type: "get_messages" })).messages;
	}

	async sendAgentMessage(targetActiveSessionId: string, message: string): Promise<AgentSessionMessageReceipt> {
		const response = await this.send({
			type: "send_message",
			targetActiveSessionId,
			message,
		});
		return this.getData(response);
	}

	async getAgentMessageStatus(): Promise<AgentSessionMessageSafetyStatus> {
		return this.getData(await this.send({ type: "agent_messages_status" }));
	}

	async pauseAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		return this.getData(await this.send({ type: "agent_messages_pause" }));
	}

	async resumeAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		return this.getData(await this.send({ type: "agent_messages_resume" }));
	}

	async clearAgentMessages(): Promise<number> {
		return (await this.request<{ cleared: number }>({ type: "agent_messages_clear" })).cleared;
	}

	async listSchedules(includeInactive?: boolean): Promise<AgentCronJob[]> {
		return (await this.request<{ jobs: AgentCronJob[] }>({ type: "list_schedules", includeInactive })).jobs;
	}

	async addSchedule(schedule: string, prompt: string): Promise<AgentCronJob> {
		return (await this.request<{ job: AgentCronJob }>({ type: "add_schedule", schedule, prompt })).job;
	}

	async cancelSchedule(jobId: string): Promise<AgentCronJob> {
		return (await this.request<{ job: AgentCronJob }>({ type: "cancel_schedule", jobId })).job;
	}

	async listHeartbeats(): Promise<AgentConnectionHeartbeat[]> {
		return (await this.request<{ heartbeats: AgentConnectionHeartbeat[] }>({ type: "list_heartbeats" })).heartbeats;
	}

	async getHeartbeat(): Promise<AgentCronJob | null> {
		return (await this.request<{ heartbeat: AgentCronJob | null }>({ type: "get_heartbeat" })).heartbeat;
	}

	async setHeartbeat(
		schedule: string,
		prompt: string,
		deliveryMode?: AgentHeartbeatDeliveryMode,
	): Promise<AgentCronJob> {
		const response = await this.send({ type: "set_heartbeat", schedule, prompt, deliveryMode });
		const heartbeat = this.getData<{ heartbeat: AgentCronJob | null }>(response).heartbeat;
		if (!heartbeat) {
			throw new Error("Daemon did not return the created heartbeat");
		}
		return heartbeat;
	}

	async updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | null> {
		return (await this.request<{ heartbeat: AgentCronJob | null }>({ type: "update_heartbeat", action })).heartbeat;
	}

	async manageHeartbeat(
		activeSessionId: string,
		jobId: string,
		action: AgentHeartbeatManagementAction,
	): Promise<AgentCronJob> {
		const response = await this.send({ type: "manage_heartbeat", activeSessionId, jobId, action });
		const heartbeat = this.getData<{ heartbeat: AgentCronJob | null }>(response).heartbeat;
		if (!heartbeat) {
			throw new Error("Daemon did not return the managed heartbeat");
		}
		return heartbeat;
	}

	async observe(activeSessionId: string): Promise<AgentMessage[]> {
		return (await this.request<{ messages: AgentMessage[] }>({ type: "observe", activeSessionId })).messages;
	}

	async unobserve(activeSessionId: string): Promise<void> {
		await this.send({ type: "unobserve", activeSessionId });
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		return (await this.request<{ commands: RpcSlashCommand[] }>({ type: "get_commands" })).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}
			if (data.type === "observed_session_event" || data.type === "observed_session_closed") {
				for (const listener of [...this.observedSessionListeners]) {
					try {
						listener(data as RpcObservedSessionEvent);
					} catch {
						// Listener failures must not block other RPC subscribers.
					}
				}
				return;
			}

			// Otherwise it's an event
			for (const listener of [...this.eventListeners]) {
				try {
					listener(data as AgentEvent);
				} catch {
					// Listener failures must not block other RPC subscribers.
				}
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private async send(command: RpcCommandBody, timeoutMs = 30000): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });

			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	/** Send a command and unwrap its response payload. */
	private async request<T>(command: RpcCommandBody, ...timeout: [] | [number]): Promise<T> {
		return this.getData<T>(await this.send(command, ...timeout));
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
