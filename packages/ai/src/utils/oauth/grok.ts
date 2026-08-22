import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

type DeviceCodeResponse = {
	device_code: string;
	verification_uri_complete: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	expires_in: number;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function startDeviceFlow(): Promise<DeviceCodeResponse & { code_verifier: string }> {
	const pkce = await generatePKCE();
	const data = await fetchJson(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: SCOPE,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const record = data as Record<string, unknown>;
	const deviceCode = record.device_code;
	const verificationUri = record.verification_uri_complete ?? record.verification_uri;
	const interval = record.interval ?? 5;
	const expiresIn = record.expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	return {
		device_code: deviceCode,
		verification_uri_complete: verificationUri,
		interval,
		expires_in: expiresIn,
		code_verifier: pkce.verifier,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollForToken(
	deviceCode: string,
	codeVerifier: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<DeviceTokenSuccessResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal);

		const raw = await fetchJson(TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				code_verifier: codeVerifier,
			}),
		});

		if (!raw || typeof raw !== "object") {
			continue;
		}

		if (typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return raw as DeviceTokenSuccessResponse;
		}

		const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
		if (error === "authorization_pending") {
			continue;
		}
		if (error === "slow_down") {
			intervalMs = typeof interval === "number" && interval > 0 ? interval * 1000 : intervalMs + 5000;
			continue;
		}
		throw new Error(`Device flow failed: ${error}${description ? `: ${description}` : ""}`);
	}

	throw new Error("Device flow timed out");
}

async function requestRefresh(refreshToken: string): Promise<OAuthCredentials> {
	const raw = await fetchJson(TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!raw || typeof raw !== "object" || typeof (raw as DeviceTokenSuccessResponse).access_token !== "string") {
		throw new Error("Invalid token refresh response");
	}

	const json = raw as DeviceTokenSuccessResponse;
	if (
		typeof json.expires_in !== "number" ||
		(json.refresh_token !== undefined && typeof json.refresh_token !== "string")
	) {
		throw new Error("Invalid token refresh response fields");
	}

	return {
		// xAI rotates single-use refresh tokens; keep the previous one only if
		// the server did not send a replacement.
		refresh: json.refresh_token ?? refreshToken,
		access: json.access_token,
		expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
	};
}

// xAI refresh tokens are single-use: concurrent refreshes with the same token
// must share one request or the losers invalidate the winner's session.
const inflightRefreshes = new Map<string, Promise<OAuthCredentials>>();

export function refreshGrokToken(refreshToken: string): Promise<OAuthCredentials> {
	const inflight = inflightRefreshes.get(refreshToken);
	if (inflight) {
		return inflight;
	}

	const promise = requestRefresh(refreshToken).finally(() => {
		inflightRefreshes.delete(refreshToken);
	});
	inflightRefreshes.set(refreshToken, promise);
	return promise;
}

/**
 * Login with SuperGrok OAuth (device authorization grant with PKCE).
 * The user completes authorization at auth.x.ai; this polls until approved.
 */
export async function loginGrok(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await startDeviceFlow();
	options.onAuth(device.verification_uri_complete, "Complete authorization in your browser");

	const token = await pollForToken(
		device.device_code,
		device.code_verifier,
		device.interval,
		device.expires_in,
		options.signal,
	);

	if (typeof token.refresh_token !== "string" || typeof token.expires_in !== "number") {
		throw new Error("Invalid device token response fields");
	}

	return {
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const grokOAuthProvider: OAuthProviderInterface = {
	id: "grok",
	name: "Grok (SuperGrok)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGrok({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshGrokToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
