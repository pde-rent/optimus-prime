import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as portfolioSkill from "../skills/portfolio/skill.js";

const {
	default: createSkill,
	addressFamily,
	clearPortfolioCache,
	fromUnits,
	normalizePhantom,
	normalizeRabby,
	normalizeTron,
} = portfolioSkill;

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

const portfolio = createSkill();

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

		expect(values.filter((v) => v !== null)).toEqual([...values.filter((v) => v !== null)].sort((a, b) => b! - a!));
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
