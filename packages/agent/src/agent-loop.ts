/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { DegeneracyDetector, type DegeneracyReport, degeneracyErrorMessage } from "./degeneracy.js";
import {
	extractTurnProgress,
	type ReasoningLoopDecision,
	ReasoningLoopGuard,
	reasoningLoopStopErrorMessage,
} from "./reasoning-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
	ToolAliasResolution,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const ABORT_ERROR_MESSAGE = "Request was aborted";
const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAbortError(): Error {
	return new Error(ABORT_ERROR_MESSAGE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return operation;
	}
	if (signal.aborted) {
		onAbort?.();
		void operation.catch(() => undefined);
		return Promise.reject(createAbortError());
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function maybePromiseWithAbort<T>(
	operation: T | Promise<T>,
	signal: AbortSignal | undefined,
	onAbort?: () => void,
): Promise<T> {
	return raceWithAbort(Promise.resolve(operation), signal, onAbort);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.message === ABORT_ERROR_MESSAGE || error.name === "AbortError");
}

type PostTurnResult<T> = { status: "completed"; value: T } | { status: "aborted" };

async function settlePostTurn<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<PostTurnResult<T>> {
	try {
		return { status: "completed", value: await operation };
	} catch (error) {
		if (signal?.aborted && isAbortError(error)) {
			return { status: "aborted" };
		}
		throw error;
	}
}

function cloneAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.map((part) => {
		if (part.type === "toolCall") {
			return { ...part, arguments: { ...part.arguments } };
		}
		return { ...part };
	});
}

function cloneUsage(usage: AssistantMessage["usage"]): AssistantMessage["usage"] {
	return { ...usage, cost: { ...usage.cost } };
}

/**
 * Terminal message for a turn the loop itself stopped (user abort or
 * degeneracy guard). "aborted" and not "error": this is a stopped turn, not a
 * provider failure, and the aborted path already drops the message from
 * replayed context and skips auto-retry.
 */
function createStoppedAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	content: AssistantMessage["content"],
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: partialMessage?.api ?? config.model.api,
		provider: partialMessage?.provider ?? config.model.provider,
		model: partialMessage?.model ?? config.model.id,
		usage: cloneUsage(partialMessage?.usage ?? EMPTY_USAGE),
		stopReason: "aborted",
		errorMessage,
		timestamp: Date.now(),
	};
}

function createAbortedAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
): AssistantMessage {
	return createStoppedAssistantMessage(
		config,
		partialMessage,
		partialMessage ? cloneAssistantContent(partialMessage.content) : [{ type: "text", text: "" }],
		ABORT_ERROR_MESSAGE,
	);
}

function createDegenerateAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	report: DegeneracyReport,
): AssistantMessage {
	// The looped text is the payload of the bug: persisting it would make it permanent context
	// for every later turn and can re-trigger the collapse, so the turn keeps no content.
	return createStoppedAssistantMessage(config, partialMessage, [], degeneracyErrorMessage(report));
}

function getTerminalMessage(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): AssistantMessage {
	return event.type === "done" ? event.message : event.error;
}

/**
 * Place a finalized assistant message in the context (replacing the streamed
 * partial or appending it) and emit its start/end events.
 */
async function commitAssistantMessage(
	context: AgentContext,
	emit: AgentEventSink,
	finalMessage: AssistantMessage,
	addedPartial: boolean,
): Promise<AssistantMessage> {
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

function endAgentStreamOnError(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	promise: Promise<AgentMessage[]>,
): void {
	void promise.then(
		(messages) => {
			stream.end(messages);
		},
		() => {
			stream.end([]);
		},
	);
}

async function pollMessagesUnlessAborted(
	poll: (() => AgentMessage[] | Promise<AgentMessage[]>) | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentMessage[]> {
	if (!poll || signal?.aborted) {
		return [];
	}
	return (await maybePromiseWithAbort(poll(), signal)) || [];
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	endAgentStreamOnError(
		stream,
		runAgentLoop(
			prompts,
			context,
			config,
			async (event) => {
				stream.push(event);
			},
			signal,
			streamFn,
		),
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
function assertContinuable(context: AgentContext): void {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
}

export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	assertContinuable(context);

	const stream = createAgentStream();

	endAgentStreamOnError(
		stream,
		runAgentLoopContinue(
			context,
			config,
			async (event) => {
				stream.push(event);
			},
			signal,
			streamFn,
		),
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	assertContinuable(context);

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let lastTurn: Parameters<NonNullable<AgentLoopConfig["getContinuationMessages"]>>[0] | undefined;
	let pendingMessages: AgentMessage[] = await pollMessagesUnlessAborted(config.getSteeringMessages, signal);

	const shouldStopBeforeTurn = (): boolean => !firstTurn && (config.shouldStopBeforeTurn?.() ?? false);

	const endLoop = async (): Promise<void> => {
		await emit({ type: "agent_end", messages: newMessages });
	};

	/**
	 * Await a post-turn poll; on abort, emit `agent_end` and return `undefined`
	 * so the caller can unwind with a single `if`.
	 */
	const settleOrEnd = async <T>(operation: Promise<T>): Promise<T | undefined> => {
		const result = await settlePostTurn(operation, signal);
		if (result.status === "aborted") {
			await endLoop();
			return undefined;
		}
		return result.value;
	};
	// Cross-turn reasoning-loop guard: catches fluent planning that never acts. One ladder per run.
	const loopGuard = config.reasoningLoopGuard === false ? undefined : new ReasoningLoopGuard();

	while (true) {
		throwIfAborted(signal);
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			throwIfAborted(signal);
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			loopGuard?.beginTurn();
			const streamed = await streamAssistantResponse(currentContext, config, signal, emit, streamFn, loopGuard);
			const message = streamed.message;
			newMessages.push(message);

			if (streamed.reasoningLoop && streamed.reasoningLoop.kind !== "stop") {
				// The looping generation was aborted mid-stream. The recovery ladder continues:
				// the steering or continuation message opens the next turn instead of ending the run.
				await emit({ type: "turn_end", message, toolResults: [] });
				pendingMessages = [streamed.reasoningLoop.message];
				continue;
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await endLoop();
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			if (signal?.aborted) {
				await endLoop();
				return;
			}
			if (loopGuard) {
				const noProgress = loopGuard.finishTurn(extractTurnProgress(message, toolResults));
				if (noProgress) {
					const decision = loopGuard.trigger();
					if (decision.kind === "stop") {
						await endLoop();
						return;
					}
					pendingMessages = [decision.message];
					continue;
				}
			}
			lastTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			const shouldStop = await settleOrEnd(
				maybePromiseWithAbort(
					config.shouldStopAfterTurn?.({
						message,
						toolResults,
						context: currentContext,
						newMessages,
					}) ?? false,
					signal,
				),
			);
			if (shouldStop === undefined || shouldStop || shouldStopBeforeTurn()) {
				await endLoop();
				return;
			}

			const steeringMessages = await settleOrEnd(pollMessagesUnlessAborted(config.getSteeringMessages, signal));
			if (steeringMessages === undefined) {
				return;
			}
			pendingMessages = steeringMessages;
			// Steering drained by this poll owns the turn boundary; stop only when it was empty.
			if (pendingMessages.length === 0 && shouldStopBeforeTurn()) {
				await endLoop();
				return;
			}
		}

		if (shouldStopBeforeTurn()) break;
		const followUpMessages = await settleOrEnd(pollMessagesUnlessAborted(config.getFollowUpMessages, signal));
		if (followUpMessages === undefined) {
			return;
		}
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		if (shouldStopBeforeTurn()) break;
		const continuationMessages = lastTurn
			? await settleOrEnd(maybePromiseWithAbort(config.getContinuationMessages?.(lastTurn, signal) ?? [], signal))
			: [];
		if (continuationMessages === undefined) {
			return;
		}
		if (continuationMessages.length > 0) {
			pendingMessages = continuationMessages;
			continue;
		}

		break;
	}

	await endLoop();
}

type StreamedAssistantTurn = {
	message: AssistantMessage;
	/** Set when the reasoning-loop guard stopped the generation mid-turn. */
	reasoningLoop?: ReasoningLoopDecision;
};

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	loopGuard?: ReasoningLoopGuard,
): Promise<StreamedAssistantTurn> {
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	const finishStoppedMessage = (finalMessage: AssistantMessage) =>
		commitAssistantMessage(context, emit, finalMessage, addedPartial);

	const detector = config.degeneracyGuard === false ? undefined : new DegeneracyDetector();
	// The provider needs a signal this function can trip on its own: a degenerate response has to
	// be cancelled at the socket or the tokens keep being generated and billed to max_tokens.
	const guardAbort = detector || loopGuard ? new AbortController() : undefined;
	/** Set when the reasoning-loop guard itself cuts the stream, so the abort catch below
	 * returns the ladder decision instead of treating the cut as a plain user abort. */
	let guardAbortReason: ReasoningLoopDecision | undefined;
	const forwardAbort = guardAbort ? () => guardAbort.abort() : undefined;
	if (forwardAbort && signal) {
		if (signal.aborted) {
			forwardAbort();
		} else {
			signal.addEventListener("abort", forwardAbort, { once: true });
		}
	}

	try {
		throwIfAborted(signal);
		let messages = context.messages;
		if (config.transformContext) {
			messages = await maybePromiseWithAbort(config.transformContext(messages, signal), signal);
		}

		const llmMessages = await maybePromiseWithAbort(config.convertToLlm(messages), signal);

		const streamFunction = streamFn || streamSimple;

		const resolvedApiKey =
			(config.getApiKey
				? await maybePromiseWithAbort(config.getApiKey(config.model.provider), signal)
				: undefined) || config.apiKey;

		const llmContext: Context = {
			systemPrompt: config.getSystemPrompt?.() ?? context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};

		const response = await maybePromiseWithAbort(
			streamFunction(config.model, llmContext, {
				...config,
				reasoning: config.getReasoning?.() ?? config.reasoning,
				apiKey: resolvedApiKey,
				signal: guardAbort?.signal ?? signal,
			}),
			signal,
		);
		const iterator = response[Symbol.asyncIterator]();
		const closeIterator = () => {
			void Promise.resolve(iterator.return?.()).catch(() => undefined);
		};
		let degeneracy: DegeneracyReport | undefined;
		let reasoningLoop: ReasoningLoopDecision | undefined;
		while (true) {
			const next = await raceWithAbort<IteratorResult<AssistantMessageEvent>>(
				iterator.next(),
				signal,
				closeIterator,
			);
			if (next.done) {
				break;
			}
			const event = next.value;
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}

					// Assistant prose only. Tool-call arguments are code, diffs, JSON and base64,
					// all legitimately repetitive, and a false positive there destroys real work.
					if (detector && (event.type === "text_delta" || event.type === "thinking_delta")) {
						degeneracy = detector.push(event.contentIndex, event.delta);
					}
					if (loopGuard) {
						if (event.type === "toolcall_start") {
							loopGuard.noteToolCallSeen();
						} else if (
							event.type === "thinking_delta" &&
							!reasoningLoop &&
							loopGuard.observeThinking(event.delta)
						) {
							reasoningLoop = loopGuard.trigger();
						}
					}

					break;
				case "done":
				case "error": {
					let finalMessage = getTerminalMessage(event);
					try {
						finalMessage = await maybePromiseWithAbort(response.result(), signal);
					} catch (error) {
						if (!signal?.aborted || !isAbortError(error)) {
							throw error;
						}
					}
					return { message: await commitAssistantMessage(context, emit, finalMessage, addedPartial) };
				}
			}
			if (degeneracy) {
				guardAbort?.abort();
				closeIterator();
				return {
					message: await finishStoppedMessage(
						createDegenerateAssistantMessage(config, partialMessage, degeneracy),
					),
				};
			}
			if (reasoningLoop) {
				// Same socket-level cut as degeneracy: the looping planning keeps being generated
				// and billed until the provider stream is cancelled.
				guardAbortReason = reasoningLoop;
				guardAbort?.abort();
				closeIterator();
				return {
					message: await finishStoppedMessage(
						createStoppedAssistantMessage(config, partialMessage, [], reasoningLoopStopErrorMessage()),
					),
					reasoningLoop,
				};
			}
		}

		const finalMessage = await maybePromiseWithAbort(response.result(), signal);
		return { message: await commitAssistantMessage(context, emit, finalMessage, addedPartial) };
	} catch (error) {
		if (signal?.aborted && isAbortError(error)) {
			return {
				message: await finishStoppedMessage(createAbortedAssistantMessage(config, partialMessage)),
				reasoningLoop: guardAbortReason,
			};
		}
		throw error;
	} finally {
		if (forwardAbort) {
			signal?.removeEventListener("abort", forwardAbort);
		}
	}
}

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		if (signal?.aborted) {
			break;
		}

		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: unknown;
	/** Set when the call reached this tool through an alias; appended to the executed result. */
	aliasNote?: string;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, unknown>,
	};
}

/**
 * When the model names no registered tool, consult the app's alias table before
 * rejecting the call. Canonical names always win: aliases are only tried on a miss.
 */
function resolveAliasedTool(
	currentContext: AgentContext,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
): { tool: AgentTool; toolCall: AgentToolCall; note?: string } | undefined {
	const resolution: ToolAliasResolution | undefined = config.toolAliases?.resolve(toolCall.name);
	if (!resolution) {
		return undefined;
	}
	const aliasedTool = currentContext.tools?.find((t) => t.name === resolution.name);
	if (!aliasedTool) {
		return undefined;
	}
	return {
		tool: aliasedTool,
		toolCall: { ...toolCall, name: resolution.name, arguments: resolution.args },
		note: resolution.note,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	let tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	let effectiveCall = toolCall;
	let aliasNote: string | undefined;
	if (!tool) {
		const aliased = resolveAliasedTool(currentContext, toolCall, config);
		if (aliased) {
			tool = aliased.tool;
			effectiveCall = aliased.toolCall;
			aliasNote = aliased.note;
		}
	}
	if (!tool) {
		// Naming what does exist turns a dead end into a correction: a model that guessed
		// `bash` otherwise guesses again instead of reaching for the tool that runs shell cells.
		const available = (currentContext.tools ?? []).map((t) => t.name).sort();
		const suffix = available.length > 0 ? `. Available tools: ${available.join(", ")}` : "";
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found${suffix}`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, effectiveCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await maybePromiseWithAbort(
				config.beforeToolCall(
					{
						assistantMessage,
						toolCall: effectiveCall,
						args: validatedArgs,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall: effectiveCall,
			tool,
			args: validatedArgs,
			aliasNote,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		throwIfAborted(signal);
		const result = await raceWithAbort(
			prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
				if (!acceptingUpdates || signal?.aborted) {
					return;
				}
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			}),
			signal,
		);
		acceptingUpdates = false;
		try {
			await raceWithAbort(
				Promise.all(updateEvents).then(() => undefined),
				signal,
			);
		} catch (error) {
			if (!signal?.aborted || !isAbortError(error)) {
				throw error;
			}
		}
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await raceWithAbort(
			Promise.all(updateEvents).then(() => undefined),
			signal,
		).catch(() => undefined);
		return {
			result: createErrorToolResult(
				signal?.aborted ? "Tool execution aborted" : error instanceof Error ? error.message : String(error),
			),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (prepared.aliasNote) {
		result = {
			...result,
			content: [...result.content, { type: "text", text: prepared.aliasNote }],
		};
	}

	if (config.afterToolCall) {
		try {
			const afterResult = await maybePromiseWithAbort(
				config.afterToolCall(
					{
						assistantMessage,
						toolCall: prepared.toolCall,
						args: prepared.args,
						result,
						isError,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
