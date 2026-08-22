import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginCursor, refreshCursorToken } from "../src/utils/oauth/cursor.js";
import { getOAuthProvider, getOAuthProviders } from "../src/utils/oauth/index.js";

const POLL_URL = "https://api2.cursor.sh/auth/poll";
const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const TOKEN_URL = "https://api2.cursor.sh/oauth/token";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("Cursor OAuth PKCE flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("opens the browser login, polls, and exchanges the access token", async () => {
		vi.useFakeTimers();

		let pollRequests = 0;
		let exchangeRequest: { url: string; body: string } | undefined;

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === POLL_URL) {
				pollRequests++;
				expect(init?.method).toBe("POST");
				expect(new Headers(init?.headers).get("Content-Type")).toContain("application/json");
				const body = JSON.parse(String(init?.body)) as { uuid?: string };
				expect(typeof body.uuid).toBe("string");
				return pollRequests === 1 ? jsonResponse({}) : jsonResponse({ accessToken: "cursor_access_token" });
			}

			if (url === EXCHANGE_URL) {
				exchangeRequest = { url, body: String(init?.body) };
				return jsonResponse({
					accessToken: "cursor_api_key",
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
		expect(authUrls[0]).toMatch(/^https:\/\/cursor\.com\/loginDeepControl\?challenge=.+&uuid=.+$/);
		const challenge = new URL(authUrls[0]).searchParams.get("challenge");
		// S256 challenge: base64url of a SHA-256 digest is 43 characters.
		expect(challenge).toHaveLength(43);
		expect(pollRequests).toBe(2);
		expect(exchangeRequest?.body).toBe(JSON.stringify({ accessToken: "cursor_access_token" }));

		expect(credentials.access).toBe("cursor_api_key");
		expect(credentials.refresh).toBe("cursor_refresh_token");
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("times out when the browser login never completes", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === POLL_URL) {
				return jsonResponse({});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

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

	it("refreshes tokens with the refresh_token grant", async () => {
		let request: { url: string; body: string; contentType: string } | undefined;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			request = {
				url: getUrl(input),
				body: String(init?.body),
				contentType: new Headers(init?.headers).get("Content-Type") ?? "",
			};
			return jsonResponse({
				access_token: "cursor_new_access_token",
				refresh_token: "cursor_new_refresh_token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshCursorToken("cursor_old_refresh_token");

		expect(request?.url).toBe(TOKEN_URL);
		expect(request?.contentType).toContain("application/x-www-form-urlencoded");
		const params = new URLSearchParams(request?.body);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("cursor_old_refresh_token");
		expect(credentials.access).toBe("cursor_new_access_token");
		expect(credentials.refresh).toBe("cursor_new_refresh_token");
	});

	it("registers a built-in OAuth provider for cursor", () => {
		const ids = getOAuthProviders().map((provider) => provider.id);
		expect(ids).toContain("cursor");

		expect(getOAuthProvider("cursor")?.name).toBe("Cursor");

		const credentials = { access: "a", refresh: "r", expires: Date.now() + 1000 };
		expect(getOAuthProvider("cursor")?.getApiKey(credentials as never)).toBe("a");
	});
});
