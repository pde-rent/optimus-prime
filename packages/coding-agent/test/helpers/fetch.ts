/**
 * Unified fetch stubs for skill/service tests. No test should touch the network;
 * every variant records the requests it saw.
 */

/** Replace globalThis.fetch with a stub whose handler receives (url, init). Returns recorded calls. */
export function stubRawFetch(
	handler: (url: string, init?: RequestInit) => unknown,
): { url: string; init?: RequestInit }[] {
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	}) as unknown as typeof fetch;
	return calls;
}

/**
 * Replace globalThis.fetch with a stub whose handler receives (url, parsedJsonBody, init).
 * JSON body parsing matches what JSON-RPC style callers post. Returns recorded calls.
 */
export function stubJsonFetch(
	handler: (url: string, body: any, init?: RequestInit) => unknown,
): { url: string; body: any; init?: RequestInit }[] {
	const calls: { url: string; body: any; init?: RequestInit }[] = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url: String(url), body, init });
		return handler(String(url), body, init);
	}) as unknown as typeof fetch;
	return calls;
}

/** Replace globalThis.fetch with a stub that only records requested URLs. */
export function stubUrlFetch(handler: (url: string, init?: RequestInit) => unknown): string[] {
	const calls: string[] = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push(String(url));
		return handler(String(url), init);
	}) as unknown as typeof fetch;
	return calls;
}

/**
 * A minimal Response-like object. json=true makes json() throw like a non-JSON
 * response would; headers feed a real Headers instance.
 */
export function fakeResponse(
	body: unknown,
	{ status = 200, json = true, headers = {} as Record<string, string> } = {},
) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(headers),
		json: async () => {
			if (!json) throw new SyntaxError("not json");
			return body;
		},
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}
