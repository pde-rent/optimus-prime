import { describe, expect, it } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	Type,
} from "@earendil-works/pi-ai";
import { runAgentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

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

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createReadFileTool(seenArgs: unknown[]): AgentTool {
	const schema = Type.Object({
		path: Type.String(),
		offset: Type.Optional(Type.Number()),
		limit: Type.Optional(Type.Number()),
	});
	return {
		name: "read_file",
		label: "read_file",
		description: "Read a file",
		parameters: schema,
		execute: async (_id, params) => {
			seenArgs.push(params);
			return { content: [{ type: "text", text: "file body" }], details: {} };
		},
	};
}

async function runWithToolCall(
	toolName: string,
	args: Record<string, unknown>,
	context: AgentContext,
	config: AgentLoopConfig,
): Promise<AgentEvent[]> {
	let llmCalls = 0;
	const assistantMessage = createAssistantMessage([
		{ type: "toolCall", id: "call_1", name: toolName, arguments: args },
	]);
	const finalMessage = { ...createAssistantMessage([{ type: "text", text: "done" }]), stopReason: "stop" as const };
	const streamFn = () => {
		const stream = new MockAssistantStream();
		const isToolTurn = llmCalls === 0;
		llmCalls += 1;
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: isToolTurn ? "toolUse" : "stop",
				message: isToolTurn ? assistantMessage : finalMessage,
			});
		});
		return stream;
	};
	const events: AgentEvent[] = [];
	await runAgentLoop(
		[{ role: "user", content: "hi", timestamp: Date.now() }],
		context,
		config,
		(event) => {
			events.push(event);
		},
		new AbortController().signal,
		streamFn,
	);
	return events;
}

describe("agent loop tool aliases", () => {
	it("resolves an aliased call to the canonical tool and appends the resolver note to the result", async () => {
		const seenArgs: unknown[] = [];
		const readTool = createReadFileTool(seenArgs);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAliases: {
				resolve: (name) =>
					name === "read"
						? {
								name: "read_file",
								args: { path: "/tmp/a.txt" },
								ignoredArgs: [],
								note: 'alias "read" -> "read_file"',
							}
						: undefined,
			},
		};

		const events = await runWithToolCall("read", { path: "/tmp/a.txt" }, context, config);

		expect(seenArgs).toEqual([{ path: "/tmp/a.txt" }]);
		const executedStarts = events.flatMap((event) => (event.type === "tool_execution_start" ? [event] : []));
		expect(executedStarts.map((event) => event.toolName)).toEqual(["read"]);
		const results = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.toolName).toBe("read_file");
		const texts = results[0]?.content.filter((block) => block.type === "text") ?? [];
		expect(texts.some((block) => block.type === "text" && /alias "read" -> "read_file"/.test(block.text))).toBe(true);
	});

	it("rewrites aliased arguments before validation and execution", async () => {
		const seenArgs: unknown[] = [];
		const readTool = createReadFileTool(seenArgs);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAliases: {
				resolve: (name) =>
					name === "view"
						? {
								name: "read_file",
								args: { path: "/tmp/b.txt", offset: 3, limit: 5 },
								ignoredArgs: ["encoding"],
								note: 'alias "view"; ignored unrecognized parameters: encoding',
							}
						: undefined,
			},
		};

		const events = await runWithToolCall("view", { file_path: "/tmp/b.txt" }, context, config);

		expect(seenArgs).toEqual([{ path: "/tmp/b.txt", offset: 3, limit: 5 }]);
		const starts = events.filter((event) => event.type === "tool_execution_end");
		expect(starts).toHaveLength(1);
	});

	it("still reports not found when the alias target is not registered or the name is unknown", async () => {
		const seenArgs: unknown[] = [];
		const readTool = createReadFileTool(seenArgs);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAliases: {
				resolve: (name) => (name === "shell" ? { name: "bash", args: {}, ignoredArgs: [] } : undefined),
			},
		};

		for (const requested of ["shell", "totally_unknown"]) {
			const events = await runWithToolCall(requested, {}, context, config);
			const results = events.flatMap((event) =>
				event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
			);
			expect(results).toHaveLength(1);
			expect(results[0]?.isError).toBe(true);
			expect(results[0]?.content[0]).toMatchObject({ type: "text" });
			expect(
				results[0]?.content.some(
					(block) => block.type === "text" && block.text.includes(`Tool ${requested} not found`),
				),
			).toBe(true);
		}
		expect(seenArgs).toEqual([]);
	});
});
