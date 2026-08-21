import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";

const tempDirs: string[] = [];

/** Creates a unique temp directory registered for cleanupTempDirs(). */
export function makeTempDir(prefix = "optimus-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Removes every directory created by makeTempDir(). Wire into afterEach/afterAll. */
export function cleanupTempDirs(): void {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
}

export function zeroUsage(outputTokens = 0): Usage {
	return {
		input: 0,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type AssistantMessageOptions = {
	text?: string;
	thinking?: string;
	content?: AssistantMessage["content"];
	api?: AssistantMessage["api"];
	provider?: string;
	model?: string;
	usage?: Usage;
	outputTokens?: number;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	timestamp?: number;
};

/** Builds an AssistantMessage fixture; defaults to empty text content and zero usage. */
export function createAssistantMessage(textOrOptions: string | AssistantMessageOptions = {}): AssistantMessage {
	const options: AssistantMessageOptions = typeof textOrOptions === "string" ? { text: textOrOptions } : textOrOptions;
	const content: AssistantMessage["content"] = options.content
		? options.content
		: [
				...(options.thinking ? [{ type: "thinking" as const, thinking: options.thinking }] : []),
				...(options.text ? [{ type: "text" as const, text: options.text }] : []),
			];
	return {
		role: "assistant",
		content,
		api: options.api ?? "anthropic-messages",
		provider: options.provider ?? "anthropic",
		model: options.model ?? "test-model",
		usage: options.usage ?? zeroUsage(options.outputTokens ?? 0),
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: options.timestamp ?? Date.now(),
	};
}

/** Builds a UserMessage fixture with string content. */
export function createUserMessage(text: string, timestamp = Date.now()): UserMessage {
	return { role: "user", content: text, timestamp };
}
