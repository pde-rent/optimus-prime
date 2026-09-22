import { describe, expect, it } from "bun:test";
import {
	isOpencodeModel,
	opencodeClientHeaders,
	opencodeId,
	opencodeSessionId,
} from "../src/providers/opencode-headers.js";

const zen = { provider: "opencode", baseUrl: "https://opencode.ai/zen/v1" } as const;
const go = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" } as const;
const other = { provider: "openai", baseUrl: "https://api.openai.com/v1" } as const;

const ID_PATTERN = /^(ses|msg)_[0-9a-f]{12}[A-Za-z0-9_-]{14}$/;

describe("opencode client headers", () => {
	it("detects zen, go, and custom opencode.ai base urls", () => {
		expect(isOpencodeModel(zen)).toBe(true);
		expect(isOpencodeModel(go)).toBe(true);
		expect(isOpencodeModel({ provider: "custom", baseUrl: "https://proxy.example.com/opencode.ai" })).toBe(true);
		expect(isOpencodeModel(other)).toBe(false);
	});

	it("emits CLI-shaped ids matching the official generator", () => {
		expect(opencodeId("session")).toMatch(ID_PATTERN);
		expect(opencodeId("message")).toMatch(ID_PATTERN);
		expect(opencodeId("session")).not.toBe(opencodeId("session"));
	});

	it("maps caller sessions onto stable CLI-shaped ids", () => {
		const first = opencodeSessionId("my-session-1");
		expect(first).toMatch(ID_PATTERN);
		expect(opencodeSessionId("my-session-1")).toBe(first);
		expect(opencodeSessionId("my-session-2")).not.toBe(first);
	});

	it("passes through values already in CLI shape", () => {
		const shaped = opencodeId("session");
		expect(opencodeSessionId(shaped)).toBe(shaped);
	});

	it("uses the caller session id for x-opencode-session when provided", () => {
		const headers = opencodeClientHeaders(zen, "sess-123");
		expect(headers["x-opencode-session"]).toBe(opencodeSessionId("sess-123"));
		expect(headers["x-opencode-session"]).toMatch(ID_PATTERN);
		expect(headers["x-opencode-project"]).toBe("global");
		expect(headers["x-opencode-client"]).toBe("cli");
	});

	it("preserves an explicit caller x-opencode-session header", () => {
		const headers = opencodeClientHeaders(zen, "sess-123", { "X-Opencode-Session": "caller-sess" });
		expect(headers["x-opencode-session"]).toBeUndefined();
	});

	it("emits nothing for other providers", () => {
		expect(opencodeClientHeaders(other)).toEqual({});
	});
});
