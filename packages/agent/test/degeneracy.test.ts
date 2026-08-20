import { describe, expect, it } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { agentLoop } from "../src/agent-loop.js";
import { DegeneracyDetector, type DegeneracyReport } from "../src/degeneracy.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.js";

const PREFIX =
	"Right, let me work out what to change here. I need to look at the streaming path first and decide where the check belongs, then wire it up. ";

/** Feeds one block in ragged chunks, the way provider deltas arrive. */
function streamInto(text: string, seed = 7): { report?: DegeneracyReport; chars: number } {
	const detector = new DegeneracyDetector();
	let rng = seed;
	let offset = 0;
	while (offset < text.length) {
		rng = (rng * 1103515245 + 12345) & 0x7fffffff;
		const chunk = text.slice(offset, offset + 1 + (rng % 60));
		offset += chunk.length;
		const report = detector.push(0, chunk);
		if (report) {
			return { report, chars: offset };
		}
	}
	return { chars: offset };
}

function markdownTable(rows: number): string {
	const lines = ["| Setting | Type | Default | Scope | Description |", "| --- | --- | --- | --- | --- |"];
	for (let i = 0; i < rows; i++) {
		lines.push(`| option${i} | boolean | false | session | Controls whether the option${i} behaviour is enabled. |`);
	}
	return lines.join("\n");
}

function numberedList(items: number): string {
	return Array.from(
		{ length: items },
		(_, i) => `${i + 1}. Step ${i + 1}: run the migration for shard ${i + 1} and verify the checksum.`,
	).join("\n");
}

function logLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, i) =>
			`2026-08-19T18:5${i % 10}:${String(i % 60).padStart(2, "0")}Z INFO [worker-${i % 8}] request completed status=200 dur=${(i * 7) % 900}ms path=/v1/sessions/${i}`,
	).join("\n");
}

function unifiedDiff(hunks: number): string {
	const out: string[] = ["--- a/src/core/session-manager.ts", "+++ b/src/core/session-manager.ts"];
	for (let i = 0; i < hunks; i++) {
		out.push(`@@ -${i * 20 + 1},8 +${i * 20 + 1},9 @@`);
		out.push(" 	const entry = this.fileEntries[index];");
		out.push(" 	if (!entry) {");
		out.push("-		return undefined;");
		out.push(`+		return this.fallbackEntry(${i});`);
		out.push(" 	}");
		out.push(" 	this.leafId = entry.id;");
	}
	return out.join("\n");
}

function base64Blob(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	let state = 987654321;
	for (let i = 0; i < bytes; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		buffer[i] = state & 0xff;
	}
	return Buffer.from(buffer).toString("base64");
}

function minifiedJs(statements: number): string {
	let out = "";
	for (let i = 0; i < statements; i++) {
		out += `function f${i}(a,b){var c=a.x[${i}]||b.y;if(!c){return{ok:!1,e:"f${i}"}}return{ok:!0,v:c.z+${i}}}`;
	}
	return out;
}

describe("DegeneracyDetector", () => {
	it("catches the drifting near-repeat that a real collapse produces", () => {
		const collapse =
			"the current state of the code and the current state of the type of the code that has been. " +
			"The main thing is to write the code and the current state of the same and the current state of the type " +
			"and the current state of the actual code and the current state of the actual state of the world is the one that ";
		const { report, chars } = streamInto(PREFIX + collapse.repeat(30));

		expect(report?.kind).toBe("repetition");
		expect(chars - PREFIX.length).toBeLessThan(2000);
	});

	it("catches a verbatim sentence loop", () => {
		const { report, chars } = streamInto(`${PREFIX}${"I'm not going to be honest with you and ".repeat(200)}`);

		expect(report?.kind).toBe("loop");
		expect(report?.detail).toContain("verbatim repeats");
		expect(chars - PREFIX.length).toBeLessThan(1000);
	});

	it("catches a loop made of function words", () => {
		expect(streamInto(`${PREFIX}${"and then it will be. ".repeat(300)}`).report?.kind).toBe("loop");
		expect(streamInto(`${PREFIX}${"the ".repeat(400)}`).report).toBeDefined();
	});

	// A run of one letter is padding, a test fixture, a redacted value or a progress bar. It once
	// tripped the loop rule, which aborted a real turn whose filler was `"x".repeat(3_500)`.
	it.each([
		["a long run of one letter", "x".repeat(3500)],
		["a long run of one syllable", "ha".repeat(1000)],
		["a rule of equals signs", "=".repeat(200)],
		["a progress bar", `Downloading [${"#".repeat(80)}] 100%`],
		["a run of one letter surrounded by prose", `${PREFIX.repeat(3)}${"x".repeat(900)} and that was the value.`],
		["a redacted secret", `${PREFIX}Authorization: Bearer ${"*".repeat(1200)} (redacted)`],
		["ASCII art on one line", "/\\_".repeat(600)],
		["an ASCII art box", Array.from({ length: 40 }, () => `|${"/\\".repeat(38)}|`).join("\n")],
		["dot leaders", `${PREFIX}Contents${".".repeat(1000)}42`],
		["a horizontal rule", `${PREFIX}\n${"-".repeat(2000)}`],
		["zero padding", "0".repeat(2000)],
	])("does not trip on %s", (_label, text) => {
		expect(streamInto(text).report).toBeUndefined();
	});

	it("reports the same collapse regardless of how deltas are chopped up", () => {
		const text = `${PREFIX}${"the same thing over and over. ".repeat(200)}`;
		for (const seed of [7, 31, 991]) {
			expect(streamInto(text, seed).report).toBeDefined();
		}
	});

	it.each([
		["a large markdown table", markdownTable(140)],
		["a long numbered list", numberedList(160)],
		["a file of similar log lines", logLines(300)],
		["a long unified diff", unifiedDiff(120)],
		["base64 on one line", base64Blob(24_000)],
		["base64 wrapped at 76 columns", (base64Blob(24_000).match(/.{1,76}/g) ?? []).join("\n")],
		["minified javascript", minifiedJs(400)],
		[
			"repeated identical lines",
			`${"    at Object.<anonymous> (/repo/src/core/session-manager.ts:3585:12)\n".repeat(140)}`,
		],
	])("does not trip on %s", (_label, text) => {
		expect(streamInto(text).report).toBeUndefined();
	});

	it("does not trip on ordinary prose", () => {
		const prose =
			"The session manager appends each entry to an in-memory list and then flushes it to disk. " +
			"Persistence is deliberately lazy so that a session which never reaches the model leaves nothing behind. " +
			"When a turn is aborted the partial message is still recorded, because the transcript should show what ran. " +
			"Providers drop those messages again before the next request, so the model never replays an incomplete turn. ";
		expect(streamInto(prose.repeat(3)).report).toBeUndefined();
	});

	it("keeps content blocks apart so a repeat needs one block to itself", () => {
		const detector = new DegeneracyDetector();
		const unit = "I'm not going to be honest with you and ";
		let tripped: DegeneracyReport | undefined;
		for (let i = 0; i < 40; i++) {
			tripped ??= detector.push(i % 2, unit);
		}
		expect(tripped).toBeUndefined();
	});

	it("stays quiet once it has reported, so a turn trips exactly once", () => {
		const detector = new DegeneracyDetector();
		const unit = "I'm not going to be honest with you and ";
		const reports: DegeneracyReport[] = [];
		for (let i = 0; i < 200; i++) {
			const report = detector.push(0, unit);
			if (report) {
				reports.push(report);
			}
		}
		expect(reports).toHaveLength(1);
	});
});

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
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Emits `deltas` of `kind`, then a clean `done` the guard is expected to pre-empt. */
function degenerateStreamFn(kind: "thinking" | "text" | "toolcall", unit: string, repeats: number) {
	const seen: { signal?: AbortSignal } = {};
	const streamFn = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
		seen.signal = options?.signal;
		const stream = new MockAssistantStream();
		const partial = (): AssistantMessage => ({
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "mock",
			usage: createUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
		queueMicrotask(() => {
			stream.push({ type: "start", partial: partial() });
			stream.push({ type: `${kind}_start`, contentIndex: 0, partial: partial() } as AssistantMessageEvent);
			for (let i = 0; i < repeats; i++) {
				stream.push({
					type: `${kind}_delta`,
					contentIndex: 0,
					delta: unit,
					partial: partial(),
				} as AssistantMessageEvent);
			}
			const finished: AssistantMessage = {
				...partial(),
				content: [{ type: "text", text: unit.repeat(repeats) }],
			};
			stream.push({ type: "done", reason: "stop", message: finished });
		});
		return stream;
	};
	return { streamFn, seen };
}

async function runTurn(config: Partial<AgentLoopConfig>, streamFn: unknown): Promise<AgentMessage[]> {
	const context: AgentContext = { systemPrompt: "You are helpful.", messages: [], tools: [] };
	const stream = agentLoop(
		[createUserMessage("Hello")],
		context,
		{ model: createModel(), convertToLlm: identityConverter, ...config },
		undefined,
		streamFn as never,
	);
	for await (const _event of stream) {
	}
	return stream.result();
}

describe("agent loop degeneracy guard", () => {
	it("aborts the turn and keeps no degenerate content", async () => {
		const { streamFn, seen } = degenerateStreamFn("thinking", "I'm not going to be honest with you and ", 60);
		const messages = await runTurn({}, streamFn);

		const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
		expect(assistant.stopReason).toBe("aborted");
		expect(assistant.content).toEqual([]);
		expect(assistant.errorMessage).toContain("repetition loop");
		expect(assistant.errorMessage).toContain("aborted");
		expect(seen.signal?.aborted).toBe(true);
	});

	it("guards streamed text as well as reasoning", async () => {
		const { streamFn } = degenerateStreamFn("text", "the same thing over and over and ", 60);
		const messages = await runTurn({}, streamFn);

		const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
		expect(assistant.stopReason).toBe("aborted");
		expect(assistant.content).toEqual([]);
	});

	it("never judges tool-call arguments", async () => {
		const { streamFn, seen } = degenerateStreamFn("toolcall", '{"path":"a.ts","old":"x","new":"x"},', 200);
		const messages = await runTurn({}, streamFn);

		const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
		expect(assistant.stopReason).toBe("stop");
		expect(seen.signal?.aborted).toBe(false);
	});

	it("streams to completion when the guard is turned off", async () => {
		const { streamFn, seen } = degenerateStreamFn("thinking", "I'm not going to be honest with you and ", 60);
		const messages = await runTurn({ degeneracyGuard: false }, streamFn);

		const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.content).not.toEqual([]);
		expect(seen.signal?.aborted).toBeUndefined();
	});

	it("leaves a healthy turn alone", async () => {
		const { streamFn } = degenerateStreamFn(
			"thinking",
			"Checking the session manager and the provider transform. ",
			6,
		);
		const messages = await runTurn({}, streamFn);

		const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.errorMessage).toBeUndefined();
	});
});
