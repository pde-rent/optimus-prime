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
import { extractToolCallsFromText } from "../src/content-tool-calls.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

describe("extractToolCallsFromText", () => {
	it("extracts a fenced json block with flat name/arguments", () => {
		const text = 'Let me check.\n\n```json\n{"name": "read_file", "arguments": {"path": "/tmp/a.txt"}}\n```';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "read_file", arguments: { path: "/tmp/a.txt" } }]);
	});

	it("accepts tool_name and params keys and stringified arguments", () => {
		const text = '```json\n{"tool_name": "bash", "params": "{\\"command\\": \\"ls\\"}"}\n```';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "bash", arguments: { command: "ls" } }]);
	});

	it("accepts tool and args keys in a js fence", () => {
		const text = '```js\n{"tool": "grep", "args": {"pattern": "foo"}}\n```';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "grep", arguments: { pattern: "foo" } }]);
	});

	it("extracts the OpenAI-shaped function form with stringified arguments", () => {
		const text = '```json\n{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"/tmp/b.txt\\"}"}}\n```';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "read_file", arguments: { path: "/tmp/b.txt" } }]);
	});

	it("extracts arrays of calls from one block", () => {
		const text =
			'```json\n[{"name": "a", "arguments": {}}, {"name": "b", "parameters": {"x": 1}}, {"broken": true}]\n```';
		expect(extractToolCallsFromText(text)).toEqual([
			{ name: "a", arguments: {} },
			{ name: "b", arguments: { x: 1 } },
		]);
	});

	it("extracts Qwen-style tool_call tags", () => {
		const text = '<tool_call>\n{"name": "weather", "arguments": {"city": "Oslo"}}\n</tool_call>';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "weather", arguments: { city: "Oslo" } }]);
	});

	it("extracts multiple Qwen-style tags including array payloads", () => {
		const text =
			'<tool_call>{"name": "a", "arguments": {"i": 1}}</tool_call>\ntext between\n<tool_call>[{"name": "b", "args": {}}, {"name": "c", "params": {}}]</tool_call>';
		expect(extractToolCallsFromText(text)).toEqual([
			{ name: "a", arguments: { i: 1 } },
			{ name: "b", arguments: {} },
			{ name: "c", arguments: {} },
		]);
	});

	it("extracts Mistral-style TOOL_CALLS prefixes with trailing prose", () => {
		const text = '[TOOL_CALLS][{"name": "weather", "arguments": {"city": "Rome"}}] Hope that helps!';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "weather", arguments: { city: "Rome" } }]);
	});

	it("extracts a single object after a Mistral-style prefix", () => {
		const text = '[TOOL_CALLS] {"name": "bash", "arguments": {"command": "pwd"}}';
		expect(extractToolCallsFromText(text)).toEqual([{ name: "bash", arguments: { command: "pwd" } }]);
	});

	it("ignores fences without a json/js language label", () => {
		const text = '```\n{"name": "read_file", "arguments": {"path": "/tmp/a.txt"}}\n```';
		expect(extractToolCallsFromText(text)).toEqual([]);
	});

	it("returns nothing for ordinary code samples and prose", () => {
		const prose = [
			"To call a tool, write ```json with a name field.",
			'```ts\nfunction greet(): string {\n\treturn "hi";\n}\n```',
			'Here is an example config:\n```json\n{"host": "localhost", "port": 8080}\n```',
			"I should read the file now.",
		].join("\n");
		expect(extractToolCallsFromText(prose)).toEqual([]);
	});

	it("returns nothing for malformed json", () => {
		const text = '```json\n{"name": "read_file", "arguments": {"path": }}\n```';
		expect(extractToolCallsFromText(text)).toEqual([]);
	});

	it("drops candidates failing validation", () => {
		const cases = [
			'```json\n{"name": "", "arguments": {}}\n```',
			'```json\n{"name": 42, "arguments": {}}\n```',
			'```json\n{"name": "no_args"}\n```',
			'```json\n{"name": "arr_args", "arguments": [1, 2]}\n```',
			'```json\n{"name": "bad_str_args", "arguments": "{not json}"}\n```',
			'```json\n{"function": {"name": "f"}, "arguments": {}}\n```',
			'```json\n{"function": {"name": "f", "arguments": "[]"}}\n```',
		];
		for (const text of cases) {
			expect(extractToolCallsFromText(text)).toEqual([]);
		}
	});

	it("honors per-dialect switches", () => {
		const text = '[TOOL_CALLS][{"name": "a", "arguments": {}}]';
		expect(extractToolCallsFromText(text, { dialects: { toolCallsPrefix: false } })).toEqual([]);
		expect(
			extractToolCallsFromText('<tool_call>{"name": "a", "arguments": {}}</tool_call>', {
				dialects: { toolCallTags: false },
			}),
		).toEqual([]);
	});
});

// Loop-level coverage follows the agent-loop-tool-aliases patterns.

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
		stopReason: "stop",
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

async function runWithDegradedTurns(
	turns: AssistantMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
): Promise<AgentEvent[]> {
	let llmCalls = 0;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		const index = Math.min(llmCalls, turns.length - 1);
		llmCalls += 1;
		queueMicrotask(() => {
			stream.push({ type: "done", reason: (turns[index]?.stopReason ?? "stop") as "stop", message: turns[index]! });
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

describe("agent loop plain-text tool call recovery", () => {
	it("executes a fenced call emitted as text through the normal tool path and notes the recovery", async () => {
		const seenArgs: unknown[] = [];
		const readTool = createReadFileTool(seenArgs);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readTool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const degradedTurn = createAssistantMessage([
			{
				type: "text",
				text: 'I will read the file.\n\n```json\n{"name": "read_file", "arguments": {"path": "/tmp/a.txt"}}\n```',
			},
		]);
		const finalTurn = createAssistantMessage([{ type: "text", text: "done" }]);
		const events = await runWithDegradedTurns([degradedTurn, finalTurn], context, config);

		expect(seenArgs).toEqual([{ path: "/tmp/a.txt" }]);

		const assistantEnds = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant" ? [event.message] : [],
		);
		const recoveredCall = assistantEnds[0]?.content.find((part) => part.type === "toolCall");
		expect(recoveredCall).toMatchObject({ type: "toolCall", name: "read_file", arguments: { path: "/tmp/a.txt" } });

		const results = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.toolName).toBe("read_file");
		expect(
			results[0]?.content.some((block) => block.type === "text" && /recovered from plain-text/.test(block.text)),
		).toBe(true);

		const executions = events.filter((event) => event.type === "tool_execution_end");
		expect(executions).toHaveLength(1);
	});

	it("skips recovery when disabled via recoverTextToolCalls: false", async () => {
		const seenArgs: unknown[] = [];
		const readTool = createReadFileTool(seenArgs);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			recoverTextToolCalls: false,
		};

		const degradedTurn = createAssistantMessage([
			{
				type: "text",
				text: '```json\n{"name": "read_file", "arguments": {"path": "/tmp/a.txt"}}\n```',
			},
		]);
		const events = await runWithDegradedTurns([degradedTurn], context, config);

		expect(seenArgs).toEqual([]);
		const results = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(results).toHaveLength(0);
	});
});
