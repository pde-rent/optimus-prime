import type { Api, AssistantMessage, Model, StopReason, StreamOptions } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { failAssistantStream, streamFailureFromStopReason } from "../utils/stream-failure.js";
import { createAssistantMessage } from "./assistant-message.js";

export interface ProviderStreamHooks {
	/**
	 * Request id captured from the response headers, reported when a provider
	 * stop reason classifies as a failure.
	 */
	getRequestId?: () => string | undefined;
	/**
	 * Replace the default post-run check ("aborted"/"error" stop reason throws
	 * a classified {@link streamFailureFromStopReason}). Providers that report
	 * terminal states their own way throw here instead.
	 */
	checkFinish?: (output: AssistantMessage) => void;
	/** Scratch field names deleted from every content block on failure. */
	scratchKeys?: readonly string[];
	/** Custom user-facing failure message; defaults to classified formatting. */
	formatError?: (error: unknown) => string | undefined;
	/** Set false for providers that report failures their own way. */
	recordFailure?: boolean;
}

/**
 * Shared scaffolding for provider stream functions: creates the assistant
 * message and event stream, runs the provider-specific consume loop, applies
 * the common post-run abort/stop-reason checks, pushes `done`, and routes any
 * thrown value through {@link failAssistantStream}.
 */
export function runProviderStream<TApi extends Api, TOptions extends StreamOptions>(
	model: Model<TApi>,
	options: TOptions | undefined,
	run: (output: AssistantMessage, stream: AssistantMessageEventStream) => Promise<void>,
	hooks: ProviderStreamHooks = {},
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createAssistantMessage(model);

		try {
			await run(output, stream);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			type TerminalStopReason = Exclude<StopReason, "aborted" | "error">;
			const pushDone = (reason: TerminalStopReason) => {
				stream.push({ type: "done", reason, message: output });
				stream.end();
			};

			if (hooks.checkFinish) {
				// Contract: a custom check throws unless the message reached a
				// terminal stop | length | toolUse state.
				hooks.checkFinish(output);
				pushDone(output.stopReason as TerminalStopReason);
			} else {
				const stopReason = output.stopReason;
				if (stopReason === "aborted" || stopReason === "error") {
					throw streamFailureFromStopReason(output.stopReasonRaw, { requestId: hooks.getRequestId?.() });
				}
				pushDone(stopReason);
			}
		} catch (error) {
			failAssistantStream(model, output, stream, error, {
				aborted: options?.signal?.aborted === true,
				message: hooks.formatError?.(error),
				scratchKeys: hooks.scratchKeys,
				recordFailure: hooks.recordFailure,
			});
		}
	})();

	return stream;
}
