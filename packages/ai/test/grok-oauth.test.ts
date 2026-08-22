import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginGrok, refreshGrokToken } from "../src/utils/oauth/grok.js";
import { getOAuthProvider, getOAuthProviders } from "../src/utils/oauth/index.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
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

describe("Grok OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("sends PKCE and scope, then polls the token endpoint until authorized", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const pollTimes: number[] = [];
		let deviceCodeRequest: URLSearchParams | undefined;
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }),
			jsonResponse({ error: "slow_down", interval: 10 }),
			jsonResponse({
				access_token: "xai_access_token",
				refresh_token: "xai_refresh_token",
				token_type: "bearer",
				expires_in: 3600,
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.x.ai/oauth2/device/code") {
				deviceCodeRequest = new URLSearchParams(String(init?.body));
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?code=ABCD-EFGH",
					interval: 5,
					expires_in: 900,
				});
			}

			if (url === "https://auth.x.ai/oauth2/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("device_code")).toBe("device-code");
				expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const authUrls: string[] = [];
		const loginPromise = loginGrok({
			onAuth: (url) => authUrls.push(url),
			onProgress: () => {},
		});

		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(10000);

		const credentials = await loginPromise;

		expect(deviceCodeRequest?.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
		expect(deviceCodeRequest?.get("scope")).toContain("grok-cli:access");
		expect(deviceCodeRequest?.get("code_challenge_method")).toBe("S256");
		expect(deviceCodeRequest?.get("code_challenge")).toBeTruthy();

		expect(credentials.access).toBe("xai_access_token");
		expect(credentials.refresh).toBe("xai_refresh_token");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(authUrls).toEqual(["https://auth.x.ai/device?code=ABCD-EFGH"]);
		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10000, startTime.getTime() + 20000]);
	});

	it("rejects when the device flow times out", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://auth.x.ai/oauth2/device/code") {
				return jsonResponse({
					device_code: "device-code",
					verification_uri_complete: "https://auth.x.ai/device?code=ABCD-EFGH",
					interval: 5,
					expires_in: 1,
				});
			}
			if (url === "https://auth.x.ai/oauth2/token") {
				return jsonResponse({ error: "authorization_pending" });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGrok({
			onAuth: () => {},
		});
		const rejection = loginPromise.then(
			() => {
				throw new Error("expected the device flow login to reject");
			},
			(error: unknown) => error,
		);

		await vi.advanceTimersByTimeAsync(5000);
		const error = await rejection;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/Device flow timed out/);
	});

	it("refreshes tokens with the refresh_token grant", async () => {
		const requests: { url: string; body: string }[] = [];
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			requests.push({ url: getUrl(input), body: String(init?.body) });
			return jsonResponse({
				access_token: "xai_new_access_token",
				refresh_token: "xai_new_refresh_token",
				token_type: "bearer",
				expires_in: 7200,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshGrokToken("xai_old_refresh_token");

		expect(requests).toEqual([
			{
				url: "https://auth.x.ai/oauth2/token",
				body: "client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=xai_old_refresh_token&grant_type=refresh_token",
			},
		]);
		expect(credentials.access).toBe("xai_new_access_token");
		expect(credentials.refresh).toBe("xai_new_refresh_token");
		expect(credentials.expires).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
	});

	it("deduplicates concurrent refreshes of the same single-use token", async () => {
		let tokenRequests = 0;
		const fetchMock = vi.fn(async (): Promise<Response> => {
			tokenRequests++;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return jsonResponse({
				access_token: `xai_access_${tokenRequests}`,
				refresh_token: `xai_refresh_${tokenRequests}`,
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const [first, second] = await Promise.all([
			refreshGrokToken("xai_shared_refresh_token"),
			refreshGrokToken("xai_shared_refresh_token"),
		]);

		expect(tokenRequests).toBe(1);
		expect(first).toEqual(second);
	});

	it("registers a built-in OAuth provider for grok", () => {
		const ids = getOAuthProviders().map((provider) => provider.id);
		expect(ids).toContain("grok");

		expect(getOAuthProvider("grok")?.name).toBe("Grok (SuperGrok)");

		const credentials = { access: "a", refresh: "r", expires: Date.now() + 1000 };
		expect(getOAuthProvider("grok")?.getApiKey(credentials as never)).toBe("a");
	});
});
