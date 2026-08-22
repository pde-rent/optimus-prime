import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";
const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const TOKEN_URL = "https://api2.cursor.sh/oauth/token";

const POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// The exchange response carries no reliable expiry; assume a week and rely on
// refresh when the access token is rejected.
const DEFAULT_CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type RecordOf = Record<string, unknown>;

function isRecord(value: unknown): value is RecordOf {
	return typeof value === "object" && value !== null;
}

function pickString(record: RecordOf, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function pickNumber(record: RecordOf, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") {
			return value;
		}
	}
	return undefined;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		json = undefined;
	}
	return { status: response.status, json };
}

function extractAccessToken(json: unknown): string | undefined {
	if (!isRecord(json)) {
		return undefined;
	}
	return (
		pickString(json, ["accessToken", "access_token"]) ??
		(isRecord(json.result) ? pickString(json.result, ["accessToken", "access_token"]) : undefined)
	);
}

async function pollForAccessToken(uuid: string, signal?: AbortSignal): Promise<string> {
	const deadline = Date.now() + LOGIN_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const { status, json } = await postJson(POLL_URL, { uuid });
		// Cursor answers with a non-2xx or an empty object until the browser
		// login completes; only a token in the payload means success.
		const accessToken = extractAccessToken(json);
		if (status >= 200 && status < 300 && accessToken) {
			return accessToken;
		}

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(resolve, POLL_INTERVAL_MS);
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

	throw new Error("Cursor login timed out");
}

export async function loginCursor(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const uuid = crypto.randomUUID();

	options.onAuth(
		`${LOGIN_URL}?challenge=${encodeURIComponent(pkce.challenge)}&uuid=${encodeURIComponent(uuid)}`,
		"Complete authorization in your browser",
	);

	const accessToken = await pollForAccessToken(uuid, options.signal);

	const exchange = await postJson(EXCHANGE_URL, { accessToken });
	const exchangedToken = extractAccessToken(exchange.json) ?? accessToken;
	const refreshToken = isRecord(exchange.json)
		? pickString(exchange.json, ["refreshToken", "refresh_token"])
		: undefined;

	if (!refreshToken) {
		throw new Error("Invalid cursor exchange response: missing refresh token");
	}

	const expiresIn = isRecord(exchange.json) ? pickNumber(exchange.json, ["expiresIn", "expires_in"]) : undefined;
	const expiresAt = isRecord(exchange.json)
		? pickNumber(exchange.json, ["expiry", "expiresAt", "expires_at"])
		: undefined;

	return {
		refresh: refreshToken,
		access: exchangedToken,
		expires:
			expiresAt !== undefined
				? expiresAt * 1000 - 5 * 60 * 1000
				: Date.now() + (expiresIn !== undefined ? expiresIn * 1000 : DEFAULT_CREDENTIAL_TTL_MS) - 5 * 60 * 1000,
	};
}

async function requestRefresh(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}

	const raw: unknown = await response.json();
	if (!isRecord(raw)) {
		throw new Error("Invalid token refresh response");
	}

	const access = pickString(raw, ["access_token", "accessToken"]);
	if (!access) {
		throw new Error("Invalid token refresh response fields");
	}

	const nextRefresh = pickString(raw, ["refresh_token", "refreshToken"]);
	const expiresIn = pickNumber(raw, ["expires_in", "expiresIn"]);

	return {
		refresh: nextRefresh ?? refreshToken,
		access,
		expires: Date.now() + (expiresIn !== undefined ? expiresIn * 1000 : DEFAULT_CREDENTIAL_TTL_MS) - 5 * 60 * 1000,
	};
}

export function refreshCursorToken(refreshToken: string): Promise<OAuthCredentials> {
	return requestRefresh(refreshToken);
}

/**
 * Login with the Cursor subscription OAuth flow (PKCE browser login).
 * The user completes authorization at cursor.com; this polls until approved.
 */
export const cursorOAuthProvider: OAuthProviderInterface = {
	id: "cursor",
	name: "Cursor",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginCursor({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshCursorToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
