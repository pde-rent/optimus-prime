import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skills are plain JS with JSDoc types, no .d.ts
import * as defiModule from "../skills/web3/defi.js";
// @ts-expect-error - bundled skills are plain JS with JSDoc types, no .d.ts
import * as hypersyncModule from "../skills/web3/hypersync.js";
// @ts-expect-error - bundled skills are plain JS with JSDoc types, no .d.ts
import * as portfolioModule from "../skills/web3/portfolio.js";
// @ts-expect-error - bundled skills are plain JS with JSDoc types, no .d.ts
import * as rpcModule from "../skills/web3/rpc.js";
// @ts-expect-error - bundled skills are plain JS with JSDoc types, no .d.ts
import * as web3Skill from "../skills/web3/skill.js";

/**
 * One suite for the merged `web3` skill, three sections that do not share fixtures.
 *
 * Each section is the former per-skill suite verbatim, scoped inside a `describe` so the three
 * `stubFetch`/`response`/`stubAll` helpers and the three `afterEach` fetch restores stay in
 * their own scope instead of colliding at file top level. No case was dropped in the merge.
 */

describe("web3 binding", () => {
	const web3 = web3Skill.default();

	it("composes exactly the four documented subsystems", () => {
		expect(Object.keys(web3).sort()).toEqual(["defi", "hypersync", "portfolio", "rpc"]);
	});

	it("binds each subsystem to its own module factory", () => {
		expect(Object.keys(web3.rpc).sort()).toEqual(Object.keys(rpcModule.createRpc()).sort());
		expect(Object.keys(web3.hypersync).sort()).toEqual(Object.keys(hypersyncModule.createHypersync()).sort());
		expect(Object.keys(web3.portfolio).sort()).toEqual(Object.keys(portfolioModule.createPortfolio()).sort());
		expect(Object.keys(web3.defi).sort()).toEqual(Object.keys(defiModule.createDefi()).sort());
	});

	it("hands each call a fresh subsystem instance rather than a shared singleton", () => {
		expect(web3Skill.default().rpc).not.toBe(web3.rpc);
	});

	// The nested shape is the contract: a flat `web3.chain` would be `rpc.pick`'s EVM chain id
	// and `defi.chain`'s DefiLlama chain name wearing one name, and `fromUnits` exists twice
	// with two deliberately different contracts. Nothing may be hoisted to the top level.
	it("hoists nothing to the top level", () => {
		for (const name of ["call", "batch", "chain", "chains", "balances", "fromUnits", "pick"]) {
			expect(web3).not.toHaveProperty(name);
		}
	});

	it("keeps the two fromUnits apart", () => {
		// rpc's goes through toBigInt: hex in, unsafe Number out as a throw.
		expect(web3.rpc.fromUnits("0xde0b6b3a7640000", 18)).toBe("1");
		expect(() => web3.rpc.fromUnits(2 ** 53 + 2, 0)).toThrow(TypeError);
		// portfolio's refuses hex and truncates the unsafe Number two services really send.
		expect(() => web3.portfolio.fromUnits("0xde0b6b3a7640000", 18)).toThrow(TypeError);
		expect(web3.portfolio.fromUnits(2 ** 53 + 2, 0)).toBe("9007199254740994");
	});
});

describe("web3.rpc", () => {
	const { createRpc, clearRpcCache, domainLabel, endpointTier, fromUnits, normalizeCall, toBigInt, toUnits } =
		rpcModule;

	type ErrorValue = { error: string; code?: number; status?: number; data?: unknown };
	type Probe = { url: string; ok: boolean; ms: number; detail: string; tier: string };

	const rpc = createRpc();
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

	function response(body: unknown, { status = 200, json = true, headers = {} as Record<string, string> } = {}) {
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

	const SOLANA_SEED = "https://api.mainnet-beta.solana.com";
	const TRON_SEED = "https://api.trongrid.io";

	/**
	 * Serve the registry, answer every health probe as a live chain-1 node, then route the call that
	 * follows to `answers[url]` - so an endpoint can pass discovery and fail the real request, which
	 * is exactly how a public endpoint degrades mid-session.
	 */
	function stubLadder(answers: Record<string, (body: any) => unknown> = {}) {
		return stubFetch(async (url, body) => {
			if (url === CHAINLIST) return response(REGISTRY);
			const one = Array.isArray(body) ? body[0] : body;
			if (one?.method === "eth_chainId") return response({ id: one.id, result: "0x1" });
			const answer = answers[url];
			return answer ? answer(body) : response({ id: one?.id, result: "0x10" });
		});
	}

	/** The URLs the call itself hit: the registry fetch and the health probes filtered out. */
	function served(calls: { url: string; body: any }[]) {
		return calls
			.filter((c) => c.url !== CHAINLIST)
			.filter((c) => (Array.isArray(c.body) ? c.body[0]?.method : c.body?.method) !== "eth_chainId")
			.map((c) => c.url);
	}

	describe("rpc failover", () => {
		it("rolls past a 429 and returns the next endpoint's result", async () => {
			const calls = stubLadder({
				[OFFICIAL]: () => response("rate limited", { status: 429 }),
				[PROVIDER]: (body) => response({ id: body.id, result: "0x10" }),
			});
			const out = await rpc.call(1, "eth_blockNumber");

			expect(out).toBe("0x10"); // the caller sees no failure at all
			expect(rpc.lastEndpoint).toBe(PROVIDER);
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("rolls past a timeout", async () => {
			const calls = stubLadder({
				[OFFICIAL]: () => {
					const e = new Error("The operation was aborted");
					e.name = "TimeoutError";
					throw e;
				},
			});
			expect(await rpc.call(1, "eth_blockNumber")).toBe("0x10");
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("rolls past an HTTP 500", async () => {
			const calls = stubLadder({ [OFFICIAL]: () => response("bad gateway", { status: 502 }) });
			expect(await rpc.call(1, "eth_blockNumber")).toBe("0x10");
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("rolls past a 403, which is one node's paywall rather than the chain's answer", async () => {
			const calls = stubLadder({
				[OFFICIAL]: () => response("archive requests require a paid plan", { status: 403 }),
			});
			expect(await rpc.call(1, "trace_block", ["0x1"])).toBe("0x10");
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("returns a JSON-RPC error at once, without spending another endpoint", async () => {
			const calls = stubLadder({
				[OFFICIAL]: (body) => response({ id: body.id, error: { code: -32000, message: "execution reverted" } }),
			});
			const out = (await rpc.call(1, "eth_call", [{ to: "0xabc" }])) as ErrorValue;

			expect(out.code).toBe(-32000);
			expect(out.error).toContain("execution reverted");
			expect(served(calls)).toEqual([OFFICIAL]); // the chain answered; ten nodes say the same
		});

		it("rolls a -32601 over, because a node's method list is its own choice", async () => {
			const calls = stubLadder({
				[OFFICIAL]: (body) => response({ id: body.id, error: { code: -32601, message: "method not found" } }),
				[PROVIDER]: (body) => response({ id: body.id, result: ["trace"] }),
			});
			expect(await rpc.call(1, "trace_block", ["0x1"])).toEqual(["trace"]);
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("names every endpoint and its reason when the whole ladder is dead", async () => {
			stubLadder({
				[OFFICIAL]: () => response("rate limited", { status: 429 }),
				[PROVIDER]: () => response("boom", { status: 500 }),
				[OTHER]: () => {
					throw new Error("ECONNREFUSED");
				},
			});
			const out = (await rpc.call(1, "eth_blockNumber")) as ErrorValue;

			expect(out.error).toContain("all 3 endpoints failed");
			for (const [url, why] of [
				[OFFICIAL, "HTTP 429"],
				[PROVIDER, "HTTP 500"],
				[OTHER, "ECONNREFUSED"],
			]) {
				expect(out.error).toContain(url);
				expect(out.error).toContain(why);
			}
		});

		it("evicts the endpoint it gave up on, so the memo cannot hand it back", async () => {
			stubLadder({
				[OFFICIAL]: () => response("rate limited", { status: 429 }),
				[PROVIDER]: (body) => response({ id: body.id, result: "0x10" }),
			});
			expect(await rpc.pick(1)).toBe(OFFICIAL); // the memo starts on what is about to die
			await rpc.call(1, "eth_blockNumber");
			expect(await rpc.pick(1)).toBe(PROVIDER); // the bug: this used to stay OFFICIAL
		});

		it("re-ranks from scratch once every candidate has been evicted", async () => {
			const calls = stubLadder({
				[OFFICIAL]: () => response("boom", { status: 500 }),
				[PROVIDER]: () => response("boom", { status: 500 }),
				[OTHER]: () => response("boom", { status: 500 }),
			});
			await rpc.call(1, "eth_blockNumber");
			const probes = calls.filter((c) => c.body?.method === "eth_chainId").length;

			expect(await rpc.pick(1)).toBe(OFFICIAL);
			expect(calls.filter((c) => c.body?.method === "eth_chainId").length).toBeGreaterThan(probes);
		});

		it("surfaces the first failure with { failover: false }", async () => {
			const calls = stubLadder({ [OFFICIAL]: () => response("boom", { status: 500 }) });
			const out = (await rpc.call(1, "eth_blockNumber", [], { failover: false })) as ErrorValue;

			expect(out.status).toBe(500);
			expect(served(calls)).toEqual([OFFICIAL]);
		});

		it("waits out a Retry-After inside the bound and keeps the endpoint", async () => {
			let hits = 0;
			const calls = stubLadder({
				[OFFICIAL]: (body) => {
					hits += 1;
					return hits === 1
						? response("slow down", { status: 429, headers: { "Retry-After": "0.05" } })
						: response({ id: body.id, result: "0x11" });
				},
			});
			expect(await rpc.call(1, "eth_blockNumber")).toBe("0x11");
			expect(rpc.lastEndpoint).toBe(OFFICIAL);
			expect(served(calls)).toEqual([OFFICIAL, OFFICIAL]); // never needed the fallback
		});

		it("skips an endpoint whose Retry-After is past the bound", async () => {
			const started = Date.now();
			const calls = stubLadder({
				[OFFICIAL]: () => response("slow down", { status: 429, headers: { "Retry-After": "30" } }),
				[PROVIDER]: (body) => response({ id: body.id, result: "0x12" }),
			});
			expect(await rpc.call(1, "eth_blockNumber")).toBe("0x12");

			expect(Date.now() - started).toBeLessThan(1000); // a 30s sleep would eat the whole turn
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("resolves an EVM chain given as an id or a name", async () => {
			const calls = stubLadder();
			expect(await rpc.call(1, "eth_blockNumber")).toBe("0x10");
			expect(await rpc.call("ethereum", "eth_blockNumber")).toBe("0x10");
			expect(served(calls)).toEqual([OFFICIAL, OFFICIAL]);
			expect(calls.filter((c) => c.url === CHAINLIST)).toHaveLength(1); // memoised
		});

		it("resolves solana through its seed list, never touching the registry", async () => {
			const calls = stubFetch((_url, body) =>
				body?.method === "getSlot"
					? response({ id: body.id, result: 315_000_000 })
					: response({ id: body.id, result: { value: 42 } }),
			);
			const out = await rpc.call("solana", "getBalance", ["addr"], { limit: 1 });

			expect(out).toEqual({ value: 42 });
			expect(rpc.lastEndpoint).toBe(SOLANA_SEED);
			expect(calls.some((c) => c.url === CHAINLIST)).toBe(false);
			expect(calls.at(-1)?.body.method).toBe("getBalance");
		});

		it("resolves tron to the EVM-compatible /jsonrpc its REST base hosts", async () => {
			stubFetch((url, body) =>
				url.endsWith("/wallet/getnowblock")
					? response({ block_header: { raw_data: { number: 71_000_000 } } })
					: response({ id: body.id, result: "0x2b6653dc" }),
			);
			const out = await rpc.call("tron", "eth_chainId", [], { limit: 1 });

			expect(toBigInt(out)).toBe(728126428n); // Tron's EVM chain id
			expect(rpc.lastEndpoint).toBe(`${TRON_SEED}/jsonrpc`);
		});

		it("gives rpc.tron the same chain argument and the same rollover", async () => {
			stubFetch((url) => {
				if (url.endsWith("/wallet/getnowblock"))
					return response({ block_header: { raw_data: { number: 71_000_000 } } });
				return url.startsWith(TRON_SEED) ? response("rate limited", { status: 429 }) : response({ balance: 5 });
			});
			const out = await rpc.tron("tron", "wallet/getaccount", { address: "TR7" }, { limit: 2 });

			expect(out).toEqual({ balance: 5 });
			expect(rpc.lastEndpoint).toBe("https://api.tronstack.io");
		});

		it("fails a batch over and still returns one entry per call", async () => {
			const calls = stubLadder({
				[OFFICIAL]: () => response("boom", { status: 502 }),
				[PROVIDER]: (body) => response(body.map((r: any) => ({ id: r.id, result: r.method }))),
			});
			const out = await rpc.batch(1, ["eth_blockNumber", "eth_gasPrice"]);

			expect(out).toEqual(["eth_blockNumber", "eth_gasPrice"]);
			expect(rpc.lastEndpoint).toBe(PROVIDER);
			expect(served(calls)).toEqual([OFFICIAL, PROVIDER]);
		});

		it("leaves an explicit URL alone - no discovery, no rollover", async () => {
			const calls = stubFetch(() => response("rate limited", { status: 429 }));
			const out = (await rpc.call(URL_, "eth_blockNumber")) as ErrorValue;

			expect(out.status).toBe(429); // the endpoint's own error, unwrapped
			expect(calls).toHaveLength(1);
		});

		it("passes a resolution failure through in each shape", async () => {
			stubLadder();
			expect(((await rpc.call(4242, "eth_blockNumber")) as ErrorValue).error).toContain("not in the registry");
			expect(await rpc.batch(4242, ["a", "b"])).toEqual([
				expect.objectContaining({ error: expect.stringContaining("not in the registry") }),
				expect.objectContaining({ error: expect.stringContaining("not in the registry") }),
			]);
			expect(rpc.call(undefined as any, "m")).rejects.toThrow(TypeError);
		});
	});

	describe("rpc skill surface", () => {
		it("exposes exactly the documented API", () => {
			expect(Object.keys(rpc).sort()).toEqual([
				"batch",
				"call",
				"endpoints",
				"fromUnits",
				"lastEndpoint",
				"pick",
				"toBigInt",
				"toUnits",
				"tron",
			]);
		});
	});
});

describe("web3.portfolio", () => {
	const {
		createPortfolio,
		addressFamily,
		clearPortfolioCache,
		fromUnits,
		normalizePhantom,
		normalizeRabby,
		normalizeTron,
	} = portfolioModule;

	type ErrorValue = { error: string; status?: number };
	type Item = {
		chain: string;
		symbol: string | null;
		name: string | null;
		address: string;
		native: boolean;
		decimals: number | null;
		amount: string | null;
		uiAmount: number | null;
		priceUsd: number | null;
		valueUsd: number | null;
		verified: boolean | null;
		spam: boolean | null;
		logo: string | null;
	};

	const portfolio = createPortfolio();

	const EVM = "0xbb84b2af75731578d61aa032b52f213d2dbd7024";
	const SOLANA = "6MFUy9ySTfkusKbsuon7Q5wUgzGc2Qev2V7fSW5CFF8n";
	const TRON = "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G";

	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		// The response memo lives at module scope, i.e. for the whole session.
		clearPortfolioCache();
	});

	/** Stub `fetch`, recording every request made. No test here touches the network. */
	function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calls.push(String(url));
			return handler(String(url), init);
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

	/**
	 * Rabby rows captured live for `EVM`, trimmed.
	 *
	 * `CUSD` is the precision case and is verbatim: its `raw_amount` double really did land on
	 * ...580 while `raw_amount_str` says ...590. `BLU` is past 2^53 outright. `ETH` on `arb` is a
	 * native row, marked only by `id` holding the chain slug.
	 *
	 * The last two rows are SYNTHESIZED: `is_scam`, `is_suspicious` and `!is_verified` never fired
	 * across 2289 live tokens, so the documented filter rule has no live example to exercise.
	 */
	const RABBY_TOKENS = [
		{
			id: "0xfa4ba88cf97e282c505bea095297786c16070129",
			chain: "bsc",
			name: "Coin98 Dollar",
			symbol: "CUSD",
			decimals: 18,
			logo_url: "https://static.debank.com/image/bsc_token/logo_url/cusd.png",
			price: 0,
			is_verified: true,
			is_scam: false,
			is_suspicious: false,
			amount: 0.13394680628316558,
			raw_amount: 133946806283165580,
			raw_amount_str: "133946806283165590",
			cex_ids: [],
			fdv: 0,
		},
		{
			id: "0x24dcd565ba6f6b5ef6b4a0ffdd2f9c0c3ecf0d10",
			chain: "bsc",
			name: "Blu",
			symbol: "BLU",
			decimals: 18,
			logo_url: null,
			price: 2.4606662417409027e-8,
			is_verified: true,
			is_scam: false,
			is_suspicious: false,
			amount: 150,
			raw_amount: 150000000000000000000,
			raw_amount_str: "150000000000000000000",
			cex_ids: [],
			fdv: 0,
		},
		{
			id: "arb",
			chain: "arb",
			name: "ETH",
			symbol: "ETH",
			decimals: 18,
			logo_url: "https://static.debank.com/image/coin/logo_url/eth/eth.png",
			price: 2281.09,
			is_verified: true,
			is_scam: false,
			is_suspicious: false,
			amount: 3.27274735999e-7,
			raw_amount: 327274735999,
			raw_amount_str: "327274735999",
			cex_ids: ["binance"],
			fdv: 483620605.42,
		},
		{
			id: "0xe9e7cea3dedca5984780bafc599bd69add087d56",
			chain: "bsc",
			name: "BUSD Token",
			symbol: "BUSD",
			decimals: 18,
			logo_url: "https://static.debank.com/image/coin/logo_url/busd/busd.png",
			price: 1.0003339425408808,
			is_verified: true,
			is_scam: false,
			is_suspicious: false,
			amount: 0.007960860224933693,
			raw_amount: 7960860224933693,
			raw_amount_str: "7960860224933693",
			cex_ids: [],
			fdv: 0,
		},
		{
			id: "0x00000000000000000000000000000000deadbeef",
			chain: "eth",
			name: "Claim rewards at scam.example",
			symbol: "USDC",
			decimals: 6,
			logo_url: "",
			price: 1,
			is_verified: false,
			is_scam: true,
			is_suspicious: false,
			amount: 1000,
			raw_amount: 1000000000,
			raw_amount_str: "1000000000",
			cex_ids: [],
			fdv: 0,
		},
		{
			id: "0x00000000000000000000000000000000feed0000",
			chain: "eth",
			name: "Suspicious Token",
			symbol: "SUS",
			decimals: 18,
			logo_url: null,
			price: 500,
			is_verified: false,
			is_scam: false,
			is_suspicious: true,
			amount: 2,
			raw_amount: 2000000000000000000,
			raw_amount_str: "2000000000000000000",
			cex_ids: [],
			fdv: 0,
		},
	];

	/**
	 * A Phantom response captured live for `SOLANA`, trimmed.
	 *
	 * Verbatim drift worth keeping: the native SOL row sends `amount` as a NUMBER and carries no
	 * `solPrice` key at all, `solPrice` on USDC is `185538.31` while its real USD price is `1`, and
	 * `tokenPrices` covers only the rows the service prices.
	 */
	const PHANTOM_RESPONSE = {
		success: true,
		data: [
			{
				address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				amount: "16280178",
				uiAmount: 16.280178,
				solPrice: 185538.311989192,
				decimals: 6,
				supply: 8177288758.240565,
				symbol: "USDC",
				name: "USD Coin",
				logoURI: "",
				spamStatus: "VERIFIED",
			},
			{
				name: "Solana",
				symbol: "SOL",
				address: "So11111111111111111111111111111111111111112",
				logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/sol/logo.png",
				decimals: 9,
				amount: 29764933,
				uiAmount: 0.029764933,
				supply: 632261468.7206113,
				spamStatus: "VERIFIED",
			},
			{
				address: "C1r2hZdjn1mDAnoRUu9VSVvwWoSAQqUU2JirbSNysmaY",
				amount: "4330000",
				uiAmount: 4.33,
				solPrice: 0,
				decimals: 6,
				supply: 487066518.545132,
				symbol: "MELANIA​",
				name: "Melania Meme​",
				logoURI: "https://gateway.irys.xyz/melania-homoglyph",
				spamStatus: "POSSIBLE_SPAM",
			},
			{
				address: "HNVXCEf3sJFuJVTG3NowfRjHoHS8juFoKx8ozRstpump",
				amount: "3564784053156",
				uiAmount: 3564784.053156,
				solPrice: 0,
				decimals: 6,
				supply: 1000000000,
				symbol: "PAN!",
				name: "Pepman",
				logoURI: "https://ipfs.io/ipfs/pepman",
				spamStatus: "LOW_LIQUIDITY",
			},
		],
		tokenPrices: {
			EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { value: 1, solValue: 0.0114, pnlInUsd: 0 },
			So11111111111111111111111111111111111111112: { value: 87.7156019015623, solValue: 1, pnlInUsd: 0 },
		},
		sparkCharts: { So11111111111111111111111111111111111111112: [{ unixTime: 1787130000, value: 77.25 }] },
	};

	/** A TronGrid account captured live for `TRON`, trimmed to three of its 357 TRC-20 entries. */
	const TRON_RESPONSE = {
		data: [
			{
				address: "41...",
				balance: 5773899852479,
				trc20: [
					{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: "37272285390601" },
					{ TA9NQbBZPdTDMsbbjbghsucpsH4N6TLAC1: "8888000000000000000000" },
					{ TVryvaBTmiQrZhusuBYLn2UfN3SHRdjVF1: "636888888" },
				],
				assetV2: [{ value: 96000000000, key: "1004746" }],
				frozenV2: [{ type: "ENERGY" }],
			},
		],
		success: true,
		meta: { at: 1787216294428, page_size: 1 },
	};

	/** Answer whichever upstream the address routed to, so one stub serves every family. */
	function stubAll() {
		return stubFetch((url) => {
			if (url.startsWith("https://api.rabby.io/")) return response(RABBY_TOKENS);
			if (url.startsWith("https://api.phantom.app/")) return response(PHANTOM_RESPONSE);
			if (url.startsWith("https://api.trongrid.io/")) return response(TRON_RESPONSE);
			throw new Error(`unexpected url ${url}`);
		});
	}

	describe("portfolio.family", () => {
		it("routes an EVM address to the Rabby path", () => {
			expect(addressFamily(EVM)).toBe("evm");
			expect(addressFamily("0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045")).toBe("evm");
			expect(portfolio.family(EVM)).toBe("evm");
		});

		it("routes a Solana base58 address to the Phantom path", () => {
			expect(addressFamily(SOLANA)).toBe("solana");
			expect(addressFamily("So11111111111111111111111111111111111111112")).toBe("solana");
		});

		it("routes a Tron address to the TronGrid path", () => {
			expect(addressFamily(TRON)).toBe("tron");
			expect(addressFamily("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe("tron");
		});

		it("prefers Tron over Solana for a 34-character base58 string starting with T", () => {
			// The encodings genuinely overlap; the ordering is documented, not accidental.
			expect(addressFamily("TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb")).toBe("tron");
		});

		it("throws a TypeError naming all three shapes for anything unrecognised", () => {
			for (const bad of ["", "   ", "0xdeadbeef", `0x${"z".repeat(40)}`, "hello world", "0OIl"]) {
				expect(() => addressFamily(bad)).toThrow(TypeError);
			}
			expect(() => addressFamily("nope")).toThrow(/EVM.*Solana.*Tron/s);
			expect(() => addressFamily(null as unknown as string)).toThrow(/non-empty string, got null/);
			expect(() => addressFamily(42 as unknown as string)).toThrow(/got number/);
		});

		it("rejects a bad address from balances before any request is made", async () => {
			const calls = stubAll();
			await expect(portfolio.balances("not-an-address")).rejects.toThrow(TypeError);
			expect(calls).toHaveLength(0);
		});
	});

	describe("portfolio.balances - EVM via Rabby", () => {
		it("normalises a live Rabby row into the shared item shape", async () => {
			const calls = stubAll();
			const items = (await portfolio.balances(EVM)) as Item[];

			expect(calls[0]).toBe(`https://api.rabby.io/v1/user/cache_token_list?id=${EVM}`);
			const busd = items.find((i) => i.symbol === "BUSD");
			expect(busd).toEqual({
				chain: "bsc",
				symbol: "BUSD",
				name: "BUSD Token",
				address: "0xe9e7cea3dedca5984780bafc599bd69add087d56",
				native: false,
				decimals: 18,
				amount: "7960860224933693",
				uiAmount: 0.007960860224933693,
				priceUsd: 1.0003339425408808,
				valueUsd: 0.007960860224933693 * 1.0003339425408808,
				verified: true,
				spam: false,
				logo: "https://static.debank.com/image/coin/logo_url/busd/busd.png",
			});
		});

		it("marks a native coin by the chain slug Rabby puts in `id`", async () => {
			stubAll();
			const items = (await portfolio.balances(EVM)) as Item[];
			const eth = items.find((i) => i.chain === "arb");

			expect(eth?.native).toBe(true);
			expect(eth?.address).toBe("arb");
			expect(items.filter((i) => i.address.startsWith("0x")).every((i) => i.native === false)).toBe(true);
		});

		it("lowercases the EVM address in the request so both casings hit one cache entry", async () => {
			const calls = stubAll();
			await portfolio.balances(EVM.toUpperCase().replace("0X", "0x"));
			expect(calls[0]).toContain(EVM);
		});
	});

	describe("portfolio.balances - exact amounts", () => {
		it("uses raw_amount_str, not the raw_amount double that has already lost a digit", async () => {
			stubAll();
			const items = (await portfolio.balances(EVM)) as Item[];
			const cusd = items.find((i) => i.symbol === "CUSD");

			// The fixture is verbatim from a live response: the two fields really do disagree.
			expect(String(RABBY_TOKENS[0].raw_amount)).toBe("133946806283165580");
			expect(cusd?.amount).toBe("133946806283165590");
			expect(cusd?.amount).not.toBe(String(RABBY_TOKENS[0].raw_amount));
		});

		it("preserves a balance past Number.MAX_SAFE_INTEGER digit for digit", async () => {
			stubAll();
			const items = (await portfolio.balances(EVM, { includeSpam: true })) as Item[];
			const blu = items.find((i) => i.symbol === "BLU");

			expect(BigInt(blu?.amount ?? "0") > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
			expect(blu?.amount).toBe("150000000000000000000");
			expect(blu?.uiAmount).toBe(150);
		});

		it("derives uiAmount from the exact string rather than from the lossy integer", async () => {
			stubAll();
			const items = (await portfolio.balances(EVM)) as Item[];
			const cusd = items.find((i) => i.symbol === "CUSD");

			expect(cusd?.uiAmount).toBe(Number("0.13394680628316559"));
			expect(cusd?.uiAmount).not.toBe(RABBY_TOKENS[0].amount);
		});

		it("scales exactly with no floating-point arithmetic", () => {
			expect(fromUnits("150000000000000000000", 18)).toBe("150");
			expect(fromUnits("133946806283165590", 18)).toBe("0.13394680628316559");
			expect(fromUnits("1", 18)).toBe("0.000000000000000001");
			expect(fromUnits("37272285390601", 6)).toBe("37272285.390601");
			expect(fromUnits(0, 6)).toBe("0");
			expect(() => fromUnits("abc", 18)).toThrow(TypeError);
			expect(() => fromUnits("1", 999)).toThrow(TypeError);
		});
	});

	describe("portfolio.balances - Solana via Phantom", () => {
		it("normalises an SPL row and takes the price from tokenPrices, not solPrice", async () => {
			const calls = stubAll();
			const items = (await portfolio.balances(SOLANA)) as Item[];

			expect(calls[0]).toContain(`ownerAddress=${SOLANA}`);
			const usdc = items.find((i) => i.symbol === "USDC");
			expect(usdc?.priceUsd).toBe(1);
			expect(usdc?.priceUsd).not.toBe(PHANTOM_RESPONSE.data[0].solPrice);
			expect(usdc?.amount).toBe("16280178");
			expect(usdc?.uiAmount).toBe(16.280178);
			expect(usdc?.valueUsd).toBe(16.280178);
			// An empty logoURI upstream should read as absent, not as an empty URL.
			expect(usdc?.logo).toBeNull();
		});

		it("handles the native SOL row sending amount as a number and omitting solPrice", async () => {
			stubAll();
			const items = (await portfolio.balances(SOLANA)) as Item[];
			const sol = items.find((i) => i.symbol === "SOL");

			expect(typeof PHANTOM_RESPONSE.data[1].amount).toBe("number");
			expect(sol?.amount).toBe("29764933");
			expect(sol?.native).toBe(true);
			expect(sol?.uiAmount).toBe(0.029764933);
			expect(sol?.priceUsd).toBe(87.7156019015623);
		});

		it("reports an unpriced position as null rather than zero", async () => {
			stubAll();
			const items = (await portfolio.balances(SOLANA)) as Item[];
			const pan = items.find((i) => i.symbol === "PAN!");

			expect(pan?.priceUsd).toBeNull();
			expect(pan?.valueUsd).toBeNull();
			expect(pan?.amount).toBe("3564784053156");
			expect(pan?.uiAmount).toBe(3564784.053156);
		});

		it("returns an error value when Phantom answers 200 with success false", async () => {
			stubFetch(() => response({ success: false, message: "error", id: "ca7bc294" }));
			const out = (await portfolio.balances(SOLANA)) as ErrorValue;
			expect(out.error).toContain("Phantom declined");
		});
	});

	describe("portfolio.balances - Tron via TronGrid", () => {
		it("fills native TRX completely and leaves every TRC-20 field it has no source for null", async () => {
			const calls = stubAll();
			const items = (await portfolio.balances(TRON)) as Item[];

			expect(calls[0]).toBe(`https://api.trongrid.io/v1/accounts/${TRON}`);
			expect(items).toHaveLength(4);
			expect(items[0]).toEqual({
				chain: "tron",
				symbol: "TRX",
				name: "TRON",
				address: "native",
				native: true,
				decimals: 6,
				amount: "5773899852479",
				uiAmount: 5773899.852479,
				priceUsd: null,
				valueUsd: null,
				verified: true,
				spam: false,
				logo: null,
			});
			expect(items[1]).toEqual({
				chain: "tron",
				symbol: null,
				name: null,
				address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
				native: false,
				decimals: null,
				amount: "37272285390601",
				uiAmount: null,
				priceUsd: null,
				valueUsd: null,
				verified: null,
				spam: null,
				logo: null,
			});
		});

		it("keeps a TRC-20 balance past 2^53 exact even though its decimals are unknown", async () => {
			stubAll();
			const items = (await portfolio.balances(TRON)) as Item[];
			expect(items.find((i) => i.address === "TA9NQbBZPdTDMsbbjbghsucpsH4N6TLAC1")?.amount).toBe(
				"8888000000000000000000",
			);
		});

		it("emits a zero TRX row for an account TronGrid reports with no balance key", async () => {
			stubFetch(() => response({ data: [{ address: "41..." }], success: true }));
			const items = (await portfolio.balances(TRON)) as Item[];

			expect(items).toHaveLength(1);
			expect(items[0].amount).toBe("0");
			expect(items[0].uiAmount).toBe(0);
		});

		it("returns an error value when TronGrid rejects the account", async () => {
			stubFetch(() => response({ success: false, error: "A valid account address is required." }, { status: 400 }));
			const out = (await portfolio.balances(TRON)) as ErrorValue;
			expect(out.status).toBe(400);
			expect(out.error).toContain("HTTP 400");
		});
	});

	describe("portfolio.balances - spam filtering", () => {
		it("drops Rabby rows flagged is_scam or is_suspicious by default", async () => {
			stubAll();
			const kept = (await portfolio.balances(EVM)) as Item[];
			const all = (await portfolio.balances(EVM, { includeSpam: true })) as Item[];

			expect(all).toHaveLength(6);
			expect(kept).toHaveLength(4);
			expect(kept.map((i) => i.symbol)).not.toContain("SUS");
			expect(kept.some((i) => i.name?.includes("scam.example"))).toBe(false);
			expect(all.filter((i) => i.spam).map((i) => i.name)).toEqual([
				"Claim rewards at scam.example",
				"Suspicious Token",
			]);
		});

		it("drops POSSIBLE_SPAM but keeps LOW_LIQUIDITY, which marks a thin holding not a scam", async () => {
			stubAll();
			const kept = (await portfolio.balances(SOLANA)) as Item[];
			const all = (await portfolio.balances(SOLANA, { includeSpam: true })) as Item[];

			expect(all).toHaveLength(4);
			expect(kept).toHaveLength(3);
			// The homoglyph MELANIA is the POSSIBLE_SPAM row and is the only one dropped.
			expect(kept.find((i) => i.address === "C1r2hZdjn1mDAnoRUu9VSVvwWoSAQqUU2JirbSNysmaY")).toBeUndefined();
			const pan = kept.find((i) => i.symbol === "PAN!");
			expect(pan?.spam).toBe(false);
			expect(pan?.verified).toBe(false);
		});

		it("never filters Tron, where spam is null because no signal exists", async () => {
			stubAll();
			const kept = (await portfolio.balances(TRON)) as Item[];
			const all = (await portfolio.balances(TRON, { includeSpam: true })) as Item[];

			expect(kept).toHaveLength(all.length);
			expect(kept.slice(1).every((i) => i.spam === null)).toBe(true);
		});
	});

	describe("portfolio.balances - sort order", () => {
		it("sorts by valueUsd descending with unpriced positions last", async () => {
			stubAll();
			const items = (await portfolio.balances(SOLANA)) as Item[];

			expect(items.map((i) => i.symbol)).toEqual(["USDC", "SOL", "PAN!"]);
			expect(items.at(-1)?.valueUsd).toBeNull();
		});

		it("orders every priced EVM row above every unpriced one", async () => {
			stubAll();
			const items = (await portfolio.balances(EVM, { includeSpam: true })) as Item[];
			const values = items.map((i) => i.valueUsd);

			expect(values.filter((v) => v !== null)).toEqual(
				[...values.filter((v) => v !== null)].sort((a, b) => b! - a!),
			);
			const firstNull = values.indexOf(null);
			if (firstNull !== -1) expect(values.slice(firstNull).every((v) => v === null)).toBe(true);
		});

		it("keeps upstream order when nothing is priced, so a Tron list is not shuffled", async () => {
			stubAll();
			const items = (await portfolio.balances(TRON)) as Item[];
			expect(items.map((i) => i.address)).toEqual([
				"native",
				"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
				"TA9NQbBZPdTDMsbbjbghsucpsH4N6TLAC1",
				"TVryvaBTmiQrZhusuBYLn2UfN3SHRdjVF1",
			]);
		});
	});

	describe("portfolio.raw", () => {
		it("returns each upstream payload untouched, including what normalisation drops", async () => {
			stubAll();

			expect(await portfolio.raw(EVM)).toEqual(RABBY_TOKENS);
			expect((await portfolio.raw(EVM))[2].cex_ids).toEqual(["binance"]);

			const solana = (await portfolio.raw(SOLANA)) as typeof PHANTOM_RESPONSE;
			expect(solana).toEqual(PHANTOM_RESPONSE);
			expect(solana.tokenPrices.So11111111111111111111111111111111111111112.value).toBe(87.7156019015623);
			expect(solana.sparkCharts).toBeDefined();

			const tron = (await portfolio.raw(TRON)) as typeof TRON_RESPONSE;
			expect(tron.data[0].assetV2).toEqual([{ value: 96000000000, key: "1004746" }]);
			expect(tron.data[0].frozenV2).toBeDefined();
		});

		it("serves balances then raw from one round trip, and refresh forces a second", async () => {
			const calls = stubAll();

			await portfolio.balances(EVM);
			await portfolio.raw(EVM);
			expect(calls).toHaveLength(1);

			await portfolio.raw(EVM, { refresh: true });
			expect(calls).toHaveLength(2);
		});

		it("returns the error value, not the payload, when the request failed", async () => {
			stubFetch(() => response("rate limited", { status: 429 }));
			const out = (await portfolio.raw(EVM)) as ErrorValue;
			expect(out.status).toBe(429);
		});
	});

	describe("portfolio - failures come back as values", () => {
		it("returns an HTTP failure carrying the status instead of throwing", async () => {
			stubFetch(() => response("rate limited", { status: 429 }));
			const out = (await portfolio.balances(EVM)) as ErrorValue;

			expect(out.status).toBe(429);
			expect(out.error).toContain("HTTP 429");
			expect(out.error).toContain("rate limited");
			expect(out.error).toContain("Rabby");
		});

		it("returns a network failure as a value", async () => {
			stubFetch(() => {
				throw new Error("ECONNREFUSED");
			});
			const out = (await portfolio.balances(SOLANA)) as ErrorValue;
			expect(out.error).toContain("ECONNREFUSED");
			expect(out.error).toContain("Phantom");
		});

		it("names the timeout option when the request times out", async () => {
			stubFetch(() => {
				const e = new Error("The operation was aborted");
				e.name = "TimeoutError";
				throw e;
			});
			const out = (await portfolio.balances(TRON)) as ErrorValue;
			expect(out.error).toContain("timed out");
			expect(out.error).toContain("timeout");
		});

		it("returns a value for a non-JSON body", async () => {
			stubFetch(() => response("<html>proxy error</html>", { json: false }));
			const out = (await portfolio.balances(EVM)) as ErrorValue;
			expect(out.error).toContain("non-JSON");
		});

		it("does not cache a failure, so an immediate retry really retries", async () => {
			let attempt = 0;
			const calls = stubFetch(() => {
				attempt += 1;
				return attempt === 1 ? response("rate limited", { status: 429 }) : response(RABBY_TOKENS);
			});

			expect(((await portfolio.balances(EVM)) as ErrorValue).status).toBe(429);
			expect((await portfolio.balances(EVM)) as Item[]).toHaveLength(4);
			expect(calls).toHaveLength(2);
		});
	});

	describe("portfolio - empty portfolios", () => {
		it("returns an empty array for each family rather than an error", async () => {
			stubFetch((url) => {
				if (url.startsWith("https://api.rabby.io/")) return response([]);
				if (url.startsWith("https://api.phantom.app/")) return response({ success: true, data: [] });
				return response({ data: [], success: true, meta: { page_size: 0 } });
			});

			expect(await portfolio.balances(EVM)).toEqual([]);
			expect(await portfolio.balances(SOLANA)).toEqual([]);
			// TronGrid returns `data: []` for an address it has never seen at all.
			expect(await portfolio.balances(TRON)).toEqual([]);
		});
	});

	describe("normalizers are pure and exported for direct use", () => {
		it("normalises each shape without any request", () => {
			expect(normalizeRabby(RABBY_TOKENS)).toHaveLength(6);
			expect(normalizePhantom(PHANTOM_RESPONSE)).toHaveLength(4);
			expect(normalizeTron(TRON_RESPONSE)).toHaveLength(4);
		});

		it("tolerates a payload that is not the shape the service documents", () => {
			expect(normalizeRabby(null)).toEqual([]);
			expect(normalizeRabby({ error: "nope" })).toEqual([]);
			expect(normalizePhantom({})).toEqual([]);
			expect(normalizeTron({ data: [] })).toEqual([]);
			expect(normalizeTron({})).toEqual([]);
		});
	});
});

describe("web3.defi", () => {
	const { createDefi, chainAliases, clearDefiCache, downsample, foldChains, renderHistory, volumeIndex } = defiModule;

	type ErrorValue = { error: string; status?: number };
	type ChainRow = { name: string; chainId?: number; symbol: string | null; tvl: number; volume24h?: number };
	type ProtocolRow = {
		name: string;
		slug: string;
		category: string | null;
		tvl: number;
		chainTvl?: number;
		chains?: string[];
		d1?: number;
		d7?: number;
	};

	const defi = createDefi();

	const CHAINS_URL = "https://api.llama.fi/v2/chains";
	const PROTOCOLS_URL = "https://api.llama.fi/protocols";
	const GECKO_URL = "https://app.geckoterminal.com/api/p1/networks?page=1&include=network_metric";

	/**
	 * Fixtures are trimmed from live responses, including the shapes that surprised us: two rows for
	 * chain id 56, a null `chainId` for Solana, a numeric-string `chainId`, a null `tokenSymbol`.
	 */
	const LLAMA_CHAINS = [
		{ gecko_id: "ethereum", tvl: 45994853162, tokenSymbol: "ETH", cmcId: "1027", name: "Ethereum", chainId: 1 },
		{ gecko_id: "binancecoin", tvl: 5201879703, tokenSymbol: "BNB", cmcId: "1839", name: "BSC", chainId: 56 },
		{ gecko_id: "binancecoin", tvl: 0, tokenSymbol: "BNB", cmcId: "1839", name: "Binance", chainId: 56 },
		{ gecko_id: "solana", tvl: 5230381190, tokenSymbol: "SOL", cmcId: "5426", name: "Solana", chainId: null },
		{ gecko_id: null, tvl: 5034113318, tokenSymbol: null, cmcId: null, name: "Base", chainId: 8453 },
		{ gecko_id: "bitcoin", tvl: 3860097400, tokenSymbol: "BTC", cmcId: "1", name: "Bitcoin", chainId: null },
		{ gecko_id: "islamic-coin", tvl: 12345, tokenSymbol: "ISLM", cmcId: null, name: "HAQQ", chainId: "11235" },
	];

	/**
	 * Trimmed from the live payload, which puts every money field in a network_metric on the
	 * `included` side as a decimal STRING and leaves the network object itself metric-free.
	 *
	 * The `rank_by_liquidity` values are kept and are deliberately misleading - HAQQ, which trades
	 * nothing, outranks Base - because the skill must ignore that field, and a fixture that agreed
	 * with volume order could not prove it does.
	 */
	const GECKO_NETWORKS = {
		data: [
			{
				id: "136",
				type: "network",
				attributes: { name: "Solana", identifier: "solana", chain_id: null, cg_network_id: "solana" },
				relationships: { network_metric: { data: { id: "8", type: "network_metric" } } },
			},
			{
				id: "1",
				type: "network",
				attributes: { name: "BNB Chain", identifier: "bsc", chain_id: 56, cg_network_id: "binance-smart-chain" },
				relationships: { network_metric: { data: { id: "2", type: "network_metric" } } },
			},
			{
				id: "2",
				type: "network",
				attributes: { name: "Ethereum", identifier: "eth", chain_id: 1, cg_network_id: "ethereum" },
				relationships: { network_metric: { data: { id: "3", type: "network_metric" } } },
			},
			{
				id: "9",
				type: "network",
				attributes: { name: "Base", identifier: "base", chain_id: 8453, cg_network_id: "base" },
				relationships: { network_metric: { data: { id: "4", type: "network_metric" } } },
			},
			{
				id: "77",
				type: "network",
				attributes: { name: "HAQQ", identifier: "haqq", chain_id: 11235, cg_network_id: "haqq-network" },
				relationships: { network_metric: { data: { id: "5", type: "network_metric" } } },
			},
		],
		included: [
			{
				id: "8",
				type: "network_metric",
				attributes: {
					swap_volume_usd_24h: "6267922512.52942",
					swap_count_24h: 35422391,
					reserve_in_usd: "392596324369.452",
					rank_by_liquidity: 1,
				},
			},
			{ id: "2", type: "network_metric", attributes: { swap_volume_usd_24h: "2954183001.5", rank_by_liquidity: 2 } },
			{ id: "3", type: "network_metric", attributes: { swap_volume_usd_24h: "2293884120.9", rank_by_liquidity: 3 } },
			{ id: "4", type: "network_metric", attributes: { swap_volume_usd_24h: "968512340.44", rank_by_liquidity: 8 } },
			// A measured zero, which must still outrank a chain with no measurement at all.
			{ id: "5", type: "network_metric", attributes: { swap_volume_usd_24h: "0", rank_by_liquidity: 4 } },
		],
	};

	const LLAMA_PROTOCOLS = [
		{
			name: "PancakeSwap AMM",
			slug: "pancakeswap-amm",
			symbol: "CAKE",
			category: "Dexs",
			tvl: 1879886208.31,
			chains: ["Binance", "Ethereum", "Base"],
			chainTvls: {
				Binance: 1876308470.35,
				"Binance-staking": 42222832.17,
				Ethereum: 1535652.54,
				"Polygon zkEVM": 0,
			},
			change_1d: 9.128329,
			change_7d: 11.167405,
			mcap: null,
			logo: "https://icons.llama.fi/pancakeswap.png",
			twitter: "PancakeSwap",
		},
		{
			name: "Uniswap V3",
			slug: "uniswap-v3",
			symbol: "UNI",
			category: "Dexs",
			tvl: 1408896248.7,
			chains: ["Ethereum", "Base", "Binance"],
			chainTvls: { Ethereum: 900000000, Binance: 37457523.63, Base: 400000000 },
			change_1d: 4.45,
			change_7d: -0.13,
			mcap: 5000000000,
		},
		{
			name: "Aave V3",
			slug: "aave-v3",
			symbol: "AAVE",
			category: "Lending",
			tvl: 15966267975,
			chains: ["Ethereum", "Base"],
			chainTvls: { Ethereum: 12000000000, Base: 468201950 },
			change_1d: 11.01,
			change_7d: 12.52,
		},
		{
			name: "Ghost Protocol",
			slug: "ghost-protocol",
			symbol: null,
			category: "Dexs",
			tvl: null,
			chains: ["Solana"],
			chainTvls: {},
		},
	];

	/** 400 daily points, so a default 90-point budget has to thin it. */
	const CHAIN_HISTORY = Array.from({ length: 400 }, (_, i) => ({
		date: Math.floor(Date.UTC(2025, 6, 1) / 1000) + i * 86_400,
		tvl: 1_000_000 + i * 1_000,
	}));

	const PROTOCOL_DETAIL = {
		name: "PancakeSwap AMM",
		slug: "pancakeswap-amm",
		tvl: Array.from({ length: 200 }, (_, i) => ({
			date: Math.floor(Date.UTC(2025, 6, 1) / 1000) + i * 86_400,
			totalLiquidityUSD: 500_000 + i * 2_000,
		})),
		chainTvls: {
			Binance: {
				tvl: Array.from({ length: 200 }, (_, i) => ({
					date: Math.floor(Date.UTC(2025, 6, 1) / 1000) + i * 86_400,
					totalLiquidityUSD: 400_000 + i * 1_500,
				})),
				tokens: [],
			},
		},
	};

	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		// The document memo lives at module scope, i.e. for the whole session.
		clearDefiCache();
	});

	function response(body: unknown, { status = 200, text = false } = {}) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => (text ? String(body) : JSON.stringify(body)),
		};
	}

	/** Stub `fetch`, recording every URL requested. No test here touches the network. */
	function stubFetch(handler: (url: string) => unknown) {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL) => {
			calls.push(String(url));
			return handler(String(url));
		}) as unknown as typeof fetch;
		return calls;
	}

	/** The happy path every test starts from. */
	function stubAll(overrides: Record<string, unknown> = {}) {
		return stubFetch((url) => {
			if (url in overrides) return overrides[url];
			if (url === CHAINS_URL) return response(LLAMA_CHAINS);
			if (url === GECKO_URL) return response(GECKO_NETWORKS);
			if (url === PROTOCOLS_URL) return response(LLAMA_PROTOCOLS);
			if (url.startsWith("https://api.llama.fi/v2/historicalChainTvl/")) return response(CHAIN_HISTORY);
			if (url.startsWith("https://api.llama.fi/protocol/")) return response(PROTOCOL_DETAIL);
			throw new Error(`unexpected fetch: ${url}`);
		});
	}

	describe("defi.chains", () => {
		it("defaults to TVL order, folds duplicate chain ids, and keeps chainId only for EVM", async () => {
			const calls = stubAll();
			const rows = (await defi.chains()) as ChainRow[];

			expect(calls.sort()).toEqual([CHAINS_URL, GECKO_URL].sort());
			// TVL is the default axis because it is the complete one - GeckoTerminal covers a third.
			expect(rows.map((r) => r.name)).toEqual(["Ethereum", "Solana", "BSC", "Base", "Bitcoin", "HAQQ"]);
			expect(rows).toEqual((await defi.chains({ by: "tvl" })) as ChainRow[]);
			// "BSC" and "Binance" are one chain; the $0 twin must not take a row of its own.
			expect(rows.filter((r) => r.chainId === 56)).toHaveLength(1);
			expect(rows.find((r) => r.name === "BSC")?.tvl).toBe(5201879703);
			// `chainId` is what `rpc.pick` takes, so a null one must be absent, not 0.
			expect(rows.find((r) => r.name === "Solana")).not.toHaveProperty("chainId");
			expect(rows.find((r) => r.name === "Bitcoin")).not.toHaveProperty("chainId");
			expect(rows.find((r) => r.name === "Ethereum")?.chainId).toBe(1);
			// A numeric-string chainId is still a chain id.
			expect(rows.find((r) => r.name === "HAQQ")?.chainId).toBe(11235);
			expect(rows.find((r) => r.name === "Base")?.symbol).toBeNull();
		});

		it("cuts to the top 50 by default", async () => {
			const many = Array.from({ length: 120 }, (_, i) => ({
				name: `Chain${i}`,
				chainId: i + 1000,
				tvl: 1_000_000 - i,
				tokenSymbol: "X",
				gecko_id: null,
			}));
			stubAll({ [CHAINS_URL]: response(many) });
			const rows = (await defi.chains()) as ChainRow[];

			expect(rows).toHaveLength(50);
			expect(rows[0].name).toBe("Chain0");
			expect((await defi.chains({ limit: 3 })).length).toBe(3);
		});

		it("carries GeckoTerminal volume as whole USD, parsed from the decimal string it ships", async () => {
			stubAll();
			const rows = (await defi.chains()) as ChainRow[];
			const by = (name: string) => rows.find((r) => r.name === name);

			// "6267922512.52942" joined by name, because Solana carries no chain_id on either side.
			expect(by("Solana")?.volume24h).toBe(6267922513);
			// Joined by chain id, and through the "BNB Chain" spelling neither source shares.
			expect(by("BSC")?.volume24h).toBe(2954183002);
			expect(by("Ethereum")?.volume24h).toBe(2293884121);
			// Same unit as `tvl`, so the pair divides into a turnover ratio untouched.
			expect(by("Ethereum")!.volume24h! / by("Ethereum")!.tvl).toBeCloseTo(0.0499, 3);
			// GeckoTerminal's own rank is never surfaced, however tempting the field looks.
			expect(rows.every((r) => !("rank" in r))).toBe(true);
		});

		it("orders by volume differently than by tvl, and sinks an unmeasured chain below a zero", async () => {
			stubAll();
			const byTvl = (await defi.chains({ by: "tvl" })) as ChainRow[];
			const byVolume = (await defi.chains({ by: "volume" })) as ChainRow[];

			expect(byTvl.map((r) => r.name)).toEqual(["Ethereum", "Solana", "BSC", "Base", "Bitcoin", "HAQQ"]);
			expect(byVolume.map((r) => r.name)).toEqual(["Solana", "BSC", "Ethereum", "Base", "HAQQ", "Bitcoin"]);
			expect(byVolume.map((r) => r.name)).not.toEqual(byTvl.map((r) => r.name));
			// Ethereum leads on TVL by 9x and still comes third on volume - the disagreement is signal.
			expect(byTvl[0].name).toBe("Ethereum");
			expect(byVolume.findIndex((r) => r.name === "Ethereum")).toBe(2);
			// HAQQ is measured at zero and Bitcoin is not measured at all, so HAQQ ranks higher even
			// though Bitcoin holds 300,000x its TVL.
			expect(byVolume[4]).toMatchObject({ name: "HAQQ", volume24h: 0 });
			expect(byVolume[5]).not.toHaveProperty("volume24h");
		});

		it("degrades to DefiLlama alone when GeckoTerminal fails, with volume absent rather than zero", async () => {
			stubAll({ [GECKO_URL]: response("gone", { status: 503, text: true }) });
			const rows = (await defi.chains()) as ChainRow[];

			// An unofficial endpoint going away must cost the field, not the answer.
			expect(Array.isArray(rows)).toBe(true);
			expect(rows).not.toHaveProperty("error");
			expect(rows.map((r) => r.name)).toEqual(["Ethereum", "Solana", "BSC", "Base", "Bitcoin", "HAQQ"]);
			expect(rows.every((r) => !("volume24h" in r))).toBe(true);
			expect(rows.every((r) => r.tvl > 0)).toBe(true);
			// Asking for volume order without volume is still an answer, not a lie about zero.
			const byVolume = (await defi.chains({ by: "volume" })) as ChainRow[];
			expect(byVolume.map((r) => r.name)).toEqual(rows.map((r) => r.name));
		});

		it("returns untrimmed entries under raw", async () => {
			stubAll();
			const rows = (await defi.chains({ limit: 1, raw: true })) as (typeof LLAMA_CHAINS)[number][];

			expect(rows[0].cmcId).toBe("1027");
		});

		it("returns an error value on an HTTP failure", async () => {
			stubAll({ [CHAINS_URL]: response("rate limited", { status: 429, text: true }) });
			const out = (await defi.chains()) as ErrorValue;

			expect(out.status).toBe(429);
			expect(out.error).toContain("HTTP 429");
		});

		it("throws on bad arguments", async () => {
			stubAll();
			expect(defi.chains({ limit: 0 })).rejects.toThrow(TypeError);
			expect(defi.chains({ limit: 2.5 })).rejects.toThrow(TypeError);
			expect(defi.chains({ by: "tvl?" })).rejects.toThrow(TypeError);
			// Retired rather than kept as a trap: it sorted on pool reserve, not importance.
			expect(defi.chains({ by: "liquidity" })).rejects.toThrow(/must be "tvl" or "volume"/);
		});
	});

	describe("defi.protocols", () => {
		it("filters by chain alias and category, and sorts by TVL on that chain", async () => {
			stubAll();
			const rows = (await defi.protocols({ chain: "BSC", category: "Dexes" })) as ProtocolRow[];

			// Sorted by global tvl, Uniswap V3 would lead with $1.4B while holding $37M on BNB.
			expect(rows.map((r) => r.slug)).toEqual(["pancakeswap-amm", "uniswap-v3"]);
			expect(rows[0].chainTvl).toBe(1876308470);
			// A chain-filtered row already knows its chain, so the chain list is dropped.
			expect(rows[0]).not.toHaveProperty("chains");
			expect(rows[0].d1).toBe(9.13);
			expect(rows[0].d7).toBe(11.17);
			// "Binance-staking" is accounting, not a chain.
			expect(rows[0].chainTvl).not.toBe(42222832);
		});

		it("reaches the same protocols through either spelling of chain id 56", async () => {
			stubAll();
			const bsc = (await defi.protocols({ chain: "BSC" })) as ProtocolRow[];
			const binance = (await defi.protocols({ chain: "binance" })) as ProtocolRow[];

			expect(binance.map((r) => r.slug)).toEqual(bsc.map((r) => r.slug));
		});

		it("keeps the chain list and global order when no chain is given", async () => {
			stubAll();
			const rows = (await defi.protocols({ limit: 2 })) as ProtocolRow[];

			expect(rows.map((r) => r.slug)).toEqual(["aave-v3", "pancakeswap-amm"]);
			expect(rows[0].chains).toEqual(["Ethereum", "Base"]);
			expect(rows[0]).not.toHaveProperty("chainTvl");
		});

		it("errors on an unknown chain rather than returning an empty list", async () => {
			stubAll();
			const out = (await defi.protocols({ chain: "bnb chain" })) as ErrorValue;

			expect(out.error).toContain("no DefiLlama chain named bnb chain");
		});

		it("throws on bad arguments", async () => {
			stubAll();
			expect(defi.protocols({ chain: 56 })).rejects.toThrow(TypeError);
			expect(defi.protocols({ category: "" })).rejects.toThrow(TypeError);
			expect(defi.protocols({ limit: -1 })).rejects.toThrow(TypeError);
		});
	});

	describe("defi.protocol", () => {
		it("answers current TVL from the protocol list alone, with no history", async () => {
			const calls = stubAll();
			const out = await defi.protocol("pancakeswap-amm");

			expect(calls).toEqual([PROTOCOLS_URL]);
			expect(out).not.toHaveProperty("history");
			expect(out.tvl).toBe(1879886208);
			expect(out.chainTvls.Binance).toBe(1876308470);
			// Zero-valued chains are noise; accounting keys are signal.
			expect(out.chainTvls).not.toHaveProperty("Polygon zkEVM");
			expect(out.chainTvls["Binance-staking"]).toBe(42222832);
			expect(out).not.toHaveProperty("mcap");
		});

		it("fetches the detail route only when history is asked for", async () => {
			const calls = stubAll();
			const out = await defi.protocol("pancakeswap-amm", { history: true, points: 10 });

			expect(calls).toContain("https://api.llama.fi/protocol/pancakeswap-amm");
			expect(out.history).toHaveLength(10);
			expect(out.history[0]).toEqual({ date: "2025-07-01", tvl: 500000 });
			expect(out.history.at(-1)).toEqual({ date: "2026-01-16", tvl: 898000 });
		});

		it("narrows the history to one chain", async () => {
			stubAll();
			const out = await defi.protocol("pancakeswap-amm", { history: true, points: 2, chain: "binance" });

			expect(out.history).toEqual([
				{ date: "2025-07-01", tvl: 400000 },
				{ date: "2026-01-16", tvl: 698500 },
			]);
			const miss = (await defi.protocol("pancakeswap-amm", { history: true, chain: "Solana" })) as ErrorValue;
			expect(miss.error).toContain("no TVL on Solana");
		});

		it("resolves a name, treats a null tvl as zero, and errors on an unknown slug", async () => {
			stubAll();
			expect((await defi.protocol("Uniswap V3")).slug).toBe("uniswap-v3");
			expect((await defi.protocol("ghost-protocol")).tvl).toBe(0);
			expect(((await defi.protocol("nope")) as ErrorValue).error).toContain("no protocol matching nope");
		});

		it("returns an error value when the detail route fails", async () => {
			stubAll({
				"https://api.llama.fi/protocol/pancakeswap-amm": response("Protocol not found", {
					status: 400,
					text: true,
				}),
			});
			const out = (await defi.protocol("pancakeswap-amm", { history: true })) as ErrorValue;

			expect(out.status).toBe(400);
			expect(out.error).toContain("Protocol not found");
		});

		it("throws on bad arguments", async () => {
			stubAll();
			expect(defi.protocol(null)).rejects.toThrow(TypeError);
			expect(defi.protocol("aave-v3", { history: "365" })).rejects.toThrow(TypeError);
			expect(defi.protocol("aave-v3", { history: -5 })).rejects.toThrow(TypeError);
			expect(defi.protocol("aave-v3", { points: 0 })).rejects.toThrow(TypeError);
		});
	});

	describe("defi.chain", () => {
		it("returns one chain without touching the history or protocol routes", async () => {
			const calls = stubAll();
			const out = await defi.chain("Binance");

			expect(calls).toEqual([CHAINS_URL]);
			expect(out).toEqual({ name: "BSC", chainId: 56, symbol: "BNB", tvl: 5201879703 });
		});

		it("downsamples a long series and keeps both endpoints exactly", async () => {
			stubAll();
			const out = await defi.chain("Ethereum", { history: true });

			expect(CHAIN_HISTORY).toHaveLength(400);
			expect(out.history).toHaveLength(90);
			expect(out.history[0]).toEqual({ date: "2025-07-01", tvl: 1000000 });
			expect(out.history.at(-1)).toEqual({ date: "2026-08-04", tvl: 1399000 });
		});

		it("windows to the last N days and leaves a short window at daily resolution", async () => {
			const recent = Array.from({ length: 30 }, (_, i) => ({
				date: Math.floor(Date.now() / 1000) - (29 - i) * 86_400,
				tvl: 100 + i,
			}));
			stubAll({ "https://api.llama.fi/v2/historicalChainTvl/Ethereum": response(recent) });
			const out = await defi.chain("Ethereum", { history: 10 });

			expect(out.history).toHaveLength(10);
			expect(out.history.at(-1).tvl).toBe(129);
		});

		it("errors on an unknown chain and throws on bad arguments", async () => {
			stubAll();
			expect(((await defi.chain("NopeChain")) as ErrorValue).error).toContain("no DefiLlama chain named NopeChain");
			expect(defi.chain(56)).rejects.toThrow(TypeError);
			expect(defi.chain("Ethereum", { history: {} })).rejects.toThrow(TypeError);
		});
	});

	describe("caching", () => {
		it("serves a second call from the memo and refetches on refresh", async () => {
			const calls = stubAll();
			await defi.chains();
			await defi.chains({ limit: 5 });
			await defi.chain("Ethereum");

			expect(calls).toHaveLength(2);
			expect(calls).not.toContain(PROTOCOLS_URL);

			await defi.chains({ refresh: true });
			expect(calls).toHaveLength(4);
		});

		it("never memoises the multi-megabyte protocol detail", async () => {
			const calls = stubAll();
			await defi.protocol("pancakeswap-amm", { history: true });
			await defi.protocol("pancakeswap-amm", { history: true });

			expect(calls.filter((u) => u === "https://api.llama.fi/protocol/pancakeswap-amm")).toHaveLength(2);
			// The list it shares with `protocols` is memoised, though.
			expect(calls.filter((u) => u === PROTOCOLS_URL)).toHaveLength(1);
		});

		it("does not cache a failed response", async () => {
			let status = 500;
			const calls = stubFetch((url) =>
				url === CHAINS_URL ? response(LLAMA_CHAINS, { status }) : response(GECKO_NETWORKS),
			);
			expect((await defi.chains()) as ErrorValue).toHaveProperty("status", 500);
			status = 200;
			expect(Array.isArray(await defi.chains())).toBe(true);
			expect(calls.filter((u) => u === CHAINS_URL)).toHaveLength(2);
		});
	});

	describe("helpers", () => {
		it("downsamples to the requested budget, endpoints intact", () => {
			const series = Array.from({ length: 1000 }, (_, i) => i);
			const out = downsample(series, 10);

			expect(out).toHaveLength(10);
			expect(out[0]).toBe(0);
			expect(out.at(-1)).toBe(999);
			expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
			expect(downsample([1, 2, 3], 1)).toEqual([3]);
			expect(downsample([], 5)).toEqual([]);
		});

		it("skips malformed history points instead of emitting NaN", () => {
			const out = renderHistory(
				[{ date: 1_700_000_000, totalLiquidityUSD: 5 }, { date: null, totalLiquidityUSD: 9 }, { date: 1 }],
				"totalLiquidityUSD",
				true,
				90,
			);

			expect(out).toEqual([{ date: "2023-11-14", tvl: 5 }]);
		});

		it("exposes the shapes the join depends on", () => {
			expect(foldChains(LLAMA_CHAINS)).toHaveLength(6);
			expect(foldChains(null)).toEqual([]);
			expect(volumeIndex(GECKO_NETWORKS).byId.get(56)).toBe(2954183001.5);
			expect(volumeIndex(GECKO_NETWORKS).byName.get("binancesmartchain")).toBe(2954183001.5);
			expect(volumeIndex({}).byId.size).toBe(0);
			// `Number(null)` is 0, a plausible volume, so a metric without the field must not index as one.
			const missing = { data: GECKO_NETWORKS.data, included: [{ id: "2", type: "network_metric", attributes: {} }] };
			expect(volumeIndex(missing).byId.has(56)).toBe(false);
			expect([...(chainAliases(LLAMA_CHAINS, "BSC") ?? [])]).toEqual(["bsc", "binance"]);
			expect(chainAliases(LLAMA_CHAINS, "nope")).toBeNull();
		});
	});
});

describe("web3.hypersync", () => {
	const { createHypersync, clearHypersyncCache, candidateChains } = hypersyncModule;

	type ErrorValue = { error: string; status?: number };
	type LogRow = { block_number: number; address?: string; topic0?: string; data?: string; transaction_hash?: string };

	const hs = createHypersync();
	const realFetch = globalThis.fetch;
	const realKey = process.env.HYPERSYNC_API_KEY;

	afterEach(() => {
		globalThis.fetch = realFetch;
		clearHypersyncCache();
		if (realKey === undefined) delete process.env.HYPERSYNC_API_KEY;
		else process.env.HYPERSYNC_API_KEY = realKey;
	});

	/** Stub `fetch`, recording every request. No test here touches the network. */
	function stubFetch(handler: (url: string, body: any, init?: RequestInit) => unknown) {
		const calls: { url: string; body: any; init?: RequestInit }[] = [];
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url: String(url), body, init });
			return handler(String(url), body, init);
		}) as unknown as typeof fetch;
		return calls;
	}

	function httpResponse(body: unknown, { status = 200 } = {}) {
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers(),
			json: async () => body,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
		};
	}

	/** One `/query` page in the NESTED wire shape: rows under `data[0].logs`, never top-level. */
	function page(logs: LogRow[], next_block: number | null, archive_height = 9_999_999) {
		return httpResponse({ data: [{ logs }], next_block, archive_height });
	}

	function row(i: number): LogRow {
		return { block_number: 100 + i, address: "0xa", topic0: "0xt", data: "0x", transaction_hash: `0x${i}` };
	}

	it("returns a missing-key error value without touching the network", async () => {
		delete process.env.HYPERSYNC_API_KEY;
		const calls = stubFetch(() => httpResponse({}));
		for (const out of [
			await hs.height("eth"),
			await hs.chains(),
			await hs.logs("eth", { fromBlock: 0 }),
			await hs.query("eth", {}),
		]) {
			expect((out as ErrorValue).error).toContain("HYPERSYNC_API_KEY");
		}
		expect(calls).toHaveLength(0);
	});

	it("flattens rows out of the nested data[i].logs envelope", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		stubFetch(() => page([row(0), row(1)], null, 5_000_000));
		const out = (await hs.logs("eth", { fromBlock: 0 })) as any;

		expect(out.rows).toHaveLength(2);
		expect(out.rows[0].block_number).toBe(100);
		expect(out.complete).toBe(true);
		expect(out.nextBlock).toBeNull();
		expect(out.archiveHeight).toBe(5_000_000);
		expect(out.queries).toBe(1);
	});

	it("paginates on next_block until the range completes", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		const calls = stubFetch((_url, body) =>
			body.from_block === 0 ? page([row(0)], 200) : page([row(1), row(2)], null),
		);
		const out = (await hs.logs("eth", { fromBlock: 0 })) as any;

		expect(calls).toHaveLength(2);
		expect(calls[1].body.from_block).toBe(200);
		expect(out.rows).toHaveLength(3);
		expect(out.complete).toBe(true);
		expect(out.queries).toBe(2);
	});

	it("stops at the maxRows budget and hands back the cursor to resume from", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		stubFetch((_url, body) => page([row(body.from_block), row(body.from_block + 1)], body.from_block + 100));
		const out = (await hs.logs("eth", { fromBlock: 0, maxRows: 3 })) as any;

		// Two pages of 2 rows overshoot the budget of 3 - the server completes block groups.
		expect(out.rows).toHaveLength(4);
		expect(out.complete).toBe(false);
		expect(out.nextBlock).toBe(200);
	});

	it("treats to_block as exclusive", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		const calls = stubFetch(() => page([row(0)], 2_000_000));
		const out = (await hs.logs("eth", { fromBlock: 0, toBlock: 2_000_000 })) as any;

		expect(calls).toHaveLength(1);
		expect(calls[0].body.to_block).toBe(2_000_000);
		expect(out.complete).toBe(true);
	});

	it("builds a flat topic0..3 field selection and never a topics array", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		const calls = stubFetch(() => page([], null));
		await hs.logs("eth", {
			fromBlock: 10,
			address: "0xABC",
			topic0: "0xSIG",
			topic1: "0xP1",
			topic2: "0xP2",
			topic3: "0xP3",
		});
		const body = calls[0].body;

		expect(body.from_block).toBe(10);
		expect(body.max_num_rows).toBe(5000);
		expect(body.field_selection.log).toEqual([
			"block_number",
			"address",
			"topic0",
			"topic1",
			"topic2",
			"topic3",
			"data",
			"transaction_hash",
		]);
		expect(body.field_selection.block).toEqual(["number", "timestamp"]);
		expect(body.logs[0].address).toEqual(["0xabc"]);
		expect(body.logs[0].topic0).toEqual(["0xsig"]);
		expect(body.logs[0].topic3).toEqual(["0xp3"]);
		expect(JSON.stringify(body)).not.toContain('"topics"');
		expect(calls[0].init?.headers && (calls[0].init.headers as Record<string, string>).Authorization).toBe(
			"Bearer k",
		);
	});

	it("accepts filter arrays and batches multiple selections into ONE body", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		const calls = stubFetch(() => page([], null));
		await hs.logs("eth", {
			fromBlock: 0,
			selections: [{ address: "0xa", topic0: "0xs0" }, { address: ["0xb", "0xc"] }],
		});

		expect(calls[0].body.logs).toHaveLength(2);
		expect(calls[0].body.logs[1].address).toEqual(["0xb", "0xc"]);
	});

	it("returns HTTP failures as {error, status} values that never carry the key", async () => {
		process.env.HYPERSYNC_API_KEY = "sekrit";
		stubFetch(() => httpResponse("quota exceeded", { status: 429 }));
		const out = (await hs.query("eth", { from_block: 0 })) as ErrorValue;

		expect(out.status).toBe(429);
		expect(out.error).toContain("429");
		expect(out.error).toContain("quota exceeded");
		expect(out.error).not.toContain("sekrit");
	});

	it("returns a mid-scan failure with the rows already collected and the resume cursor", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		stubFetch((_url, body) => (body.from_block === 0 ? page([row(0)], 500) : httpResponse("boom", { status: 500 })));
		const out = (await hs.logs("eth", { fromBlock: 0 })) as any;

		expect(out.error).toContain("500");
		expect(out.rows).toHaveLength(1);
		expect(out.nextBlock).toBe(500);
	});

	it("height returns the number and query passes the response through verbatim", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		const calls = stubFetch((url) =>
			url.endsWith("/height") ? httpResponse({ height: 1_234_567 }) : page([row(0)], null),
		);

		expect(await hs.height("base")).toBe(1_234_567);
		expect(calls[0].init?.method).toBe("GET");
		const out = (await hs.query("base", { from_block: 1 })) as any;
		expect(out.next_block).toBeNull();
		expect(out.data[0].logs).toHaveLength(1);
		expect(calls[1].init?.method).toBe("POST");
	});

	it("chains() probes candidates via /height, memoises, and refreshes on demand", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		const calls = stubFetch((url) =>
			url.includes("bb.hypersync") || url.includes("cc.hypersync")
				? httpResponse({ height: 1 })
				: httpResponse("nope", { status: 404 }),
		);

		expect(await hs.chains({ candidates: ["aa", "bb", "cc"] })).toEqual(["bb", "cc"]);
		expect(calls).toHaveLength(3);
		// Memoised: the second call costs no round trip; refresh re-probes.
		await hs.chains({ candidates: ["aa", "bb", "cc"] });
		expect(calls).toHaveLength(3);
		await hs.chains({ candidates: ["aa", "bb", "cc"], refresh: true });
		expect(calls).toHaveLength(6);
	});

	it("chains() returns an error value when nothing answers", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		stubFetch(() => httpResponse("unreachable", { status: 503 }));
		const out = (await hs.chains({ candidates: ["aa", "bb"] })) as ErrorValue;

		expect(out.error).toContain("none of 2");
	});

	it("ships a non-empty curated candidate list", () => {
		expect(candidateChains.length).toBeGreaterThan(20);
		expect(candidateChains).toContain("eth");
		expect(candidateChains).toContain("base");
	});

	it("throws TypeError on caller bugs", async () => {
		process.env.HYPERSYNC_API_KEY = "k";
		expect(() => hs.height("")).toThrow(TypeError);
		expect(() => hs.height("https://evil.example")).toThrow(TypeError);
		expect(() => hs.logs("eth", { fromBlock: -1 })).toThrow(TypeError);
		expect(() => hs.logs("eth", { fromBlock: 10, toBlock: 10 })).toThrow(TypeError);
		expect(() => hs.logs("eth", { fromBlock: 0, topic0: 5 as unknown as string })).toThrow(TypeError);
		// These validate inside the async method, so they surface as rejections.
		await expect(hs.logs("eth", { fromBlock: "0" as unknown as number })).rejects.toThrow(TypeError);
		await expect(hs.query("eth", [1, 2] as unknown as object)).rejects.toThrow(TypeError);
		await expect(hs.query("eth", "nope" as unknown as object)).rejects.toThrow(TypeError);
		await expect(hs.query("eth", "nope" as unknown as object)).rejects.toThrow(TypeError);
	});
});
