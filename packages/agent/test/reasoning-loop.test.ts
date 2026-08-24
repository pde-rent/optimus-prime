import { describe, expect, it } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { agentLoop } from "../src/agent-loop.js";
import {
	extractTurnProgress,
	REASONING_LOOP_CONTINUATION_MESSAGE,
	REASONING_LOOP_STEERING_MESSAGE,
	type ReasoningLoopDecision,
	ReasoningLoopGuard,
	reasoningLoopStopErrorMessage,
} from "../src/reasoning-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createPartial(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Pathological CoT: near-identical planning sentences paraphrased slightly, zero tool calls. */
function loopingThinking(words = 1500): string {
	const sentence =
		"Let me think about the best way to approach this problem before acting. Actually, wait, maybe I should reconsider the plan once more. ";
	const parts: string[] = [];
	let count = 0;
	while (count < words) {
		parts.push(sentence);
		count += sentence.split(" ").length - 1;
	}
	return parts.join("");
}

/** Healthy CoT: every paragraph moves to a genuinely different topic. */
function healthyParagraph(index: number): string {
	const topics = [
		"The config loader reads defaults first, then overrides them from the project file. ",
		"Next I need to check how the cache key is derived from the request parameters. ",
		"The retry policy uses exponential backoff with a hard ceiling on total attempts. ",
		"Auth tokens refresh silently unless the refresh endpoint itself returns an error. ",
		"Finally the report writer formats rows and writes them to the output directory. ",
	];
	return topics[index % topics.length].repeat(30);
}

function emptyProgress() {
	return { toolCalls: 0, replExecutions: 0, filesChanged: 0, commandsExecuted: 0, newObservationBytes: 0 };
}

function decisionText(message: AgentMessage): string {
	if (message.role !== "user") {
		throw new Error(`expected user message, got role ${message.role}`);
	}
	const block = typeof message.content === "string" ? undefined : message.content[0];
	if (!block || block.type !== "text") {
		throw new Error("expected leading text block");
	}
	return block.text;
}

describe("ReasoningLoopGuard", () => {
	it("fires on a pathological CoT fixture (~3k tokens of near-duplicate planning)", () => {
		const guard = new ReasoningLoopGuard();
		guard.beginTurn();
		const text = loopingThinking();
		expect(Math.ceil(text.length / 4)).toBeGreaterThan(1200);
		let fired = false;
		for (let offset = 0; offset < text.length && !fired; offset += 200) {
			fired = guard.observeThinking(text.slice(offset, offset + 200));
		}
		expect(fired).toBe(true);
	});

	it("does not fire on a healthy alternating trace with real progress", () => {
		const guard = new ReasoningLoopGuard();
		for (let turn = 0; turn < 6; turn++) {
			guard.beginTurn();
			const paragraph = healthyParagraph(turn);
			for (let offset = 0; offset < paragraph.length; offset += 200) {
				expect(guard.observeThinking(paragraph.slice(offset, offset + 200))).toBe(false);
			}
			guard.noteToolCallSeen();
			expect(guard.finishTurn({ ...emptyProgress(), toolCalls: 1, newObservationBytes: 500 })).toBe(false);
		}
	});

	it("fires the progress trigger only after two consecutive no-progress turns", () => {
		const guard = new ReasoningLoopGuard();
		guard.beginTurn();
		expect(guard.finishTurn(emptyProgress())).toBe(false);
		guard.beginTurn();
		expect(guard.finishTurn(emptyProgress())).toBe(true);
		// Any observable progress resets the streak.
		expect(guard.finishTurn({ ...emptyProgress(), replExecutions: 1 })).toBe(false);
	});

	it("advances the recovery ladder exactly once per run: steer, abort+continue, stop", () => {
		const guard = new ReasoningLoopGuard();
		const decisions: ReasoningLoopDecision[] = [guard.trigger(), guard.trigger(), guard.trigger()];
		expect(decisions[0].kind).toBe("steer");
		expect(decisions[1].kind).toBe("abort_and_continue");
		expect(decisions[2]).toEqual({ kind: "stop", reason: "reasoning_loop" });
		if (decisions[0].kind !== "steer" || decisions[1].kind !== "abort_and_continue") {
			throw new Error("unexpected decision kinds");
		}
		const firstText = decisionText(decisions[0].message);
		const secondText = decisionText(decisions[1].message);
		expect(firstText).toBe(REASONING_LOOP_STEERING_MESSAGE);
		expect(secondText).toBe(REASONING_LOOP_CONTINUATION_MESSAGE);
	});
});

describe("extractTurnProgress", () => {
	it("counts tool calls and observation bytes from a finished turn", () => {
		const message = createPartial();
		message.content = [
			{ type: "toolCall", id: "t1", name: "repl", arguments: {} },
			{ type: "text", text: "done" },
		] as AssistantMessage["content"];
		const results: ToolResultMessage[] = [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "repl",
				content: [{ type: "text", text: "some observation output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const progress = extractTurnProgress(message, results);
		expect(progress.toolCalls).toBe(1);
		expect(progress.replExecutions).toBe(1);
		expect(progress.newObservationBytes).toBeGreaterThan(0);
	});
});

describe("agentLoop reasoning-loop recovery", () => {
	function loopingStreamFactory() {
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			const stream = new MockAssistantStream();
			const partial = createPartial();
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				const text = loopingThinking();
				for (let offset = 0; offset < text.length; offset += 200) {
					stream.push({
						type: "thinking_delta",
						contentIndex: 0,
						delta: text.slice(offset, offset + 200),
						partial,
					});
				}
			});
			return stream;
		};
		return { streamFn, getCalls: () => calls };
	}

	function baseConfig(): AgentLoopConfig {
		return {
			model: createModel(),
			convertToLlm: identityConverter,
			// The degeneracy detector fires first on the repetitive fixture and stops the
			// run outright; this suite exercises the reasoning-loop ladder specifically.
			degeneracyGuard: false,
		};
	}

	async function collect(config: AgentLoopConfig, context: AgentContext, streamFn: StreamFn) {
		const stream = agentLoop([createUserMessage("do the task")], context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();
		return { events, messages };
	}

	it("steers, then aborts with a continuation, then stops with reason reasoning_loop", async () => {
		const { streamFn, getCalls } = loopingStreamFactory();
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const { events, messages } = await collect(baseConfig(), context, streamFn);

		expect(getCalls()).toBe(3);
		const texts = messages
			.filter((m) => m.role === "user")
			.map((m) => (Array.isArray(m.content) ? m.content.map((c) => ("text" in c ? c.text : "")).join("") : ""));
		expect(texts).toContain(REASONING_LOOP_STEERING_MESSAGE);
		expect(texts).toContain(REASONING_LOOP_CONTINUATION_MESSAGE);
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as AssistantMessage;
		expect(lastAssistant.stopReason).toBe("aborted");
		expect(lastAssistant.errorMessage).toContain("reasoning_loop");
		expect(reasoningLoopStopErrorMessage()).toContain("reasoning_loop");
		expect(events.some((e) => e.type === "agent_end")).toBe(true);
	});

	it("does not fire on a healthy single-turn response", async () => {
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			const stream = new MockAssistantStream();
			const partial = createPartial();
			const finalMessage = createPartial();
			finalMessage.content = [{ type: "text", text: "All done." }];
			finalMessage.stopReason = "stop";
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				stream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: healthyParagraph(0).slice(0, 400),
					partial,
				});
				stream.push({ type: "done", reason: "stop", message: finalMessage });
			});
			return stream;
		};
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const { messages } = await collect(baseConfig(), context, streamFn);
		expect(calls).toBe(1);
		const assistants = messages.filter((m) => m.role === "assistant") as AssistantMessage[];
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.stopReason).toBe("stop");
	});
});
