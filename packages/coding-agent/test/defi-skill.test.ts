import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as defiSkill from "../skills/defi/skill.js";

const {
	default: createSkill,
	chainAliases,
	clearDefiCache,
	downsample,
	foldChains,
	rankIndex,
	renderHistory,
} = defiSkill;

type ErrorValue = { error: string; status?: number };
type ChainRow = { name: string; chainId?: number; symbol: string | null; tvl: number; rank?: number };
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

const defi = createSkill();

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

const GECKO_RANKING = {
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
	],
	included: [
		{ id: "8", type: "network_metric", attributes: { rank_by_liquidity: 1, reserve_in_usd: "388992917336.672" } },
		{ id: "2", type: "network_metric", attributes: { rank_by_liquidity: 2 } },
		{ id: "3", type: "network_metric", attributes: { rank_by_liquidity: 3 } },
		{ id: "4", type: "network_metric", attributes: { rank_by_liquidity: 8 } },
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
		chainTvls: { Binance: 1876308470.35, "Binance-staking": 42222832.17, Ethereum: 1535652.54, "Polygon zkEVM": 0 },
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
		if (url === GECKO_URL) return response(GECKO_RANKING);
		if (url === PROTOCOLS_URL) return response(LLAMA_PROTOCOLS);
		if (url.startsWith("https://api.llama.fi/v2/historicalChainTvl/")) return response(CHAIN_HISTORY);
		if (url.startsWith("https://api.llama.fi/protocol/")) return response(PROTOCOL_DETAIL);
		throw new Error(`unexpected fetch: ${url}`);
	});
}

describe("defi.chains", () => {
	it("ranks by liquidity, folds duplicate chain ids, and keeps chainId only for EVM", async () => {
		const calls = stubAll();
		const rows = (await defi.chains()) as ChainRow[];

		expect(calls.sort()).toEqual([CHAINS_URL, GECKO_URL].sort());
		expect(rows.map((r) => r.name)).toEqual(["Solana", "BSC", "Ethereum", "Base", "Bitcoin", "HAQQ"]);
		expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 8, undefined, undefined]);
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

	it("sorts by tvl on request and drops only the rank when the ranking source fails", async () => {
		stubAll({ [GECKO_URL]: response("gone", { status: 503, text: true }) });
		const rows = (await defi.chains({ by: "tvl" })) as ChainRow[];

		expect(rows[0].name).toBe("Ethereum");
		expect(rows.every((r) => r.rank === undefined)).toBe(true);
	});

	it("returns untrimmed entries under raw", async () => {
		stubAll();
		const rows = (await defi.chains({ limit: 1, raw: true })) as (typeof LLAMA_CHAINS)[number][];

		expect(rows[0].cmcId).toBe("5426");
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
		expect(defi.chains({ by: "volume" })).rejects.toThrow(TypeError);
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
			"https://api.llama.fi/protocol/pancakeswap-amm": response("Protocol not found", { status: 400, text: true }),
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
			url === CHAINS_URL ? response(LLAMA_CHAINS, { status }) : response(GECKO_RANKING),
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
		expect(rankIndex(GECKO_RANKING).byId.get(56)).toBe(2);
		expect(rankIndex(GECKO_RANKING).byName.get("binancesmartchain")).toBe(2);
		expect(rankIndex({}).byId.size).toBe(0);
		expect([...(chainAliases(LLAMA_CHAINS, "BSC") ?? [])]).toEqual(["bsc", "binance"]);
		expect(chainAliases(LLAMA_CHAINS, "nope")).toBeNull();
	});
});
