/**
 * Cross-turn reasoning-loop guard.
 *
 * Where DegeneracyDetector catches a model collapsing mid-stream into verbatim repetition,
 * this guard catches the quieter failure: an assistant that keeps producing fluent, novel-looking
 * planning across turns without ever acting. Two independent triggers, both cheap (no embeddings,
 * no model calls — approximate token counting and 3-5gram Jaccard similarity only):
 *
 * - reasoning: more than ~1200 approximate reasoning tokens since the last tool action, no tool
 *   call in the current turn, and consecutive reasoning chunks whose 3-5gram sets overlap by
 *   more than 0.8 Jaccard. Similar phrasing, not identical phrases: the loop may paraphrase.
 * - progress: two consecutive turns with no observable progress (no tool calls, no new
 *   observation bytes).
 *
 * A trigger advances a three-step recovery ladder, once per run: steer with a force-action
 * message; on the immediate next trigger abort the generation and deliver a clean continuation;
 * if that also degenerates, stop the run with reason "reasoning_loop". Aborting the generation
 * is not killing the task: the run continues unless the ladder reaches its final step.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "./types.js";

/** Approximate reasoning tokens tolerated since the last action before similarity is judged. */
const REASONING_TOKEN_LIMIT = 1200;
/** Chars per approximate token. Deliberately crude: exact tokenization needs a tokenizer. */
const CHARS_PER_TOKEN = 4;
/** Jaccard overlap of consecutive chunk n-gram sets above which reasoning is judged looping. */
const SIMILARITY_THRESHOLD = 0.8;
/** Consecutive no-progress turns before the progress trigger fires. */
const NO_PROGRESS_TURN_LIMIT = 2;
/** Words per compared reasoning chunk (~a paragraph). */
const CHUNK_WORDS = 120;
const NGRAM_MIN = 3;
const NGRAM_MAX = 5;
/** Chars of thinking accumulated between similarity checks. Keeps streaming cost O(delta). */
const CHECK_EVERY_CHARS = 256;

const WORD_RE = /[\p{L}\p{N}']+/gu;

export const REASONING_LOOP_STEERING_MESSAGE =
	"You are repeating planning without taking an action. Do not restate the plan. Either (1) invoke the repl tool now with the next concrete operation, or (2) state the precise blocker and stop.";

export const REASONING_LOOP_CONTINUATION_MESSAGE =
	"Your previous response was stopped because it repeated planning without acting. Do not restate earlier planning. State the next concrete repl operation and invoke the repl tool with it now.";

/** Message recorded on a turn the guard stopped at the final ladder step. */
export function reasoningLoopStopErrorMessage(): string {
	return (
		"Run stopped: the model kept planning without acting after steering and a forced continuation " +
		"(reason: reasoning_loop). Start a new run with a concrete first action."
	);
}

export type ReasoningLoopDecision =
	| { kind: "steer"; message: AgentMessage }
	| { kind: "abort_and_continue"; message: AgentMessage }
	| { kind: "stop"; reason: "reasoning_loop" };

/** What one assistant turn observably did. All counters are heuristic and cheap to derive. */
export interface TurnProgress {
	toolCalls: number;
	replExecutions: number;
	filesChanged: number;
	commandsExecuted: number;
	newObservationBytes: number;
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function ngramSet(words: string[]): Set<string> {
	const set = new Set<string>();
	for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
		for (let i = 0; i + n <= words.length; i++) {
			set.add(words.slice(i, i + n).join(" "));
		}
	}
	return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) {
		return 1;
	}
	let intersection = 0;
	for (const gram of a) {
		if (b.has(gram)) {
			intersection++;
		}
	}
	return intersection / (a.size + b.size - intersection);
}

/**
 * Derives per-turn progress from the finished assistant message and its tool results.
 * Tool-name matching is deliberately broad: the guard only needs "did anything happen",
 * not a precise audit of what kind of thing happened.
 */
export function extractTurnProgress(message: AgentMessage, toolResults: ToolResultMessage[]): TurnProgress {
	const progress: TurnProgress = {
		toolCalls: 0,
		replExecutions: 0,
		filesChanged: 0,
		commandsExecuted: 0,
		newObservationBytes: 0,
	};
	if (message.role !== "assistant") {
		return progress;
	}
	for (const block of message.content) {
		if (block.type !== "toolCall") {
			continue;
		}
		progress.toolCalls++;
		const name = block.name.toLowerCase();
		if (name === "repl") {
			progress.replExecutions++;
		}
		if (/bash|exec|run|shell/.test(name)) {
			progress.commandsExecuted++;
		}
		if (/edit|write|patch|apply|create/.test(name)) {
			progress.filesChanged++;
		}
	}
	for (const result of toolResults) {
		for (const block of result.content) {
			if (block.type === "text") {
				progress.newObservationBytes += block.text.length;
			}
		}
	}
	return progress;
}

export class ReasoningLoopGuard {
	/** 0 = armed, 1 = steered, 2 = continuation delivered. The ladder never rearms. */
	private phase = 0;
	private sawToolCall = false;
	private reasoningChars = 0;
	private charsSinceCheck = 0;
	private carry = "";
	private words: string[] = [];
	private chunkSets: Set<string>[] = [];
	private noProgressTurns = 0;

	/** Marks the start of a streamed response; per-turn state, not the since-action accumulator. */
	beginTurn(): void {
		this.sawToolCall = false;
	}

	noteToolCallSeen(): void {
		this.sawToolCall = true;
	}

	/**
	 * Feeds one thinking delta. Returns true when the reasoning trigger fires; internally gated
	 * so the similarity check runs at most once every CHECK_EVERY_CHARS.
	 */
	observeThinking(delta: string): boolean {
		if (this.sawToolCall || delta.length === 0) {
			return false;
		}
		this.reasoningChars += delta.length;
		this.charsSinceCheck += delta.length;
		this.ingestWords(delta);
		if (this.charsSinceCheck < CHECK_EVERY_CHARS) {
			return false;
		}
		this.charsSinceCheck = 0;
		return this.isLooping();
	}

	private ingestWords(text: string): void {
		const buffer = this.carry + text;
		let trailing = "";
		WORD_RE.lastIndex = 0;
		let match = WORD_RE.exec(buffer);
		while (match) {
			if (match.index + match[0].length === buffer.length) {
				trailing = match[0];
				break;
			}
			this.words.push(match[0].toLowerCase());
			match = WORD_RE.exec(buffer);
		}
		this.carry = trailing;
		while (this.words.length >= CHUNK_WORDS) {
			const chunk = this.words.splice(0, CHUNK_WORDS);
			this.chunkSets.push(ngramSet(chunk));
			if (this.chunkSets.length > 2) {
				this.chunkSets.shift();
			}
		}
	}

	private isLooping(): boolean {
		if (Math.ceil(this.reasoningChars / CHARS_PER_TOKEN) <= REASONING_TOKEN_LIMIT) {
			return false;
		}
		const previous = this.chunkSets[this.chunkSets.length - 2];
		const current = this.chunkSets[this.chunkSets.length - 1];
		if (!previous || !current) {
			return false;
		}
		return jaccard(previous, current) > SIMILARITY_THRESHOLD;
	}

	/**
	 * Settles one finished turn. Returns true when the progress trigger fires: the turn made no
	 * observable progress and the streak reached the limit. Any progress resets the streak and
	 * the since-action reasoning accumulator.
	 */
	finishTurn(progress: TurnProgress): boolean {
		if (
			progress.toolCalls > 0 ||
			progress.replExecutions > 0 ||
			progress.filesChanged > 0 ||
			progress.commandsExecuted > 0 ||
			progress.newObservationBytes > 0
		) {
			this.noProgressTurns = 0;
			this.reasoningChars = 0;
			this.charsSinceCheck = 0;
			this.words = [];
			this.carry = "";
			this.chunkSets = [];
			return false;
		}
		this.noProgressTurns++;
		return this.noProgressTurns >= NO_PROGRESS_TURN_LIMIT;
	}

	/** Advances the recovery ladder. Max one recovery per run: steer, then abort+continue, then stop. */
	trigger(): ReasoningLoopDecision {
		if (this.phase === 0) {
			this.phase = 1;
			return { kind: "steer", message: userMessage(REASONING_LOOP_STEERING_MESSAGE) };
		}
		if (this.phase === 1) {
			this.phase = 2;
			return { kind: "abort_and_continue", message: userMessage(REASONING_LOOP_CONTINUATION_MESSAGE) };
		}
		return { kind: "stop", reason: "reasoning_loop" };
	}
}
