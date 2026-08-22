import { afterEach, describe, expect, it, vi } from "bun:test";
import { getOAuthProvider, getOAuthProviders } from "../src/utils/oauth/index.js";
import { loginOpenCode, refreshOpenCodeToken } from "../src/utils/oauth/opencode.js";

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

describe("OpenCode OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("polls the token endpoint until the device is authorized", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }),
			jsonResponse({ error: "slow_down", interval: 10 }),
			jsonResponse({
				access_token: "oc_access_token",
				refresh_token: "oc_refresh_token",
				token_type: "bearer",
				expires_in: 3600,
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://console.opencode.ai/auth/device/code") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=opencode-cli");
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://console.opencode.ai/device",
					verification_uri_complete: "https://console.opencode.ai/device?code=ABCD-EFGH",
					interval: 5,
					expires_in: 900,
				});
			}

			if (url === "https://console.opencode.ai/auth/device/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(String(init?.body)).toContain("device_code=device-code");
				expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
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
		const loginPromise = loginOpenCode({
			onAuth: (url) => authUrls.push(url),
			onProgress: () => {},
		});

		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(10000);

		const credentials = await loginPromise;

		expect(credentials.access).toBe("oc_access_token");
		expect(credentials.refresh).toBe("oc_refresh_token");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(authUrls).toEqual(["https://console.opencode.ai/device?code=ABCD-EFGH"]);
		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10000, startTime.getTime() + 20000]);
	});

	it("rejects when the device flow times out", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://console.opencode.ai/auth/device/code") {
				return jsonResponse({
					device_code: "device-code",
					verification_uri_complete: "https://console.opencode.ai/device?code=ABCD-EFGH",
					interval: 5,
					expires_in: 1,
				});
			}
			if (url === "https://console.opencode.ai/auth/device/token") {
				return jsonResponse({ error: "authorization_pending" });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginOpenCode({
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

	it("refreshes tokens with the refresh_token grant at the same token URL", async () => {
		const requests: { url: string; body: string }[] = [];
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			requests.push({ url: getUrl(input), body: String(init?.body) });
			return jsonResponse({
				access_token: "oc_new_access_token",
				refresh_token: "oc_new_refresh_token",
				token_type: "bearer",
				expires_in: 7200,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshOpenCodeToken("oc_old_refresh_token");

		expect(requests).toEqual([
			{
				url: "https://console.opencode.ai/auth/device/token",
				body: "client_id=opencode-cli&refresh_token=oc_old_refresh_token&grant_type=refresh_token",
			},
		]);
		expect(credentials.access).toBe("oc_new_access_token");
		expect(credentials.refresh).toBe("oc_new_refresh_token");
		expect(credentials.expires).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
	});

	it("registers built-in OAuth providers for opencode and opencode-go", () => {
		const ids = getOAuthProviders().map((provider) => provider.id);
		expect(ids).toContain("opencode");
		expect(ids).toContain("opencode-go");

		expect(getOAuthProvider("opencode")?.name).toBe("OpenCode Zen");
		expect(getOAuthProvider("opencode-go")?.name).toBe("OpenCode Go");

		const credentials = { access: "a", refresh: "r", expires: Date.now() + 1000 };
		expect(getOAuthProvider("opencode")?.getApiKey(credentials as never)).toBe("a");
	});
});
