import type { Api, Model } from "../types.js";

const OPENCODE_CLI_USER_AGENT = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

const ID_PREFIXES = { session: "ses", message: "msg" } as const;

/** Monotonic counter mirroring the CLI generator (ids sort newest-first). */
let lastTimestamp = 0;
let idCounter = 0;

function randomBase62(length: number): string {
	const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let result = "";
	if (typeof globalThis.crypto?.getRandomValues === "function") {
		const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
		for (let i = 0; i < length; i++) {
			result += chars[bytes[i] % 62];
		}
		return result;
	}
	for (let i = 0; i < length; i++) {
		result += chars[Math.floor(Math.random() * 62)];
	}
	return result;
}

/**
 * CLI-compatible id (`ses_`/`msg_` + 12 timestamp hex chars + 14 base62 chars).
 * The gateway rejects foreign id shapes on free-tier routes.
 */
export function opencodeId(prefix: "session" | "message", timestamp: number = Date.now()): string {
	if (timestamp !== lastTimestamp) {
		lastTimestamp = timestamp;
		idCounter = 0;
	}
	idCounter++;
	let now = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter);
	now = ~now;
	let hex = "";
	for (let i = 0; i < 6; i++) {
		hex += ((now >> BigInt(40 - 8 * i)) & BigInt(0xff)).toString(16).padStart(2, "0").slice(-2);
	}
	return `${ID_PREFIXES[prefix]}_${hex}${randomBase62(14)}`;
}

/** FNV-1a 64-bit hash, hex-encoded. Dependency-free stable mapping. */
function hash64(value: string): bigint {
	let hash = 0xcbf29ce484222325n;
	const mask = (1n << 64n) - 1n;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash ^ BigInt(value.charCodeAt(i))) * 0x100001b3n) & mask;
	}
	return hash;
}

/** Deterministic 14-char base62 suffix derived from an arbitrary session key. */
function suffixFor(value: string): string {
	const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let hash = hash64(`opencode-session:${value}`);
	let result = "";
	for (let i = 0; i < 14; i++) {
		result += chars[Number(hash % 62n)];
		hash /= 62n;
	}
	return result;
}

function timestampHex(timestamp: number): string {
	let now = BigInt(timestamp) * BigInt(0x1000);
	now = ~now;
	let hex = "";
	for (let i = 0; i < 6; i++) {
		hex += ((now >> BigInt(40 - 8 * i)) & BigInt(0xff)).toString(16).padStart(2, "0").slice(-2);
	}
	return hex;
}

const OPENCODE_ID_PATTERN = /^(ses|msg)_[0-9a-f]{12}[A-Za-z0-9_-]{14}$/;

/** Memoized caller-session mapping: stable per process, preserves stickiness. */
const sessionIdCache = new Map<string, string>();

/**
 * Map any caller session key onto a stable CLI-shaped session id, preserving
 * per-session stickiness. Values already in CLI shape pass through untouched.
 */
export function opencodeSessionId(sessionId?: string, timestamp: number = Date.now()): string {
	if (sessionId && OPENCODE_ID_PATTERN.test(sessionId)) return sessionId;
	if (!sessionId) return opencodeId("session", timestamp);
	const cached = sessionIdCache.get(sessionId);
	if (cached) return cached;
	const mapped = `ses_${timestampHex(timestamp)}${suffixFor(sessionId)}`;
	sessionIdCache.set(sessionId, mapped);
	return mapped;
}

export function isOpencodeModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	return model.provider === "opencode" || model.provider === "opencode-go" || model.baseUrl.includes("opencode.ai");
}

/**
 * Client headers matching the official CLI wire format. The gateway gates
 * free-tier routes on CLI-shaped session/request ids (`ses_`/`msg_` +
 * timestamp hex + base62) and a stable session per conversation; random
 * UUIDs are rejected. Headers the caller already set always win.
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
		...(hasSessionHeader ? {} : { "x-opencode-session": opencodeSessionId(sessionId) }),
		"x-opencode-project": "global",
		"x-opencode-request": opencodeId("message"),
		"User-Agent": OPENCODE_CLI_USER_AGENT,
	};
}
