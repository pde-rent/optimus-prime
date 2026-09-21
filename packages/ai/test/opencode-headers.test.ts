import { describe, expect, it } from "bun:test";
import { isOpencodeModel, opencodeClientHeaders } from "../src/providers/opencode-headers.js";

const zen = { provider: "opencode", baseUrl: "https://opencode.ai/zen/v1" } as const;
const go = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" } as const;
const other = { provider: "openai", baseUrl: "https://api.openai.com/v1" } as const;

describe("opencode client headers", () => {
	it("detects zen, go, and custom opencode.ai base urls", () => {
		expect(isOpencodeModel(zen)).toBe(true);
		expect(isOpencodeModel(go)).toBe(true);
		expect(isOpencodeModel({ provider: "custom", baseUrl: "https://proxy.example.com/opencode.ai" })).toBe(true);
		expect(isOpencodeModel(other)).toBe(false);
	});

	it("emits CLI-grade headers with fresh request ids", () => {
		const first = opencodeClientHeaders(zen);
		const second = opencodeClientHeaders(zen);
		expect(first["x-opencode-client"]).toBe("cli");
		expect(first["User-Agent"]).toBe("opencode/latest/1.3.15/cli");
		expect(first["x-opencode-session"]).toMatch(/./);
		expect(first["x-opencode-request"]).not.toBe(second["x-opencode-request"]);
	});

	it("uses the caller session id for x-opencode-session when provided", () => {
		const headers = opencodeClientHeaders(zen, "sess-123");
		expect(headers["x-opencode-session"]).toBe("sess-123");
	});

	it("preserves an explicit caller x-opencode-session header", () => {
		const headers = opencodeClientHeaders(zen, "sess-123", { "X-Opencode-Session": "caller-sess" });
		expect(headers["x-opencode-session"]).toBeUndefined();
	});

	it("emits nothing for other providers", () => {
		expect(opencodeClientHeaders(other)).toEqual({});
	});
});
