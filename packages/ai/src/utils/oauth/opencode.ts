import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "opencode-cli";
const DEVICE_CODE_URL = "https://console.opencode.ai/auth/device/code";
const TOKEN_URL = "https://console.opencode.ai/auth/device/token";

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
	expires_in?: number;
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

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const data = await fetchJson(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }),
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

	return { device_code: deviceCode, verification_uri_complete: verificationUri, interval, expires_in: expiresIn };
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
		const descriptionSuffix = description ? `: ${description}` : "";
		throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
	}

	throw new Error("Device flow timed out");
}

export async function refreshOpenCodeToken(refreshToken: string): Promise<OAuthCredentials> {
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
	if (typeof json.refresh_token !== "string" || typeof json.expires_in !== "number") {
		throw new Error("Invalid token refresh response fields");
	}

	return {
		refresh: json.refresh_token,
		access: json.access_token,
		expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Login with OpenCode OAuth (device code flow). The user completes
 * authorization at console.opencode.ai; this polls until approved.
 */
export async function loginOpenCode(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await startDeviceFlow();
	options.onAuth(device.verification_uri_complete, "Complete authorization in your browser");

	const token = await pollForToken(device.device_code, device.interval, device.expires_in, options.signal);

	if (typeof token.refresh_token !== "string" || typeof token.expires_in !== "number") {
		throw new Error("Invalid device token response fields");
	}

	return {
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
	};
}

function createOpenCodeOAuthProvider(id: "opencode" | "opencode-go", name: string): OAuthProviderInterface {
	return {
		id,
		name,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			return loginOpenCode({
				onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
				onProgress: callbacks.onProgress,
				signal: callbacks.signal,
			});
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return refreshOpenCodeToken(credentials.refresh);
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

export const opencodeOAuthProvider: OAuthProviderInterface = createOpenCodeOAuthProvider("opencode", "OpenCode Zen");
export const opencodeGoOAuthProvider: OAuthProviderInterface = createOpenCodeOAuthProvider(
	"opencode-go",
	"OpenCode Go",
);
