/**
 * Token balances for one wallet, from three third-party portfolio APIs, in one item shape.
 *
 * Reading a wallet from nodes alone is the wrong tool: a balance sweep over EVM is one
 * `eth_call` per token per chain and you still need the token list, the decimals, and a price.
 * These three services already did that work and answer keylessly, so this skill is the fetch,
 * the address-family routing, and the normalisation - nothing else. No keys, no signing, no
 * node access. `web3.rpc` is the sibling module for talking to a node.
 *
 * The three payloads disagree about almost everything: field names, native-token markers, which
 * flags mean spam, and whether an amount is a string or a number. A model should not have to
 * learn three schemas to answer one question, so `balances` returns a single item shape and
 * `raw` returns the untouched payload for the extra signal normalisation drops.
 *
 * PRECISION IS THE POINT. Rabby ships `raw_amount` (a JSON number, unsafe past 2^53 - its own
 * field docs say so) alongside `raw_amount_str`; the two really do disagree in live data, e.g.
 * `133946806283165580` vs `"133946806283165590"` for one bsc position observed here. Phantom
 * ships `amount` as a string for SPL tokens. So every amount is carried as an exact decimal
 * STRING and every scaling is BigInt and string surgery, never division by `10 ** decimals`.
 * `uiAmount` is derived from that exact string, so it is the correctly-rounded double of the
 * true value rather than a double of an already-lossy integer.
 *
 * Errors follow the `rpc` and `websearch` convention: an expected, recoverable failure (the API
 * is down, rate-limited, timed out) comes back as an `{error, status?}` value so the surrounding
 * cell keeps running, while a bad argument - an address that is not one of the three supported
 * shapes - throws a TypeError, because that is a bug in the caller.
 *
 * These endpoints are undocumented, keyless, rate-limited and owned by other people. They can
 * change shape, block a client, or vanish without notice. Treat every field as best-effort.
 */

const DEFAULT_TIMEOUT_SECONDS = 15;

/** The value scale is a unit, not a loop bound; past this `10n ** BigInt(d)` is a DoS. */
const MAX_DECIMALS = 256;

/**
 * Back-to-back `balances` then `raw` is the expected pattern, and these endpoints are
 * rate-limited, so one response serves both. Short enough that nobody reads a stale balance.
 */
const RESPONSE_TTL_MS = 30_000;

const RABBY_URL = "https://api.rabby.io/v1/user/cache_token_list";

const PHANTOM_URL = "https://api.phantom.app/sniper/v1/tokenPortfolio";

const TRONGRID_URL = "https://api.trongrid.io/v1/accounts";

/** TRX is denominated in SUN. TronGrid never states this; it is the chain's fixed scale. */
const TRX_DECIMALS = 6;

/** Phantom marks native SOL with the wrapped-SOL mint rather than a separate flag. */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Base58 as Bitcoin defined it: no `0`, `O`, `I`, or `l`. Both Solana and Tron use it. */
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRON_ADDRESS = new RegExp(`^T${BASE58}{33}$`);
const SOLANA_ADDRESS = new RegExp(`^${BASE58}{32,44}$`);

/** @returns {string} A short, readable type name for an error message. */
function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * The error value returned (never thrown) for a failed fetch.
 *
 * @param {string} message
 * @param {{status?: number}} [extra]
 * @returns {{error: string, status?: number}}
 */
function failure(message, extra) {
	return { error: message, ...extra };
}

/** True for the `{error}` value this skill returns instead of throwing. */
function isFailure(value) {
	return Boolean(value) && typeof value === "object" && typeof value.error === "string";
}

/**
 * Which chain family an address belongs to, from its shape alone.
 *
 * Tron is tested before Solana on purpose: a Tron address is base58 too, and `T` plus 33 base58
 * characters also satisfies the Solana pattern. The consequence is unavoidable and worth
 * knowing - a Solana account whose base58 happens to start with `T` and is exactly 34 characters
 * long is indistinguishable from a Tron address here, and routes to Tron.
 *
 * @param {string} address
 * @returns {"evm"|"solana"|"tron"}
 * @throws {TypeError} When the address matches none of the three shapes.
 */
export function addressFamily(address) {
	if (typeof address !== "string" || address.trim() === "") {
		throw new TypeError(`portfolio: address must be a non-empty string, got ${typeName(address)}`);
	}
	const text = address.trim();
	if (EVM_ADDRESS.test(text)) return "evm";
	if (TRON_ADDRESS.test(text)) return "tron";
	if (SOLANA_ADDRESS.test(text)) return "solana";
	throw new TypeError(
		`portfolio: "${text}" is not a supported address. Expected one of: EVM "0x" + 40 hex characters, ` +
			'Solana base58 of 32-44 characters, or Tron "T" + 33 base58 characters.',
	);
}

/**
 * Scale a raw integer amount down by `decimals`, exactly.
 *
 * String surgery on the digits: no division, no `Number`, so a uint256 balance survives intact.
 * NOT `rpc.fromUnits`, which now sits one module away in `./rpc.js`. That one goes through
 * `toBigInt`, which accepts hex and REJECTS an unsafe Number; this one accepts the unsafe
 * Number two of the three portfolio APIs actually send (Phantom's native SOL row, TronGrid's
 * `balance`) and truncates it, because refusing it would drop the row. Different contracts,
 * so both exist on purpose - see the precision note in SKILL.md.
 *
 * @param {string|number|bigint} value - Raw integer amount.
 * @param {number} decimals - Unit scale, e.g. 18.
 * @returns {string} Exact decimal string, shortest form.
 * @throws {TypeError} On an unparseable value or `decimals` outside 0..256.
 */
export function fromUnits(value, decimals) {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
		throw new TypeError(`portfolio.fromUnits: decimals must be an integer in 0..${MAX_DECIMALS}`);
	}
	const digitsOrNull = typeof value === "bigint" ? value.toString() : rawInteger(value);
	if (digitsOrNull === null) throw new TypeError(`portfolio.fromUnits: "${String(value)}" is not an integer amount`);
	const raw = BigInt(digitsOrNull);
	const negative = raw < 0n;
	// padStart guarantees a whole digit, so "0.5" never comes out as ".5".
	const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
	const whole = digits.slice(0, digits.length - decimals);
	const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
	return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * The exact raw amount as a decimal string, from whichever form the API sent.
 *
 * A JSON number is accepted because two of the three APIs send one where the type definitions
 * promise a string - Phantom's native SOL row, TronGrid's `balance`. It cannot be made exact
 * after the fact: `JSON.parse` already produced a double, so the result is the exact value of
 * that double, which past 2^53 is not the integer the server meant.
 *
 * @param {unknown} value
 * @returns {string|null} Digits only, or null when the value is not an integer at all.
 */
function rawInteger(value) {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
	// ponytail: exact only to 2^53; recovering the true digits would mean parsing the JSON text
	// ourselves. Upgrade path is a streaming/bigint-aware parse if a whale account ever matters.
	if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value)).toString();
	return null;
}

/** A logo field is `""` in live Rabby and Phantom rows; an absent logo should read as absent. */
function logoOrNull(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** A finite price, or null. `0` is a real answer (an unpriced-but-known token), so it is kept. */
function priceOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Assemble one normalised item. Every source funnels through here so the shape cannot drift
 * between them, and so `uiAmount`/`valueUsd` are derived one way only.
 *
 * @returns {object} The normalised item; see the skill's `balances` JSDoc.
 */
function item({ chain, symbol, name, address, native, decimals, amount, priceUsd, verified, spam, logo }) {
	const scaled = amount !== null && Number.isInteger(decimals) ? fromUnits(amount, decimals) : null;
	const uiAmount = scaled === null ? null : Number(scaled);
	return {
		chain,
		symbol: symbol ?? null,
		name: name ?? null,
		address,
		native,
		decimals: Number.isInteger(decimals) ? decimals : null,
		amount,
		uiAmount,
		priceUsd,
		valueUsd: priceUsd === null || uiAmount === null ? null : priceUsd * uiAmount,
		verified,
		spam,
		logo,
	};
}

/**
 * Normalise a Rabby/DeBank `cache_token_list` response.
 *
 * Native coins are marked by `id` holding the chain slug (`"op"`, `"base"`) instead of a
 * contract, which is the only signal the payload carries. `chain` is kept as DeBank's own slug -
 * `eth`, `bsc`, `op`, `arb`, `base`, `opbnb`, `sonic` - and is NOT an EVM chain id.
 *
 * Spam rule: `is_scam || is_suspicious`. `is_verified` becomes `verified` and drives nothing
 * else, because an unverified token is not automatically a scam.
 *
 * @param {unknown} payload - The parsed response body.
 * @returns {object[]}
 */
export function normalizeRabby(payload) {
	if (!Array.isArray(payload)) return [];
	return payload.map((token) => {
		const id = typeof token?.id === "string" ? token.id : "";
		return item({
			chain: typeof token?.chain === "string" ? token.chain : "evm",
			symbol: token?.symbol,
			name: token?.name,
			address: id,
			native: id !== "" && !id.startsWith("0x"),
			decimals: token?.decimals,
			// raw_amount_str only. raw_amount is a double and is already wrong for large balances.
			amount: rawInteger(token?.raw_amount_str),
			priceUsd: priceOrNull(token?.price),
			verified: token?.is_verified === true,
			spam: token?.is_scam === true || token?.is_suspicious === true,
			logo: logoOrNull(token?.logo_url),
		});
	});
}

/**
 * Normalise a Phantom `tokenPortfolio` response.
 *
 * Price comes from `tokenPrices[mint].value`, not from the item's `solPrice`. `solPrice` is
 * misnamed: in live data it matched neither the token's USD price nor its SOL price (USDC read
 * `185538.31` while its USD price was `1`), it tracked the position's SOL value scaled by
 * `10 ** decimals`, and it is missing entirely from the native SOL row. `tokenPrices` is only
 * populated for positions the service actually prices, so an absent entry means unknown, not 0.
 *
 * Spam rule: `spamStatus` containing SPAM, so `POSSIBLE_SPAM` is filtered while `LOW_LIQUIDITY`
 * - a thin but real holding - is kept and merely reads as unverified. Only `VERIFIED` sets
 * `verified`. The enum is undocumented, so the rule matches on the word rather than a fixed list.
 *
 * @param {unknown} payload - The parsed response body.
 * @returns {object[]}
 */
export function normalizePhantom(payload) {
	const data = Array.isArray(payload?.data) ? payload.data : [];
	const prices = payload?.tokenPrices ?? {};
	return data.map((token) => {
		const mint = typeof token?.address === "string" ? token.address : "";
		const status = typeof token?.spamStatus === "string" ? token.spamStatus : "";
		return item({
			chain: "solana",
			symbol: token?.symbol,
			name: token?.name,
			address: mint,
			native: mint === SOL_MINT,
			decimals: token?.decimals,
			amount: rawInteger(token?.amount),
			priceUsd: priceOrNull(prices?.[mint]?.value),
			verified: status === "VERIFIED",
			spam: /spam/i.test(status),
			logo: logoOrNull(token?.logoURI),
		});
	});
}

/**
 * Normalise a TronGrid `/v1/accounts/<address>` response.
 *
 * TronGrid is an account endpoint, not a portfolio endpoint, so most of the item shape has no
 * source: a TRC20 entry is `{contract: "rawBalance"}` and nothing else. Those rows carry an
 * exact `amount` and null `decimals`, `uiAmount`, `symbol`, `name`, `priceUsd`, `valueUsd`,
 * `verified`, `spam` and `logo`. Inventing any of them would be worse than leaving them null.
 *
 * Native TRX is the exception and is fully known. Only the liquid `balance` is counted; staked
 * TRX (`frozenV2`) and TRC10 assets (`assetV2`) stay in the raw payload.
 *
 * @param {unknown} payload - The parsed response body.
 * @returns {object[]}
 */
export function normalizeTron(payload) {
	const account = Array.isArray(payload?.data) ? payload.data[0] : undefined;
	if (!account) return [];
	const out = [
		item({
			chain: "tron",
			symbol: "TRX",
			name: "TRON",
			// There is no TRX contract to name, so the native marker is the literal string.
			address: "native",
			native: true,
			decimals: TRX_DECIMALS,
			amount: rawInteger(account.balance ?? 0) ?? "0",
			priceUsd: null,
			verified: true,
			spam: false,
			logo: null,
		}),
	];
	for (const entry of Array.isArray(account.trc20) ? account.trc20 : []) {
		for (const [contract, balance] of Object.entries(entry ?? {})) {
			out.push(
				item({
					chain: "tron",
					symbol: null,
					name: null,
					address: contract,
					native: false,
					decimals: null,
					amount: rawInteger(balance),
					priceUsd: null,
					verified: null,
					spam: null,
					logo: null,
				}),
			);
		}
	}
	return out;
}

/**
 * Sort by USD value, largest first, with unpriced positions last.
 *
 * `Array.prototype.sort` is stable, so an all-unpriced list (every Tron account) keeps the
 * upstream order rather than being shuffled into an arbitrary one.
 */
function byValueDesc(a, b) {
	if (a.valueUsd === null && b.valueUsd === null) return 0;
	if (a.valueUsd === null) return 1;
	if (b.valueUsd === null) return -1;
	return b.valueUsd - a.valueUsd;
}

/**
 * GET one JSON document.
 *
 * No `User-Agent` is set: Bun's default passes all three services, and Phantom fingerprints
 * clients - a plain `curl` is answered `403` on the same URL that Bun fetches fine - so
 * substituting a custom identity is a way to get blocked, not a courtesy.
 *
 * @returns {Promise<unknown|{error: string, status?: number}>} The parsed body, or an error value.
 */
async function getJson(url, label, options = {}) {
	const seconds = Number(options.timeout ?? DEFAULT_TIMEOUT_SECONDS);
	const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
	try {
		const resp = await fetch(url, {
			headers: { Accept: "application/json", ...(options.headers ?? {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!resp.ok) {
			const detail = (await resp.text().catch(() => "")).trim().slice(0, 200);
			return failure(`portfolio: ${label} returned HTTP ${resp.status}${detail ? `: ${detail}` : ""}`, {
				status: resp.status,
			});
		}
		try {
			return await resp.json();
		} catch {
			return failure(`portfolio: ${label} returned a non-JSON body`);
		}
	} catch (e) {
		if (e?.name === "TimeoutError") return failure(`portfolio: ${label} timed out (raise { timeout })`);
		return failure(`portfolio: ${label} request failed: ${e?.message || e}`);
	}
}

/** Session memo of the last upstream response per wallet, so `balances` then `raw` is one fetch. */
const responseCache = new Map();

/** Drop the response memo. Exported for tests and for a long-lived REPL. */
export function clearPortfolioCache() {
	responseCache.clear();
}

/**
 * Fetch the upstream payload for a wallet, memoised for `RESPONSE_TTL_MS`.
 *
 * Error values are evicted as soon as they resolve: caching a 429 for half a minute would turn
 * one rate-limit into a stuck session.
 *
 * @returns {Promise<{family: string, address: string, payload: unknown}|{error: string, status?: number}>}
 */
function fetchPortfolio(address, opts = {}) {
	const family = addressFamily(address);
	// EVM addresses are case-insensitive and arrive in both plain and checksummed form; base58
	// addresses are not, so only the EVM key is folded.
	const wallet = family === "evm" ? address.trim().toLowerCase() : address.trim();
	const key = `${family}:${wallet}`;

	if (!opts.refresh) {
		const hit = responseCache.get(key);
		if (hit && Date.now() - hit.at < RESPONSE_TTL_MS) return hit.promise;
	}

	const promise = (async () => {
		let payload;
		if (family === "evm") {
			payload = await getJson(`${RABBY_URL}?id=${encodeURIComponent(wallet)}`, "Rabby", opts);
		} else if (family === "solana") {
			const query = `sniper=true&ownerAddress=${encodeURIComponent(wallet)}&limit=100&offset=0&charts=false&isRouter=true`;
			payload = await getJson(`${PHANTOM_URL}?${query}`, "Phantom", opts);
			// Phantom answers HTTP 200 with `success: false` for a request it declines to serve.
			if (!isFailure(payload) && payload?.success === false) {
				payload = failure(`portfolio: Phantom declined the request for ${wallet}`);
			}
		} else {
			payload = await getJson(`${TRONGRID_URL}/${encodeURIComponent(wallet)}`, "TronGrid", opts);
			if (!isFailure(payload) && payload?.success === false) {
				payload = failure(`portfolio: TronGrid rejected ${wallet}: ${payload?.error ?? "unknown error"}`);
			}
		}
		if (isFailure(payload)) {
			responseCache.delete(key);
			return payload;
		}
		return { family, address: wallet, payload };
	})();

	responseCache.set(key, { at: Date.now(), promise });
	return promise;
}

export function createPortfolio() {
	return {
		/**
		 * Token balances for one wallet, normalised to a single item shape and sorted by USD
		 * value, largest first.
		 *
		 * The chain family is detected from the address shape and decides the upstream service:
		 * an EVM `0x` address goes to Rabby (every EVM chain it indexes in one response), a
		 * Solana base58 address to Phantom, a Tron `T` address to TronGrid. An address matching
		 * none of the three throws.
		 *
		 * Each item is:
		 *
		 *     {
		 *       chain,      // "eth" | "bsc" | "op" | "arb" | "base" | ... | "solana" | "tron"
		 *       symbol,     // string, or null when the source does not carry one (Tron TRC20)
		 *       name,       // string, or null
		 *       address,    // contract or mint; the chain slug for an EVM native coin,
		 *                   // the wrapped-SOL mint for SOL, the string "native" for TRX
		 *       native,     // boolean
		 *       decimals,   // number, or null when unknown (Tron TRC20)
		 *       amount,     // EXACT raw integer as a decimal STRING - never a float
		 *       uiAmount,   // display number derived from `amount`, or null
		 *       priceUsd,   // number, or null when the source does not price it
		 *       valueUsd,   // priceUsd * uiAmount, or null
		 *       verified,   // boolean, or null when the source has no opinion (Tron)
		 *       spam,       // boolean, or null when the source has no opinion (Tron)
		 *       logo,       // URL string, or null
		 *     }
		 *
		 * Spam is dropped by default. An item is spam when Rabby reports `is_scam` or
		 * `is_suspicious`, or when Phantom's `spamStatus` contains SPAM (so `POSSIBLE_SPAM` goes,
		 * `LOW_LIQUIDITY` stays). TronGrid publishes no spam signal at all, so Tron items have
		 * `spam: null` and are never filtered - `{ includeSpam }` cannot help there.
		 *
		 * Returns `{error, status?}` rather than throwing when the upstream service is down,
		 * rate-limited, or times out. A bad address throws a TypeError.
		 *
		 * @param {string} address - An EVM, Solana, or Tron address.
		 * @param {object} [opts]
		 * @param {boolean} [opts.includeSpam=false] - Keep items flagged as spam.
		 * @param {number} [opts.timeout=15] - Timeout in seconds.
		 * @param {boolean} [opts.refresh=false] - Bypass the 30s response memo.
		 * @param {Record<string,string>} [opts.headers] - Extra request headers.
		 * @returns {Promise<object[]|{error: string, status?: number}>} Items, or an error value.
		 * @throws {TypeError} When the address matches none of the three supported shapes.
		 */
		async balances(address, opts = {}) {
			const fetched = await fetchPortfolio(address, opts);
			if (isFailure(fetched)) return fetched;

			const { family, payload } = fetched;
			let items;
			if (family === "evm") items = normalizeRabby(payload);
			else if (family === "solana") items = normalizePhantom(payload);
			else items = normalizeTron(payload);

			// `spam === null` means the source has no opinion, which is not the same as clean, so
			// it survives the filter; only a positive spam flag is dropped.
			if (!opts.includeSpam) items = items.filter((entry) => entry.spam !== true);
			return items.sort(byValueDesc);
		},

		/**
		 * The upstream payload for a wallet, exactly as the service returned it.
		 *
		 * Normalisation deliberately drops per-service signal that has no equivalent elsewhere,
		 * and this is how to reach it without a second round trip - a `balances` call within the
		 * last 30 seconds is served from the same memo.
		 *
		 * | family | shape | worth reading |
		 * |---|---|---|
		 * | evm | `RabbyEvmTokenItem[]` | `cex_ids`, `fdv`, `price_24h_change`, `credit_score`, `is_core`, `is_wallet`, `protocol_id` |
		 * | solana | `{success, data, tokenPrices?, sparkCharts?}` | `tokenPrices[mint]` realised/unrealised PnL, cost basis, 5m..24h price changes; `sparkCharts[mint]` price history |
		 * | tron | `{data: [account], success, meta}` | `frozenV2` staked TRX, `assetV2` TRC10 balances, `account_resource` energy and bandwidth |
		 *
		 * @param {string} address - An EVM, Solana, or Tron address.
		 * @param {object} [opts] - As `balances`; `includeSpam` does not apply.
		 * @returns {Promise<unknown|{error: string, status?: number}>} The parsed body, or an error value.
		 * @throws {TypeError} When the address matches none of the three supported shapes.
		 */
		async raw(address, opts = {}) {
			const fetched = await fetchPortfolio(address, opts);
			return isFailure(fetched) ? fetched : fetched.payload;
		},

		/**
		 * Which chain family an address belongs to, without making a request.
		 *
		 * @param {string} address
		 * @returns {"evm"|"solana"|"tron"}
		 * @throws {TypeError} When the address matches none of the three supported shapes.
		 */
		family: addressFamily,

		fromUnits,
	};
}
