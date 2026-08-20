import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as rpcSkill from "../skills/rpc/skill.js";

const {
	default: createSkill,
	clearRpcCache,
	domainLabel,
	endpointTier,
	fromUnits,
	normalizeCall,
	toBigInt,
	toUnits,
} = rpcSkill;

type ErrorValue = { error: string; code?: number; status?: number; data?: unknown };
type Probe = { url: string; ok: boolean; ms: number; detail: string; tier: string };

const rpc = createSkill();
const URL_ = "https://node.test/rpc";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	// The registry and pick memos live at module scope, i.e. for the whole session.
	clearRpcCache();
});

/** Stub `fetch`, recording every request made. No test here touches the network. */
function stubFetch(handler: (url: string, body: any, init?: RequestInit) => unknown) {
	const calls: { url: string; body: any; init?: RequestInit }[] = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url: String(url), body, init });
		return handler(String(url), body, init);
	}) as unknown as typeof fetch;
	return calls;
}

function response(body: unknown, { status = 200, json = true } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			if (!json) throw new SyntaxError("not json");
			return body;
		},
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

describe("rpc.call", () => {
	it("posts a JSON-RPC 2.0 envelope and returns the result field", async () => {
		const calls = stubFetch((_url, body) => response({ jsonrpc: "2.0", id: body.id, result: "0x10" }));
		const out = await rpc.call(URL_, "eth_blockNumber");

		expect(out).toBe("0x10");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(URL_);
		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].body.jsonrpc).toBe("2.0");
		expect(calls[0].body.method).toBe("eth_blockNumber");
		expect(calls[0].body.params).toEqual([]);
		expect(typeof calls[0].body.id).toBe("number");
	});

	it("passes params through unchanged", async () => {
		const calls = stubFetch((_url, body) => response({ id: body.id, result: null }));
		await rpc.call(URL_, "eth_call", [{ to: "0xabc", data: "0x01" }, "latest"]);
		expect(calls[0].body.params).toEqual([{ to: "0xabc", data: "0x01" }, "latest"]);
	});

	it("returns a null result rather than treating it as missing", async () => {
		stubFetch((_url, body) => response({ id: body.id, result: null }));
		expect(await rpc.call(URL_, "eth_getTransactionByHash", ["0x00"])).toBeNull();
	});

	it("returns the RPC error as a value, with its code and data", async () => {
		stubFetch((_url, body) =>
			response({ id: body.id, error: { code: -32000, message: "execution reverted", data: "0xdead" } }),
		);
		const out = (await rpc.call(URL_, "eth_call", [])) as ErrorValue;

		expect(out.error).toContain("execution reverted");
		expect(out.error).toContain("eth_call");
		expect(out.code).toBe(-32000);
		expect(out.data).toBe("0xdead");
	});

	it("returns an HTTP failure as a value carrying the status", async () => {
		stubFetch(() => response("rate limited", { status: 429 }));
		const out = (await rpc.call(URL_, "eth_blockNumber")) as ErrorValue;

		expect(out.status).toBe(429);
		expect(out.error).toContain("HTTP 429");
		expect(out.error).toContain("rate limited");
	});

	it("returns a network failure as a value instead of throwing", async () => {
		stubFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const out = (await rpc.call(URL_, "eth_blockNumber")) as ErrorValue;
		expect(out.error).toContain("ECONNREFUSED");
	});

	it("names the timeout option when the request times out", async () => {
		stubFetch(() => {
			const e = new Error("The operation was aborted");
			e.name = "TimeoutError";
			throw e;
		});
		const out = (await rpc.call(URL_, "eth_blockNumber")) as ErrorValue;
		expect(out.error).toContain("timed out");
		expect(out.error).toContain("timeout");
	});

	it("returns a value for a non-JSON body", async () => {
		stubFetch(() => response("<html>proxy error</html>", { json: false }));
		const out = (await rpc.call(URL_, "eth_blockNumber")) as ErrorValue;
		expect(out.error).toContain("non-JSON");
	});

	it("returns a value when the response has neither result nor error", async () => {
		stubFetch((_url, body) => response({ id: body.id, jsonrpc: "2.0" }));
		const out = (await rpc.call(URL_, "eth_blockNumber")) as ErrorValue;
		expect(out.error).toContain("malformed");
	});

	it("sends an AbortSignal and merges extra headers", async () => {
		const calls = stubFetch((_url, body) => response({ id: body.id, result: 1 }));
		await rpc.call(URL_, "m", [], { timeout: 3, headers: { "X-API-Key": "k" } });

		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("k");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("throws a TypeError on a bad url or method - those are caller bugs", async () => {
		expect(rpc.call(undefined as any, "m")).rejects.toThrow(TypeError);
		expect(rpc.call(URL_, "")).rejects.toThrow(TypeError);
		expect(rpc.call(URL_, "m", "not-params" as any)).rejects.toThrow(TypeError);
	});
});

describe("rpc.batch", () => {
	it("sends one request for N calls and returns results in call order", async () => {
		const calls = stubFetch((_url, body) =>
			// Answer out of order on purpose: matching must be by id, not position.
			response([...body].reverse().map((r: any) => ({ id: r.id, result: `${r.method}-ok` }))),
		);
		const out = await rpc.batch(URL_, [
			{ method: "a" },
			["b", [1]],
			"c", // bare method name
		]);

		expect(calls).toHaveLength(1); // ONE round trip
		expect(calls[0].body).toHaveLength(3);
		expect(calls[0].body[1].params).toEqual([1]);
		expect(out).toEqual(["a-ok", "b-ok", "c-ok"]);
	});

	it("isolates a single failing call - siblings keep their results", async () => {
		stubFetch((_url, body) =>
			response(
				body.map((r: any) =>
					r.method === "bad"
						? { id: r.id, error: { code: -32601, message: "method not found" } }
						: { id: r.id, result: 7 },
				),
			),
		);
		const out = (await rpc.batch(URL_, ["good", "bad", "good"])) as [number, ErrorValue, number];

		expect(out[0]).toBe(7);
		expect(out[2]).toBe(7);
		expect(out[1].error).toContain("method not found");
		expect(out[1].code).toBe(-32601);
	});

	it("fills every entry with the same error when the request itself fails", async () => {
		stubFetch(() => response("boom", { status: 500 }));
		const out = (await rpc.batch(URL_, ["a", "b"])) as ErrorValue[];

		expect(out).toHaveLength(2); // shape never changes
		expect(out.every((r) => r.error.includes("HTTP 500"))).toBe(true);
		expect(out[0].status).toBe(500);
	});

	it("flags a call with no matching response", async () => {
		stubFetch((_url, body) => response([{ id: body[0].id, result: 1 }]));
		const out = (await rpc.batch(URL_, ["a", "b"])) as [number, ErrorValue];

		expect(out[0]).toBe(1);
		expect(out[1].error).toContain("no matching response");
	});

	it("handles a server that answers a batch with a bare object", async () => {
		stubFetch(() => response({ error: { code: -32600, message: "batch unsupported" } }));
		const out = (await rpc.batch(URL_, ["a", "b"])) as ErrorValue[];

		expect(out).toHaveLength(2);
		expect(out.every((r) => r.error.includes("batch unsupported"))).toBe(true);
	});

	it("returns [] for no calls without touching the network", async () => {
		const calls = stubFetch(() => response([]));
		expect(await rpc.batch(URL_, [])).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("throws on a non-array or an unrecognised call shape", async () => {
		expect(rpc.batch(URL_, "a" as any)).rejects.toThrow(TypeError);
		expect(rpc.batch(URL_, [42 as any])).rejects.toThrow(TypeError);
	});

	it("normalizeCall accepts all three shapes", () => {
		expect(normalizeCall("m", 0)).toEqual({ method: "m", params: [] });
		expect(normalizeCall(["m", [1]], 0)).toEqual({ method: "m", params: [1] });
		expect(normalizeCall({ method: "m", params: { a: 1 } }, 0)).toEqual({ method: "m", params: { a: 1 } });
	});
});

describe("rpc.toBigInt", () => {
	it("parses hex quantities, decimal strings, bigints and safe integers", () => {
		expect(toBigInt("0xde0b6b3a7640000")).toBe(1000000000000000000n);
		expect(toBigInt("0XFF")).toBe(255n);
		expect(toBigInt("31")).toBe(31n);
		expect(toBigInt(" 0x1f ")).toBe(31n);
		expect(toBigInt(42)).toBe(42n);
		expect(toBigInt(7n)).toBe(7n);
		expect(toBigInt("-0x1f")).toBe(-31n);
		expect(toBigInt("-12")).toBe(-12n);
	});

	it("survives a uint256 near 2^256 - 1", () => {
		const maxUint256 = 2n ** 256n - 1n;
		const hex = `0x${maxUint256.toString(16)}`;
		expect(toBigInt(hex)).toBe(maxUint256);
		expect(toBigInt(maxUint256.toString())).toBe(maxUint256);
		// The value a float would have mangled beyond recognition.
		expect(toBigInt(hex).toString()).toBe(
			"115792089237316195423570985008687907853269984665640564039457584007913129639935",
		);
	});

	it("rejects values that have already lost precision or were never integers", () => {
		expect(() => toBigInt(1.5)).toThrow(TypeError);
		expect(() => toBigInt(2 ** 53)).toThrow(/MAX_SAFE_INTEGER/);
		expect(() => toBigInt("")).toThrow(TypeError);
		expect(() => toBigInt("1.5")).toThrow(TypeError);
		expect(() => toBigInt("0xzz")).toThrow(TypeError);
		expect(() => toBigInt(null as any)).toThrow(TypeError);
		expect(() => toBigInt({} as any)).toThrow(TypeError);
	});
});

describe("rpc.fromUnits", () => {
	it("scales down exactly, at any magnitude", () => {
		expect(fromUnits("0xde0b6b3a7640000", 18)).toBe("1");
		expect(fromUnits(1n, 18)).toBe("0.000000000000000001");
		expect(fromUnits(123456789n, 6)).toBe("123.456789");
		expect(fromUnits(1500000n, 6)).toBe("1.5"); // trailing zeros dropped
		expect(fromUnits(500n, 3)).toBe("0.5"); // leading zero kept
		expect(fromUnits(42n, 0)).toBe("42");
		expect(fromUnits(0n, 18)).toBe("0");
		expect(fromUnits(-1500000n, 6)).toBe("-1.5");
	});

	it("keeps every digit of a uint256, where a float would not", () => {
		const maxUint256 = 2n ** 256n - 1n;
		const out = fromUnits(maxUint256, 18);
		expect(out).toBe("115792089237316195423570985008687907853269984665640564039457.584007913129639935");
		// Round-tripping through the string is exact; a float round trip is not.
		expect(toUnits(out, 18)).toBe(maxUint256);
		expect(String(Number(out))).not.toBe(out);
	});

	it("keeps a 1-wei difference visible, which a float loses", () => {
		const a = 10n ** 18n;
		const b = a + 1n;
		expect(fromUnits(a, 18)).not.toBe(fromUnits(b, 18));
		expect(Number(fromUnits(a, 18)) === Number(fromUnits(b, 18))).toBe(true); // the bug being avoided
	});

	it("rejects a bad decimals argument", () => {
		expect(() => fromUnits(1n, -1)).toThrow(TypeError);
		expect(() => fromUnits(1n, 1.5)).toThrow(TypeError);
		expect(() => fromUnits(1n, 1000)).toThrow(TypeError);
	});
});

describe("rpc.toUnits", () => {
	it("scales up exactly, including values a float cannot hold", () => {
		expect(toUnits("1", 18)).toBe(1000000000000000000n);
		expect(toUnits("1.5", 18)).toBe(1500000000000000000n);
		expect(toUnits("0.000001", 6)).toBe(1n);
		expect(toUnits(".5", 2)).toBe(50n);
		expect(toUnits("-1.5", 6)).toBe(-1500000n);
		expect(toUnits("0", 18)).toBe(0n);
		expect(toUnits(3n, 6)).toBe(3000000n);
		expect(toUnits(2.5, 2)).toBe(250n);
	});

	it("accepts the exponent form JS itself produces", () => {
		expect(toUnits("1e-6", 6)).toBe(1n);
		expect(toUnits("1.5e3", 0)).toBe(1500n);
		expect(toUnits(String(1e21), 0)).toBe(10n ** 21n);
		expect(toUnits("1E2", 2)).toBe(10000n);
	});

	it("is exact for decimal strings a float would round", () => {
		// 0.1 + 0.2 is not 0.3 in binary floating point; the string path never touches a double.
		expect(toUnits("0.1", 18) + toUnits("0.2", 18)).toBe(toUnits("0.3", 18));
		expect(toUnits("0.1", 18)).toBe(100000000000000000n);
		// 20 significant digits: past what a double can represent.
		expect(toUnits("1.23456789012345678", 18)).toBe(1234567890123456780n);
		expect(toUnits("115792089237316195423570985008687907853269984665640564039457.584007913129639935", 18)).toBe(
			2n ** 256n - 1n,
		);
	});

	it("throws rather than silently truncating excess precision", () => {
		expect(() => toUnits("0.0000001", 6)).toThrow(RangeError);
		expect(() => toUnits("1.005", 2)).toThrow(/more than 2 decimal places/);
		// Excess zeros change nothing, so they are dropped instead.
		expect(toUnits("1.5000", 2)).toBe(150n);
		expect(toUnits("1.000000", 0)).toBe(1n);
	});

	it("rejects inputs that are not decimal numbers", () => {
		expect(() => toUnits("0x1f", 18)).toThrow(TypeError);
		expect(() => toUnits("abc", 18)).toThrow(TypeError);
		expect(() => toUnits(".", 18)).toThrow(TypeError);
		expect(() => toUnits("", 18)).toThrow(TypeError);
		expect(() => toUnits(Number.NaN, 18)).toThrow(TypeError);
		expect(() => toUnits(Number.POSITIVE_INFINITY, 18)).toThrow(TypeError);
		expect(() => toUnits(null as any, 18)).toThrow(TypeError);
		expect(() => toUnits("1", 300)).toThrow(TypeError);
	});

	it("round-trips against fromUnits", () => {
		for (const [raw, decimals] of [
			[0n, 18],
			[1n, 18],
			[10n ** 30n + 7n, 18],
			[123456789n, 6],
			[-42n, 8],
			[2n ** 256n - 1n, 18],
		] as const) {
			expect(toUnits(fromUnits(raw, decimals), decimals)).toBe(raw);
		}
	});
});

const CHAINLIST = "https://chainlist.org/rpcs.json";

/**
 * A registry fixture in the real document's shape: `rpc` entries as both plain strings and
 * `{url}` objects, an API-key template, a `wss://` entry, and one of the malformed rows the live
 * registry actually carries.
 */
const REGISTRY = [
	{
		chainId: 1,
		name: "Ethereum Mainnet",
		chain: "ETH",
		shortName: "eth",
		chainSlug: "ethereum",
		isTestnet: false,
		rpc: [
			"https://rpc.ethereum.org",
			{ url: "https://ethereum-rpc.publicnode.com", tracking: "none" },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the registry ships this placeholder literally
			{ url: "https://eth-mainnet.example.com/v2/${API_KEY}" },
			"wss://ethereum-rpc.publicnode.com",
			"website:https://not-a-node.example",
			{ url: "https://nodes.example.net" },
		],
	},
	{
		chainId: 11417,
		name: "Anq World Testnet",
		shortName: "eth",
		isTestnet: true,
		rpc: [{ url: "https://testnet.example" }],
	},
	{ chainId: 999, name: "Twin", shortName: "twin", isTestnet: false, rpc: [] },
	{ chainId: 998, name: "Twin", shortName: "twin2", isTestnet: false, rpc: [] },
];

const OFFICIAL = "https://rpc.ethereum.org";
const PROVIDER = "https://ethereum-rpc.publicnode.com";
const OTHER = "https://nodes.example.net";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serve the registry, then answer every probe from `replies` (keyed by URL). A missing key
 * answers `0x1`, i.e. a healthy Ethereum node.
 */
function stubChain(replies: Record<string, unknown> = {}) {
	return stubFetch(async (url, body) => {
		if (url === CHAINLIST) return response(REGISTRY);
		const reply = replies[url];
		if (typeof reply === "function") return (reply as (b: any) => unknown)(body);
		return response({ id: body?.id, result: reply ?? "0x1" });
	});
}

describe("rpc.endpoints", () => {
	it("parses both registry entry shapes and drops templated, wss and malformed rows", async () => {
		const calls = stubChain();
		const out = (await rpc.endpoints(1)) as Probe[];

		expect(calls[0].url).toBe(CHAINLIST);
		expect(out.map((p) => p.url).sort()).toEqual([PROVIDER, OTHER, OFFICIAL].sort());
		expect(out.every((p) => p.ok)).toBe(true);
		expect(out[0].detail).toBe("chainId 1");
		// eth_chainId, once per surviving endpoint.
		expect(calls.slice(1).map((c) => c.body.method)).toEqual(["eth_chainId", "eth_chainId", "eth_chainId"]);
	});

	it("marks an endpoint on the wrong chain unhealthy and sorts it last", async () => {
		stubChain({ [OTHER]: "0x5" });
		const out = (await rpc.endpoints(1)) as Probe[];
		const wrong = out.find((p) => p.url === OTHER) as Probe;

		expect(wrong.ok).toBe(false);
		expect(wrong.detail).toContain("wrong chain (5, want 1)");
		expect(out.at(-1)?.url).toBe(OTHER);
	});

	it("ranks an official-looking domain above a known provider above anything else", async () => {
		stubChain();
		const out = (await rpc.endpoints(1)) as Probe[];

		expect(out.map((p) => p.url)).toEqual([OFFICIAL, PROVIDER, OTHER]);
		expect(out.map((p) => p.tier)).toEqual(["official", "provider", "other"]);
	});

	it("puts a healthy fallback above a dead official endpoint - health beats provenance", async () => {
		stubChain({
			[OFFICIAL]: () => {
				throw new Error("ECONNREFUSED");
			},
		});
		const out = (await rpc.endpoints(1)) as Probe[];

		expect(out[0].url).toBe(PROVIDER);
		expect(out.at(-1)).toMatchObject({ url: OFFICIAL, ok: false, tier: "official" });
	});

	it("sorts healthy-then-fastest with { rank: false }, still reporting the tier", async () => {
		stubChain({
			[OFFICIAL]: async (body: any) => {
				await sleep(40);
				return response({ id: body.id, result: "0x1" });
			},
		});
		const out = (await rpc.endpoints(1, { rank: false })) as Probe[];

		expect(out.at(-1)?.url).toBe(OFFICIAL); // slowest, despite being official
		expect(out.find((p) => p.url === OFFICIAL)?.tier).toBe("official");
	});

	it("promotes a host named in officialHosts above the provider tier", async () => {
		stubChain();
		const out = (await rpc.endpoints(1, { officialHosts: ["nodes.example.net"] })) as Probe[];

		expect(out.find((p) => p.url === OTHER)?.tier).toBe("official");
		expect(out.map((p) => p.url)).toEqual([OFFICIAL, OTHER, PROVIDER]);
	});

	it("probes at most { limit } candidates, best-looking first", async () => {
		const calls = stubChain();
		const out = (await rpc.endpoints(1, { limit: 1 })) as Probe[];

		expect(out.map((p) => p.url)).toEqual([OFFICIAL]);
		expect(calls).toHaveLength(2); // registry + one probe
	});

	it("resolves a chain by name and prefers a mainnet over a testnet of the same short name", async () => {
		const calls = stubChain();
		const bySlug = (await rpc.endpoints("ethereum")) as Probe[];
		expect(bySlug.map((p) => p.url).sort()).toEqual([PROVIDER, OTHER, OFFICIAL].sort());

		const byShortName = (await rpc.endpoints("ETH")) as Probe[];
		expect(byShortName.every((p) => p.ok)).toBe(true);
		expect(calls.some((c) => c.url === "https://testnet.example")).toBe(false);
	});

	it("returns an error value for an unknown, ambiguous or empty chain", async () => {
		stubChain();
		expect(((await rpc.endpoints(4242)) as ErrorValue).error).toContain("not in the registry");
		expect(((await rpc.endpoints("nosuchchain")) as ErrorValue).error).toContain("no chain named");

		const ambiguous = (await rpc.endpoints("twin")) as ErrorValue;
		expect(ambiguous.error).toContain("matches 2 chains");
		expect(ambiguous.error).toContain("999 (Twin)");

		expect(((await rpc.endpoints(999)) as ErrorValue).error).toContain("no keyless http endpoint");
	});

	it("fetches the registry once per session and re-fetches only on registryRefresh", async () => {
		const calls = stubChain();
		await rpc.endpoints(1);
		await rpc.endpoints("ethereum");
		expect(calls.filter((c) => c.url === CHAINLIST)).toHaveLength(1);

		await rpc.endpoints(1, { registryRefresh: true });
		expect(calls.filter((c) => c.url === CHAINLIST)).toHaveLength(2);
	});

	it("returns a registry failure as a value without poisoning the session", async () => {
		let attempt = 0;
		stubFetch(async (url, body) => {
			if (url !== CHAINLIST) return response({ id: body?.id, result: "0x1" });
			attempt += 1;
			return attempt === 1 ? response("upstream down", { status: 503 }) : response(REGISTRY);
		});

		expect(((await rpc.endpoints(1)) as ErrorValue).error).toContain("chain registry");
		expect(((await rpc.endpoints(1)) as Probe[]).every((p) => p.ok)).toBe(true);
		expect(attempt).toBe(2);
	});

	it("probes Solana seeds with getSlot and never reads the registry", async () => {
		const calls = stubFetch((_url, body) => response({ id: body.id, result: 315_000_000 }));
		const out = (await rpc.endpoints("solana", { limit: 2 })) as Probe[];

		expect(calls.some((c) => c.url === CHAINLIST)).toBe(false);
		expect(calls[0].body.method).toBe("getSlot");
		expect(out[0]).toMatchObject({ url: "https://api.mainnet-beta.solana.com", ok: true, tier: "official" });
		expect(out[0].detail).toBe("slot 315000000");
	});

	it("probes Tron seeds over REST and never reads the registry", async () => {
		const calls = stubFetch(() => response({ block_header: { raw_data: { number: 71_000_000 } } }));
		const out = (await rpc.endpoints("tron", { limit: 1 })) as Probe[];

		expect(calls.some((c) => c.url === CHAINLIST)).toBe(false);
		expect(calls[0].url).toBe("https://api.trongrid.io/wallet/getnowblock");
		expect(calls[0].body).toEqual({}); // Tron wants a body even when it is empty
		expect(out[0]).toMatchObject({ url: "https://api.trongrid.io", ok: true, tier: "official" });
		expect(out[0].detail).toBe("block 71000000");
	});

	it("reports an unusable Tron reply as unhealthy", async () => {
		stubFetch(() => response({ Error: "nope" }));
		const out = (await rpc.endpoints("tron", { limit: 1 })) as Probe[];
		expect(out[0]).toMatchObject({ ok: false, detail: "no block in reply" });
	});

	it("throws a TypeError on an argument that cannot name a chain", async () => {
		expect(rpc.endpoints(undefined as any)).rejects.toThrow(TypeError);
		expect(rpc.endpoints(0)).rejects.toThrow(TypeError);
		expect(rpc.endpoints(-1)).rejects.toThrow(TypeError);
		expect(rpc.endpoints(1.5)).rejects.toThrow(TypeError);
		expect(rpc.endpoints("  ")).rejects.toThrow(TypeError);
		expect(rpc.endpoints({} as any)).rejects.toThrow(TypeError);
	});
});

describe("endpointTier", () => {
	it("judges the registrable domain, not the subdomain", () => {
		expect(endpointTier("https://api.mainnet-beta.solana.com", { tokens: ["solana"] })).toBe("official");
		expect(endpointTier("https://api.trongrid.io", { tokens: ["tron"] })).toBe("official");
		// The failure the heuristic exists to avoid: any host can name a chain in a subdomain.
		expect(endpointTier("https://ethereum-rpc.publicnode.com", { tokens: ["ethereum"] })).toBe("provider");
		expect(endpointTier("https://solana.drpc.org", { tokens: ["solana"] })).toBe("provider");
		expect(endpointTier("https://nodes.example.net", { tokens: ["ethereum"] })).toBe("other");
		expect(endpointTier("not a url", { tokens: ["ethereum"] })).toBe("other");
		expect(domainLabel("https://arb1.arbitrum.io/rpc")).toBe("arbitrum");
	});
});

describe("rpc.pick", () => {
	it("returns the best URL and memoises it for the session", async () => {
		const calls = stubChain();
		expect(await rpc.pick(1)).toBe(OFFICIAL);

		const after = calls.length;
		expect(await rpc.pick(1)).toBe(OFFICIAL); // no round trip at all
		expect(calls).toHaveLength(after);
	});

	it("re-probes with { refresh: true }", async () => {
		const calls = stubChain();
		await rpc.pick(1);
		const after = calls.length;

		await rpc.pick(1, { refresh: true });
		expect(calls.length).toBeGreaterThan(after);
	});

	it("skips a dead endpoint and picks the healthy one", async () => {
		stubChain({
			[OFFICIAL]: () => {
				throw new Error("ECONNREFUSED");
			},
		});
		expect(await rpc.pick(1)).toBe(PROVIDER);
	});

	it("returns an error value when nothing is healthy, and does not cache it", async () => {
		const calls = stubChain({ [OFFICIAL]: "0x5", [PROVIDER]: "0x5", [OTHER]: "0x5" });
		const out = (await rpc.pick(1)) as ErrorValue;

		expect(out.error).toContain("no healthy endpoint");
		const after = calls.length;
		await rpc.pick(1);
		expect(calls.length).toBeGreaterThan(after);
	});

	it("passes a registry error straight through", async () => {
		stubFetch(() => response("gone", { status: 503 }));
		expect(((await rpc.pick(1)) as ErrorValue).error).toContain("chain registry");
	});
});

describe("rpc.tron", () => {
	it("posts a JSON body to the wallet REST path and returns the parsed reply", async () => {
		const calls = stubFetch(() => response({ block_header: { raw_data: { number: 71_000_000 } } }));
		const block = (await rpc.tron("https://api.trongrid.io", "wallet/getnowblock")) as any;

		expect(calls[0].url).toBe("https://api.trongrid.io/wallet/getnowblock");
		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].body).toEqual({});
		expect(block.block_header.raw_data.number).toBe(71_000_000);
	});

	it("normalises slashes and passes the body and headers through", async () => {
		const calls = stubFetch(() => response({ balance: 1 }));
		await rpc.tron(
			"https://api.trongrid.io/",
			"/wallet/getaccount",
			{ address: "TR7", visible: true },
			{ headers: { "TRON-PRO-API-KEY": "k" } },
		);

		expect(calls[0].url).toBe("https://api.trongrid.io/wallet/getaccount");
		expect(calls[0].body).toEqual({ address: "TR7", visible: true });
		expect((calls[0].init?.headers as Record<string, string>)["TRON-PRO-API-KEY"]).toBe("k");
	});

	it("returns transport and HTTP failures as values, and throws on bad arguments", async () => {
		stubFetch(() => response("rate limited", { status: 429 }));
		const out = (await rpc.tron("https://api.trongrid.io", "wallet/getnowblock")) as ErrorValue;
		expect(out.status).toBe(429);

		expect(rpc.tron(undefined as any, "wallet/getnowblock")).rejects.toThrow(TypeError);
		expect(rpc.tron("https://api.trongrid.io", "")).rejects.toThrow(TypeError);
	});

	it("leaves Tron's EVM-compatible /jsonrpc to rpc.call", async () => {
		const calls = stubFetch((_url, body) => response({ id: body.id, result: "0x2b6653dc" }));
		const chainId = await rpc.call("https://api.trongrid.io/jsonrpc", "eth_chainId");

		expect(calls[0].url).toBe("https://api.trongrid.io/jsonrpc");
		expect(calls[0].body.method).toBe("eth_chainId");
		expect(toBigInt(chainId)).toBe(728126428n); // Tron's EVM chain id
	});
});

describe("rpc skill surface", () => {
	it("exposes exactly the documented API", () => {
		expect(Object.keys(rpc).sort()).toEqual([
			"batch",
			"call",
			"endpoints",
			"fromUnits",
			"pick",
			"toBigInt",
			"toUnits",
			"tron",
		]);
	});
});
