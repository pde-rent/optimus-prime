import { createDeviceFlowOAuthProvider, makeDeviceFlowLogin, refreshViaTokenEndpoint } from "./common.js";
import type { OAuthCredentials } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

const GROK_DEVICE_FLOW = {
	deviceUrl: DEVICE_CODE_URL,
	tokenUrl: TOKEN_URL,
	clientId: CLIENT_ID,
	scope: SCOPE,
	pkce: true,
} as const;

// xAI refresh tokens are single-use: concurrent refreshes with the same token
// must share one request or the losers invalidate the winner's session.
const inflightRefreshes = new Map<string, Promise<OAuthCredentials>>();

export function refreshGrokToken(refreshToken: string): Promise<OAuthCredentials> {
	const inflight = inflightRefreshes.get(refreshToken);
	if (inflight) {
		return inflight;
	}

	const promise = refreshViaTokenEndpoint({
		tokenUrl: TOKEN_URL,
		clientId: CLIENT_ID,
		refreshToken,
		// xAI rotates single-use refresh tokens; keep the previous one only if
		// the server did not send a replacement.
		keepPreviousRefresh: true,
	}).finally(() => {
		inflightRefreshes.delete(refreshToken);
	});
	inflightRefreshes.set(refreshToken, promise);
	return promise;
}

/**
 * Login with SuperGrok OAuth (device authorization grant with PKCE).
 * The user completes authorization at auth.x.ai; this polls until approved.
 */
export const loginGrok = makeDeviceFlowLogin(GROK_DEVICE_FLOW);

export const grokOAuthProvider = createDeviceFlowOAuthProvider({
	...GROK_DEVICE_FLOW,
	id: "grok",
	name: "Grok (SuperGrok)",
	refresh: refreshGrokToken,
});
