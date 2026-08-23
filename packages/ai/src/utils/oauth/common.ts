import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

/** Shared machinery for OAuth device-authorization flows (RFC 8628) and
 * authorization-code providers. Provider modules keep only their endpoints,
 * client ids, and provider-specific quirks; everything else lives here. */

export type DeviceCodeResponse = {
	device_code: string;
	verification_uri_complete: string;
	interval: number;
	expires_in: number;
	code_verifier?: string;
};

export type DeviceTokenSuccessResponse = {
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
};

export type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

const FORM_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/x-www-form-urlencoded",
};

/** Request a device code. Sends PKCE challenge and scope when provided. */
export async function startDeviceFlow(options: {
	deviceUrl: string;
	clientId: string;
	scope?: string;
	pkce?: boolean;
}): Promise<DeviceCodeResponse> {
	const body: Record<string, string> = { client_id: options.clientId };
	let verifier: string | undefined;
	if (options.pkce) {
		const pkce = await generatePKCE();
		verifier = pkce.verifier;
		body.code_challenge = pkce.challenge;
		body.code_challenge_method = "S256";
	}
	if (options.scope) body.scope = options.scope;

	const data = await fetchJson(options.deviceUrl, {
		method: "POST",
		headers: FORM_HEADERS,
		body: new URLSearchParams(body),
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
		...(verifier ? { code_verifier: verifier } : {}),
	};
}

/** Poll the token endpoint until the user approves, slow_down backoff included. */
export async function pollForDeviceToken(options: {
	tokenUrl: string;
	clientId: string;
	deviceCode: string;
	codeVerifier?: string;
	intervalSeconds: number;
	expiresIn: number;
	signal?: AbortSignal;
}): Promise<DeviceTokenSuccessResponse> {
	const deadline = Date.now() + options.expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(options.intervalSeconds * 1000));

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), options.signal);

		const body: Record<string, string> = {
			client_id: options.clientId,
			device_code: options.deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		};
		if (options.codeVerifier) body.code_verifier = options.codeVerifier;

		const raw = await fetchJson(options.tokenUrl, {
			method: "POST",
			headers: FORM_HEADERS,
			body: new URLSearchParams(body),
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
		const descriptionSuffix = description ? `: ${description}` : "";
		throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
	}

	throw new Error("Device flow timed out");
}

/**
 * Refresh via a token endpoint that takes refresh_token grant as form fields.
 * When `keepPreviousRefresh` is set (single-use rotation semantics), the old
 * token is kept if the server did not send a replacement.
 */
export async function refreshViaTokenEndpoint(options: {
	tokenUrl: string;
	clientId: string;
	refreshToken: string;
	keepPreviousRefresh?: boolean;
}): Promise<OAuthCredentials> {
	const raw = await fetchJson(options.tokenUrl, {
		method: "POST",
		headers: FORM_HEADERS,
		body: new URLSearchParams({
			client_id: options.clientId,
			refresh_token: options.refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!raw || typeof raw !== "object" || typeof (raw as DeviceTokenSuccessResponse).access_token !== "string") {
		throw new Error("Invalid token refresh response");
	}

	const json = raw as DeviceTokenSuccessResponse;
	if (
		typeof json.expires_in !== "number" ||
		(json.refresh_token !== undefined && typeof json.refresh_token !== "string") ||
		(!json.refresh_token && !options.keepPreviousRefresh)
	) {
		throw new Error("Invalid token refresh response fields");
	}

	return {
		// Single-use rotation semantics: keep the previous token only when the
		// caller opts in and the server did not send a replacement.
		refresh: json.refresh_token ?? options.refreshToken,
		access: json.access_token,
		expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/** Build a login that drives the shared device flow end to end. */
export function makeDeviceFlowLogin(config: {
	deviceUrl: string;
	tokenUrl: string;
	clientId: string;
	scope?: string;
	pkce?: boolean;
}) {
	return async function login(options: {
		onAuth: (url: string, instructions?: string) => void;
		onProgress?: (message: string) => void;
		signal?: AbortSignal;
	}): Promise<OAuthCredentials> {
		const device = await startDeviceFlow({
			deviceUrl: config.deviceUrl,
			clientId: config.clientId,
			scope: config.scope,
			pkce: config.pkce,
		});
		options.onAuth(device.verification_uri_complete, "Complete authorization in your browser");

		const token = await pollForDeviceToken({
			tokenUrl: config.tokenUrl,
			clientId: config.clientId,
			deviceCode: device.device_code,
			codeVerifier: device.code_verifier,
			intervalSeconds: device.interval,
			expiresIn: device.expires_in,
			signal: options.signal,
		});

		if (typeof token.refresh_token !== "string" || typeof token.expires_in !== "number") {
			throw new Error("Invalid device token response fields");
		}

		return {
			refresh: token.refresh_token,
			access: token.access_token,
			expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
		};
	};
}

/**
 * Assemble an OAuthProviderInterface from a device-flow configuration.
 * `refresh` overrides the default form-grant refresh (e.g. for inflight dedup).
 */
export function createDeviceFlowOAuthProvider(config: {
	id: string;
	name: string;
	deviceUrl: string;
	tokenUrl: string;
	clientId: string;
	scope?: string;
	pkce?: boolean;
	keepPreviousRefreshOnRotate?: boolean;
	refresh?: (refreshToken: string) => Promise<OAuthCredentials>;
}): OAuthProviderInterface {
	const login = makeDeviceFlowLogin(config);
	const refreshToken =
		config.refresh ??
		((token: string) =>
			refreshViaTokenEndpoint({
				tokenUrl: config.tokenUrl,
				clientId: config.clientId,
				refreshToken: token,
				keepPreviousRefresh: config.keepPreviousRefreshOnRotate,
			}));

	return {
		id: config.id,
		name: config.name,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			return login({
				onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
				onProgress: callbacks.onProgress,
				signal: callbacks.signal,
			});
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return refreshToken(credentials.refresh);
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

/**
 * Parse a pasted authorization redirect (URL, `code#state`, query string, or bare code).
 * Shared by the browser-redirect OAuth providers (Anthropic, OpenAI Codex).
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}
