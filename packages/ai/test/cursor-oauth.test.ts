import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginCursor, refreshCursorToken } from "../src/utils/oauth/cursor.js";
import { getOAuthProvider, getOAuthProviders } from "../src/utils/oauth/index.js";

const POLL_URL = "https://api2.cursor.sh/auth/poll";
const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

// Minimal JWT with exp ~1 hour out; payload = base64url({"exp": <now+3600s>}).
function jwtWithExp(expSeconds: number): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ exp: expSeconds })}.sig`;
}

describe("Cursor OAuth PKCE flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("opens the browser login, polls via GET, and returns both tokens", async () => {
		vi.useFakeTimers();

		let pollCalls = 0;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);

			if (url.startsWith(POLL_URL)) {
				pollCalls++;
				expect(init?.method ?? "GET").toBe("GET");
				const parsed = new URL(url);
				expect(typeof parsed.searchParams.get("uuid")).toBe("string");
				// The poll must carry the PKCE verifier as a query param.
				expect(parsed.searchParams.get("verifier")?.length).toBeGreaterThan(0);
				if (pollCalls === 1) {
					return new Response("Not found", { status: 404 });
				}
				return Response.json({
					accessToken: "cursor_access_token",
					refreshToken: "cursor_refresh_token",
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const authUrls: string[] = [];
		const loginPromise = loginCursor({
			onAuth: (url) => authUrls.push(url),
			onProgress: () => {},
		});

		await vi.advanceTimersByTimeAsync(4000);
		const credentials = await loginPromise;

		expect(authUrls).toHaveLength(1);
		const authUrl = new URL(authUrls[0]!);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://cursor.com/loginDeepControl");
		expect(authUrl.searchParams.get("mode")).toBe("login");
		expect(authUrl.searchParams.get("redirectTarget")).toBe("cli");
		// S256 challenge: base64url of a SHA-256 digest is 43 characters.
		expect(authUrl.searchParams.get("challenge")).toHaveLength(43);
		expect(pollCalls).toBe(2);
		// No exchange step: the poll itself carries both tokens.
		expect(
			fetchMock.mock.calls.every(
				([input]) =>
					!String(input instanceof Request ? (input as Request).url : input).includes("exchange_user_api_key"),
			),
		).toBe(true);

		expect(credentials.access).toBe("cursor_access_token");
		expect(credentials.refresh).toBe("cursor_refresh_token");
		// Non-JWT access token: default TTL with safety margin, computed while
		// fake time was still advancing, so allow a poll-interval of skew.
		const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
		expect(Math.abs(credentials.expires - expectedExpiry)).toBeLessThanOrEqual(2000);
	});

	it("times out when the browser login never completes", async () => {
		vi.useFakeTimers();

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.startsWith(POLL_URL)) {
					return new Response("Not found", { status: 404 });
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const loginPromise = loginCursor({ onAuth: () => {} });
		const rejection = loginPromise.then(
			() => {
				throw new Error("expected the login to reject");
			},
			(error: unknown) => error,
		);

		// Drive past the 10 minute deadline in poll-interval steps.
		for (let i = 0; i < 310; i++) {
			await vi.advanceTimersByTimeAsync(2000);
		}
		const error = await rejection;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/timed out/);
	});

	it("refreshes tokens via the exchange endpoint with a Bearer refresh token", async () => {
		let request: { url: string; body: string; authorization: string } | undefined;
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			request = {
				url: input instanceof Request ? input.url : String(input),
				body: String(init?.body),
				authorization: new Headers(init?.headers).get("Authorization") ?? "",
			};
			return Response.json({
				accessToken: jwtWithExp(exp),
				refreshToken: "cursor_new_refresh_token",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshCursorToken("cursor_old_refresh_token");

		expect(request?.url).toBe(EXCHANGE_URL);
		expect(request?.body).toBe("{}");
		expect(request?.authorization).toBe("Bearer cursor_old_refresh_token");
		expect(credentials.access).toBe(jwtWithExp(exp));
		expect(credentials.refresh).toBe("cursor_new_refresh_token");
		// Expiry comes from the JWT exp claim, minus the safety margin.
		expect(credentials.expires).toBe(exp * 1000 - 5 * 60 * 1000);
	});

	it("registers a built-in OAuth provider for cursor", () => {
		const ids = getOAuthProviders().map((provider) => provider.id);
		expect(ids).toContain("cursor");

		expect(getOAuthProvider("cursor")?.name).toBe("Cursor");

		const credentials = { access: "a", refresh: "r", expires: Date.now() + 1000 };
		expect(getOAuthProvider("cursor")?.getApiKey(credentials as never)).toBe("a");
	});
});
