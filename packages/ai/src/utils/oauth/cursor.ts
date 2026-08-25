import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";
const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// The exchange response carries no reliable expiry; assume a week and rely on
// refresh when the access token is rejected.
const DEFAULT_CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type RecordOf = Record<string, unknown>;

function isRecord(value: unknown): value is RecordOf {
	return typeof value === "object" && value !== null;
}

/**
 * Decode the `exp` claim of a Cursor JWT access token, in ms. Undefined when
 * the token is not a decodable JWT with an exp.
 */
function decodeJwtExpiryMs(token: string): number | undefined {
	const payload = token.split(".")[1];
	if (!payload) {
		return undefined;
	}
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		if (isRecord(decoded) && typeof decoded.exp === "number") {
			return decoded.exp * 1000;
		}
	} catch {
		// Fall through to the default TTL.
	}
	return undefined;
}

interface CursorTokenPair {
	accessToken: string;
	refreshToken: string;
}

/**
 * Poll until the browser login completes. Pending answers are HTTP 404
 * (unapproved uuid); success is a 200 carrying both tokens.
 */
async function pollForTokens(uuid: string, verifier: string, signal?: AbortSignal): Promise<CursorTokenPair> {
	const deadline = Date.now() + LOGIN_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const url = `${POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
		const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
		if (response.status === 404) {
			await sleep(POLL_INTERVAL_MS, signal);
			continue;
		}
		if (!response.ok) {
			throw new Error(`cursor login poll failed with HTTP ${response.status}`);
		}

		const json: unknown = await response.json().catch(() => undefined);
		if (
			isRecord(json) &&
			typeof json.accessToken === "string" &&
			json.accessToken.length > 0 &&
			typeof json.refreshToken === "string" &&
			json.refreshToken.length > 0
		) {
			return { accessToken: json.accessToken, refreshToken: json.refreshToken };
		}

		await sleep(POLL_INTERVAL_MS, signal);
	}

	throw new Error("Cursor login timed out");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
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

export async function loginCursor(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const uuid = crypto.randomUUID();

	const params = new URLSearchParams({
		challenge: pkce.challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});
	options.onAuth(`${LOGIN_URL}?${params}`, "Complete authorization in your browser");

	const { accessToken, refreshToken } = await pollForTokens(uuid, pkce.verifier, options.signal);

	return {
		refresh: refreshToken,
		access: accessToken,
		expires: (decodeJwtExpiryMs(accessToken) ?? Date.now() + DEFAULT_CREDENTIAL_TTL_MS) - 5 * 60 * 1000,
	};
}

async function requestRefresh(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(EXCHANGE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${refreshToken}`,
		},
		body: "{}",
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}

	const raw: unknown = await response.json();
	if (!isRecord(raw)) {
		throw new Error("Invalid token refresh response");
	}

	const access = typeof raw.accessToken === "string" ? raw.accessToken : undefined;
	if (!access) {
		throw new Error("Invalid token refresh response fields");
	}
	const nextRefresh =
		typeof raw.refreshToken === "string" && raw.refreshToken.length > 0 ? raw.refreshToken : undefined;

	return {
		refresh: nextRefresh ?? refreshToken,
		access,
		expires: (decodeJwtExpiryMs(access) ?? Date.now() + DEFAULT_CREDENTIAL_TTL_MS) - 5 * 60 * 1000,
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
