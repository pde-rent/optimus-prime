/**
 * Shared helpers for the coding-agent test suite: polling, fixture factories,
 * and harness-lifecycle tracking used across multiple test files.
 */

import { afterEach } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import type { RefinementResult } from "../../src/core/refinement/index.js";
import type { Harness } from "./harness.js";

export function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Poll an assertion until it passes or the timeout elapses, then rethrow the last error. */
export function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const tick = (): Promise<void> => {
		try {
			assertion();
			return Promise.resolve();
		} catch (error) {
			if (Date.now() > deadline) {
				return Promise.reject(error);
			}
			return delay(5).then(tick);
		}
	};
	return tick();
}

export function emptyRefinementResult(): RefinementResult {
	return {
		id: "refine_test",
		summary: "test refinement",
		rationale: "test rationale",
		expectedOutcome: "test outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness_state.json",
	};
}

export function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	} = {},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp ?? Date.now(),
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

export function agentPromptText(id: string, body: string): string {
	return `Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: ${id}\n\n${body}`;
}

export function heartbeatJob(overrides: Partial<AgentCronJob> = {}): AgentCronJob {
	return {
		id: "heartbeat-test",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-test",
		sessionId: "session-test",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "check progress",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
		...overrides,
	};
}

/** Echo tool that records executed texts when a recorder array is passed. */
export function echoTool(recorder?: string[]): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			recorder?.push(text);
			return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
		},
	};
}

/** Create the per-describe harness registry and register its afterEach cleanup. */
export function trackHarnesses(): Harness[] {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	return harnesses;
}
