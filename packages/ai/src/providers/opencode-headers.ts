import type { Api, Model } from "../types.js";

const OPENCODE_CLI_USER_AGENT = "opencode/latest/1.3.15/cli";

function requestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function isOpencodeModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	return model.provider === "opencode" || model.provider === "opencode-go" || model.baseUrl.includes("opencode.ai");
}

/**
 * Client headers the Zen gateway expects from the opencode CLI. Requests
 * without them face much harder free-tier throttling, even with a valid key.
 * `sessionId` (when the caller supplies one) becomes a stable
 * `x-opencode-session` so the gateway can affiliate requests; otherwise a
 * fresh id is generated. Headers the caller already set always win.
 * No Authorization here, auth stays with each caller.
 */
export function opencodeClientHeaders(
	model: Pick<Model<Api>, "provider" | "baseUrl">,
	sessionId?: string,
	explicit?: Record<string, string>,
): Record<string, string> {
	if (!isOpencodeModel(model)) return {};
	const hasSessionHeader =
		explicit !== undefined && Object.keys(explicit).some((key) => key.toLowerCase() === "x-opencode-session");
	return {
		"x-opencode-client": "cli",
		...(hasSessionHeader ? {} : { "x-opencode-session": sessionId ?? requestId() }),
		"x-opencode-project": requestId(),
		"x-opencode-request": requestId(),
		"User-Agent": OPENCODE_CLI_USER_AGENT,
	};
}
