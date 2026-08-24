import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

/**
 * Pure classification helpers over a failed assistant message. They decide
 * whether an error is retryable, permanent, or an auth failure; callers supply
 * session state (context window size, current retry attempt) explicitly.
 */

export function isRetryableError(
	message: AssistantMessage,
	options: { contextWindow: number; retryAttempt: number },
): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;

	if (isContextOverflow(message, options.contextWindow)) return false;

	if (isFauxProviderQueueExhausted(message)) {
		return false;
	}

	if (isAgentLifecycleFailure(message)) {
		return false;
	}

	if (isStructuredPermanentProviderRetryExhausted(message, options.retryAttempt)) {
		return false;
	}

	return true;
}

export function isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
	return message.provider === "faux" && message.errorMessage === "No more faux responses queued";
}

export function isAgentLifecycleFailure(message: AssistantMessage): boolean {
	return message.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure") ?? false;
}

export function getProviderStreamFailureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
	const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
	const details = failure?.details;
	if (!details || typeof details !== "object") {
		return undefined;
	}
	return details;
}

export function getProviderStreamFailureKind(message: AssistantMessage): string | undefined {
	const kind = getProviderStreamFailureDetails(message)?.kind;
	return typeof kind === "string" ? kind : undefined;
}

export function isStructuredPermanentProviderFailure(message: AssistantMessage): boolean {
	const kind = getProviderStreamFailureKind(message);
	return kind === "auth" || kind === "invalid_request" || kind === "refusal";
}

export function isStructuredPermanentProviderRetryExhausted(message: AssistantMessage, retryAttempt: number): boolean {
	return retryAttempt > 0 && isStructuredPermanentProviderFailure(message);
}

export function getProviderStreamFailureAuthStatus(message: AssistantMessage): number | undefined {
	const details = getProviderStreamFailureDetails(message);
	if (!details) {
		return undefined;
	}

	const kind = details.kind;
	if (kind !== "auth") {
		return undefined;
	}

	const status = details.status;
	if (typeof status === "number") {
		return status;
	}
	if (typeof status === "string") {
		const parsed = Number(status);
		return Number.isInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function isConcreteProviderAuthFailure(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;

	const structuredStatus = getProviderStreamFailureAuthStatus(message);
	if (structuredStatus === 401 || structuredStatus === 403) {
		return true;
	}

	if (/\b(?:401|403)\b/.test(message.errorMessage) && /\bstatus code\b/i.test(message.errorMessage)) {
		return true;
	}

	return (
		/\b(?:401|403)\b/.test(message.errorMessage) &&
		/auth|unauthori[sz]ed|forbidden|api.?key|token|credential/i.test(message.errorMessage)
	);
}
