/**
 * Chain and protocol analytics: which chains matter, which protocols are biggest on one, and
 * what TVL is now and was before.
 *
 * Two keyless sources answer all four questions, so this skill is the fetch, the join, and -
 * mostly - the trimming. DefiLlama carries TVL for 461 chains and 8088 protocols; GeckoTerminal
 * carries the DEX volume DefiLlama has no equivalent for. Neither needs a key.
 *
 * ONE METRIC, ONE SOURCE. TVL is always DefiLlama's and DEX volume is always GeckoTerminal's,
 * with no overlap and no fallback across the seam: no `tvl` here was ever sourced from
 * GeckoTerminal and no `volume24h` from DefiLlama. That is what makes the field name sufficient
 * provenance, so no row has to carry a source tag.
 *
 * TRIMMING IS THE FEATURE. `/protocols` is 8.6 MB and one `/protocol/{slug}` detail is 13 MB;
 * a chain history is 3250 daily points. Those numbers are the reason this file exists rather
 * than a bare `fetch` at the call site: everything here is sized so a whole answer is a few
 * kilobytes. `defi.chains()` is 3.3 KB for 50 chains and a chain-filtered `defi.protocols()`
 * 2.3 KB for 20 - a thirteenth of the untrimmed rows, and a four-thousandth of the document
 * they came from. History is excluded unless asked for and downsampled when it is.
 *
 * THE JOIN IS NOT BY NAME. Live data really does ship two `/v2/chains` rows for chain id 56 -
 * "BSC" holding $5.2B and "Binance" holding $0 - and `/protocols` labels its chains with the
 * second spelling while people write the first. So the numeric chain id is the identity, the
 * names hanging off it are aliases, and a `{ chain }` filter is resolved through that set
 * rather than by string equality. Categories drift the same way: live data says "Dexs" where
 * every caller writes "Dexes", so category matching is singularised.
 *
 * GECKOTERMINAL'S `rank_by_liquidity` IS DELIBERATELY NOT READ. It counts raw pool reserve, so it
 * ranks Solana first on $389B against Ethereum's $5.2B while DefiLlama has Ethereum at $46B TVL
 * and Solana at $5.2B, and it seats Near ($0.1B TVL) above Tron ($5.0B). The wrong field, not the
 * wrong source: the same payload's `swap_volume_usd_24h` is the authoritative DEX volume, so that
 * is what rides on the row and what `{ by: "volume" }` sorts on.
 *
 * Errors follow the `rpc` and `portfolio` convention: an upstream that is down, rate-limited or
 * slow comes back as an `{error, status?}` value so the surrounding cell keeps running, while a
 * bad argument throws a TypeError, because that is a bug in the caller.
 */

const LLAMA = "https://api.llama.fi";

/**
 * The public `api.geckoterminal.com/v2/networks` route lists networks but carries no metrics at
 * all - no volume, no liquidity, no chain id - so nothing can be joined off it. This internal
 * route is the only free source of DEX volume, and being internal it may change or vanish; when
 * it does, `chains` answers from DefiLlama alone with no `volume24h` rather than failing.
 */
const GECKO_VOLUME_URL = "https://app.geckoterminal.com/api/p1/networks?page=1&include=network_metric";

/** Long enough that a burst of related questions costs one download, short enough to act on. */
const DOC_TTL_MS = 10 * 60_000;

/** `/protocols` is 8.6 MB; a 15s budget times out on a slow link mid-download. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** A window at or under this stays daily, so `{ history: 90 }` is 90 untouched points. */
const DEFAULT_HISTORY_POINTS = 90;

const SECONDS_PER_DAY = 86_400;

/** Shared documents only. The 13 MB protocol detail is deliberately absent - see `protocol`. */
const docCache = new Map();

/** Drop every memoised document. Exported for tests. */
export function clearDefiCache() {
	docCache.clear();
}

/** @returns {string} A short, readable type name for an error message. */
function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function failure(message, extra) {
	return extra?.status ? { error: message, status: extra.status } : { error: message };
}

function isFailure(value) {
	return typeof value === "object" && value !== null && typeof (/** @type {any} */ (value).error) === "string";
}

/** Names arrive as "BNB Chain", "bnb-chain" and "bnbchain" for the same thing. */
function norm(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

/** "Dexes" and "Dexs" are the same category; only one of them is what the API returns. */
function singular(value) {
	return norm(value).replace(/e?s$/, "");
}

function round2(value) {
	return Math.round(value * 100) / 100;
}

/**
 * @throws {TypeError} When `value` is not a positive integer.
 * @returns {number}
 */
function checkCount(value, fallback, label, name) {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new TypeError(`${label}: ${name} must be a positive integer, got ${typeName(value)}`);
	}
	return value;
}

/**
 * @throws {TypeError} When `value` is neither absent, `true`, nor a positive day count.
 * @returns {false|true|number} `false` for no history, `true` for the whole series, else days.
 */
function checkHistory(value, label) {
	if (value === undefined || value === false) return false;
	if (value === true) return true;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${label}: history must be true or a positive number of days, got ${typeName(value)}`);
	}
	return value;
}

/**
 * @throws {TypeError} When `value` is not a non-empty string.
 * @returns {string}
 */
function checkString(value, label, name) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError(`${label}: ${name} must be a non-empty string, got ${typeName(value)}`);
	}
	return value.trim();
}

/**
 * One GET, JSON out.
 *
 * @throws {Error} With `.status` on an HTTP error, without one on a timeout or network failure.
 */
async function getJson(url, timeoutSeconds) {
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(timeoutSeconds * 1000),
	});
	if (!response.ok) {
		// A bad slug answers `400 Protocol not found` as plain text, so the body is worth a look
		// but is not necessarily JSON.
		const detail = await response.text().then(
			(t) => t.slice(0, 120).trim(),
			() => "",
		);
		const error = new Error(`returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
		/** @type {any} */ (error).status = response.status;
		throw error;
	}
	return await response.json();
}

/** @returns {Promise<any>} The document, or an `{error, status?}` value. */
async function loadDoc(url, opts, label) {
	const cached = opts.refresh ? undefined : docCache.get(url);
	if (cached && Date.now() - cached.at < DOC_TTL_MS) return cached.doc;
	try {
		const doc = await getJson(url, opts.timeout ?? DEFAULT_TIMEOUT_SECONDS);
		docCache.set(url, { at: Date.now(), doc });
		return doc;
	} catch (error) {
		const status = /** @type {any} */ (error)?.status;
		if (status) return failure(`${label}: ${url} ${/** @type {Error} */ (error).message}`, { status });
		const reason =
			/** @type {any} */ (error)?.name === "TimeoutError"
				? "timed out (raise { timeout })"
				: String(/** @type {any} */ (error)?.message ?? error);
		return failure(`${label}: request to ${url} failed: ${reason}`);
	}
}

/**
 * One row per real chain, duplicate DefiLlama entries folded onto the numeric id.
 *
 * `chainId` arrives as a number, a numeric string, or null, and `Number(null)` is `0` - a
 * perfectly valid-looking id - so null has to be rejected before the conversion, not after.
 *
 * @returns {Array<{name: string, chainId?: number, symbol: string|null, tvl: number, names: string[], gecko: string|null, src: any}>}
 */
export function foldChains(doc) {
	const byKey = new Map();
	for (const entry of Array.isArray(doc) ? doc : []) {
		if (!entry || typeof entry.name !== "string") continue;
		const id = entry.chainId == null ? Number.NaN : Number(entry.chainId);
		const chainId = Number.isFinite(id) && id !== 0 ? id : undefined;
		const tvl = typeof entry.tvl === "number" ? entry.tvl : 0;
		const key = chainId === undefined ? `name:${norm(entry.name)}` : `id:${chainId}`;
		const row = byKey.get(key);
		if (!row) {
			byKey.set(key, {
				name: entry.name,
				chainId,
				symbol: entry.tokenSymbol ?? null,
				tvl,
				names: [norm(entry.name)],
				gecko: entry.gecko_id ?? null,
				src: entry,
			});
			continue;
		}
		row.names.push(norm(entry.name));
		// The alias holding the money is the one worth showing; the $0 twin keeps only its name.
		if (tvl > row.tvl) {
			row.name = entry.name;
			row.tvl = tvl;
			row.symbol = entry.tokenSymbol ?? null;
			row.gecko = entry.gecko_id ?? null;
			row.src = entry;
		}
	}
	return [...byKey.values()];
}

/**
 * 24h DEX volume in USD, keyed by every identifier GeckoTerminal offers, because 12 of its 50
 * networks are non-EVM and carry no chain id to join on.
 *
 * The metric hangs off the included `network_metric`, never off the network itself, and every
 * money field in it is a decimal STRING - `swap_volume_usd_24h` is `"6267922512.52942"`, so the
 * `Number` is load-bearing rather than defensive.
 *
 * @returns {{byId: Map<number, number>, byName: Map<string, number>}}
 */
export function volumeIndex(doc) {
	const metrics = new Map();
	for (const item of doc?.included ?? []) {
		if (item?.type === "network_metric" && item.attributes) metrics.set(item.id, item.attributes);
	}
	const byId = new Map();
	const byName = new Map();
	for (const network of doc?.data ?? []) {
		const attributes = network?.attributes;
		if (!attributes) continue;
		const raw = metrics.get(network.relationships?.network_metric?.data?.id)?.swap_volume_usd_24h;
		// `Number(null)` is 0, an entirely plausible volume, so null goes before the conversion.
		const volume = raw == null ? Number.NaN : Number(raw);
		if (!Number.isFinite(volume)) continue;
		const id = attributes.chain_id == null ? Number.NaN : Number(attributes.chain_id);
		if (Number.isFinite(id) && !byId.has(id)) byId.set(id, volume);
		for (const alias of [attributes.name, attributes.identifier, attributes.cg_network_id]) {
			const key = norm(alias);
			if (key && !byName.has(key)) byName.set(key, volume);
		}
	}
	return { byId, byName };
}

function volumeOf(row, index) {
	if (row.chainId !== undefined) {
		const byId = index.byId.get(row.chainId);
		if (byId !== undefined) return byId;
	}
	for (const name of row.names) {
		const byName = index.byName.get(name);
		if (byName !== undefined) return byName;
	}
	return index.byName.get(norm(row.gecko));
}

function chainRow(row, volume) {
	/** @type {Record<string, unknown>} */
	const out = { name: row.name };
	if (row.chainId !== undefined) out.chainId = row.chainId;
	out.symbol = row.symbol;
	out.tvl = Math.round(row.tvl);
	// Whole USD, the unit `tvl` uses, so the two divide into a turnover ratio as they stand.
	if (volume !== undefined) out.volume24h = Math.round(volume);
	return out;
}

/**
 * Every DefiLlama spelling of the chain a caller named, found through the id they share.
 *
 * @returns {Set<string>|null} `null` when the name matches no chain at all, which is worth an
 *   error rather than an empty result - "no such chain" and "no protocols there" read alike.
 */
export function chainAliases(doc, query) {
	const wanted = norm(query);
	const aliases = new Set();
	const ids = new Set();
	for (const entry of Array.isArray(doc) ? doc : []) {
		if (norm(entry?.name) !== wanted && norm(entry?.gecko_id) !== wanted) continue;
		aliases.add(norm(entry.name));
		if (entry.chainId != null) ids.add(String(entry.chainId));
	}
	if (aliases.size === 0) return null;
	for (const entry of doc) {
		if (entry?.chainId != null && ids.has(String(entry.chainId))) aliases.add(norm(entry.name));
	}
	return aliases;
}

/**
 * The protocol's TVL on one chain, or `undefined` when it holds nothing there.
 *
 * `chainTvls` mixes real chain keys with accounting ones - `staking`, `borrowed`,
 * `Binance-staking` - and normalising the key is what keeps those out of the answer.
 */
function chainTvlOf(entry, aliases) {
	let best;
	for (const [key, value] of Object.entries(entry?.chainTvls ?? {})) {
		if (typeof value !== "number" || !aliases.has(norm(key))) continue;
		if (best === undefined || value > best) best = value;
	}
	return best;
}

function protocolRow(entry, chainTvl) {
	/** @type {Record<string, unknown>} */
	const out = {
		name: entry.name,
		slug: entry.slug,
		category: entry.category ?? null,
		tvl: Math.round(entry.tvl ?? 0),
	};
	// A chain-filtered row already knows its chain, and the chain list is the biggest field on
	// it - Uniswap V3 lists 40 chains - so the two are mutually exclusive by design.
	if (chainTvl === undefined) out.chains = Array.isArray(entry.chains) ? entry.chains : [];
	else out.chainTvl = Math.round(chainTvl);
	if (typeof entry.change_1d === "number") out.d1 = round2(entry.change_1d);
	if (typeof entry.change_7d === "number") out.d7 = round2(entry.change_7d);
	return out;
}

/**
 * Stride-sample a series down to `points`.
 *
 * The first and last observation survive exactly, because "TVL now against TVL then" is the
 * question a history answers; bucket-averaging would blur precisely those two endpoints.
 */
export function downsample(series, points) {
	if (points < 2) return series.length > 0 ? [series[series.length - 1]] : [];
	if (series.length <= points) return series;
	const step = (series.length - 1) / (points - 1);
	const out = [];
	for (let i = 0; i < points; i++) out.push(series[Math.round(i * step)]);
	return out;
}

/**
 * Normalise, window, downsample and render one TVL series.
 *
 * Both upstream shapes are `{date}` in unix seconds against a differently named value, and the
 * dates come back as ISO days because a model reads those without arithmetic.
 */
export function renderHistory(series, valueKey, history, points) {
	const cutoff = typeof history === "number" ? Date.now() / 1000 - history * SECONDS_PER_DAY : -Infinity;
	const kept = [];
	for (const point of Array.isArray(series) ? series : []) {
		// `Number(null)` is 0, which is both finite and a real unix timestamp, so null has to go
		// before the conversion - the same trap `foldChains` steps around for `chainId`.
		const at = point?.date == null ? Number.NaN : Number(point.date);
		const value = point?.[valueKey] == null ? Number.NaN : Number(point[valueKey]);
		if (!Number.isFinite(at) || !Number.isFinite(value) || at < cutoff) continue;
		kept.push({ date: new Date(at * 1000).toISOString().slice(0, 10), tvl: Math.round(value) });
	}
	return downsample(kept, points);
}

export default function createSkill() {
	return {
		/**
		 * The chains worth caring about, by TVL, carrying DEX volume alongside.
		 *
		 * Each row is `{name, chainId?, symbol, tvl, volume24h?}`. `tvl` is DefiLlama's and
		 * `volume24h` is GeckoTerminal's 24h DEX volume - the field name is the source, always.
		 * `name` is the DefiLlama spelling, which is what `defi.chain` and
		 * `defi.protocols({ chain })` take; `chainId` is present only for EVM chains, where it
		 * feeds `rpc.pick(chainId)` from the sibling skill directly.
		 *
		 * The universe is DefiLlama's 459 chains and GeckoTerminal's first page covers 44 of them,
		 * so `volume24h` is ABSENT on roughly a third of a default 50-row answer - both for chains
		 * with no DEX activity at all (Bitcoin, Hyperliquid L1) and for small ones off the page.
		 * That is why the default is `{ by: "tvl" }`, which is complete, and why `{ by: "volume" }`
		 * is opt-in - it sinks every chain without a volume below every chain with one. If
		 * GeckoTerminal is unreachable the call still succeeds, in TVL order, with no `volume24h`.
		 *
		 * The two disagree, and the disagreement is the signal - Tron sits 5th on TVL and 10th on
		 * volume, X Layer 24th and 7th. Divide them for turnover.
		 *
		 * @param {object} [opts]
		 * @param {number} [opts.limit=50] - How many rows to return.
		 * @param {"tvl"|"volume"} [opts.by="tvl"] - Sort key.
		 * @param {boolean} [opts.raw=false] - Untrimmed DefiLlama entries instead of rows.
		 * @param {boolean} [opts.refresh=false] - Bypass the 10 minute memo.
		 * @param {number} [opts.timeout=30] - Timeout in seconds.
		 * @returns {Promise<object[]|{error: string, status?: number}>} Rows, or an error value.
		 * @throws {TypeError} On a bad `limit` or `by`.
		 */
		async chains(opts = {}) {
			const limit = checkCount(opts.limit, 50, "defi.chains", "limit");
			const by = opts.by ?? "tvl";
			if (by !== "tvl" && by !== "volume") {
				throw new TypeError(`defi.chains: by must be "tvl" or "volume", got ${JSON.stringify(opts.by)}`);
			}
			const [doc, gecko] = await Promise.all([
				loadDoc(`${LLAMA}/v2/chains`, opts, "defi.chains"),
				loadDoc(GECKO_VOLUME_URL, opts, "defi.chains"),
			]);
			if (isFailure(doc)) return doc;

			// Volume rides on an unofficial endpoint; losing it should cost the `volume24h` field,
			// not the answer.
			const index = isFailure(gecko) ? { byId: new Map(), byName: new Map() } : volumeIndex(gecko);
			const rows = foldChains(doc).map((row) => ({ row, volume: volumeOf(row, index) }));
			// -1 rather than 0, so a chain with no volume sorts below one measured at zero.
			rows.sort((a, b) =>
				by === "volume" ? (b.volume ?? -1) - (a.volume ?? -1) || b.row.tvl - a.row.tvl : b.row.tvl - a.row.tvl,
			);
			const top = rows.slice(0, limit);
			return opts.raw ? top.map((e) => e.row.src) : top.map((e) => chainRow(e.row, e.volume));
		},

		/**
		 * One chain's TVL now, and its history only when asked for.
		 *
		 * `{ history: true }` returns the whole series - 3250 daily points for Ethereum, going
		 * back to 2017 - and `{ history: 90 }` the last 90 days. Either way the result is
		 * stride-sampled to `points` (90 by default, first and last kept exactly), so a window of
		 * 90 days or fewer stays daily and a longer one thins out instead of flooding the answer.
		 *
		 * @param {string} name - A DefiLlama chain name, as `chains()` returns.
		 * @param {object} [opts]
		 * @param {true|number} [opts.history] - Whole series, or the last N days.
		 * @param {number} [opts.points=90] - Downsample budget.
		 * @param {boolean} [opts.refresh=false] - Bypass the 10 minute memo.
		 * @param {number} [opts.timeout=30] - Timeout in seconds.
		 * @returns {Promise<object|{error: string, status?: number}>} `{name, chainId?, symbol,
		 *   tvl, history?}`, or an error value.
		 * @throws {TypeError} On a bad `name`, `history`, or `points`.
		 */
		async chain(name, opts = {}) {
			const wanted = checkString(name, "defi.chain", "name");
			const history = checkHistory(opts.history, "defi.chain");
			const points = checkCount(opts.points, DEFAULT_HISTORY_POINTS, "defi.chain", "points");
			const doc = await loadDoc(`${LLAMA}/v2/chains`, opts, "defi.chain");
			if (isFailure(doc)) return doc;

			const key = norm(wanted);
			const rows = foldChains(doc);
			const row = rows.find((r) => r.names.includes(key)) ?? rows.find((r) => norm(r.gecko) === key);
			if (!row) return failure(`defi.chain: no DefiLlama chain named ${wanted} (defi.chains() lists them)`);
			const out = chainRow(row, undefined);
			if (!history) return out;

			const series = await loadDoc(
				`${LLAMA}/v2/historicalChainTvl/${encodeURIComponent(row.name)}`,
				opts,
				"defi.chain",
			);
			if (isFailure(series)) return series;
			out.history = renderHistory(series, "tvl", history, points);
			return out;
		},

		/**
		 * The biggest protocols, filtered by chain and category.
		 *
		 * `{ chain }` is the case the trimming exists for. It resolves aliases through the chain
		 * id, so `"BSC"` and `"Binance"` reach the same protocols, and it
		 * switches the row to `chainTvl` sorted by that value - which is the only honest ordering
		 * for the question. Sorting a chain-filtered list by global TVL puts Uniswap V3 second on
		 * BNB with $1.4B, of which $37M is actually there.
		 *
		 * `{ category }` matches singularised, because live data says `"Dexs"` where callers write
		 * `"Dexes"`. Rows are `{name, slug, category, tvl, chainTvl|chains, d1, d7}`; `d1`/`d7` are
		 * percent change over 1 and 7 days. `{ raw: true }` returns the untrimmed entries for the
		 * selected rows - mcap, url, audits, twitter, oracles and the rest - with no second fetch.
		 *
		 * @param {object} [opts]
		 * @param {string} [opts.chain] - DefiLlama chain name; any alias of it works.
		 * @param {string} [opts.category] - e.g. `"Dexes"`, `"Lending"`, `"Liquid Staking"`.
		 * @param {number} [opts.limit=20] - How many rows to return.
		 * @param {boolean} [opts.raw=false] - Untrimmed entries instead of rows.
		 * @param {boolean} [opts.refresh=false] - Bypass the 10 minute memo.
		 * @param {number} [opts.timeout=30] - Timeout in seconds.
		 * @returns {Promise<object[]|{error: string, status?: number}>} Rows, or an error value.
		 * @throws {TypeError} On a bad `chain`, `category`, or `limit`.
		 */
		async protocols(opts = {}) {
			const chain = opts.chain === undefined ? undefined : checkString(opts.chain, "defi.protocols", "chain");
			const category =
				opts.category === undefined ? undefined : checkString(opts.category, "defi.protocols", "category");
			const limit = checkCount(opts.limit, 20, "defi.protocols", "limit");
			const doc = await loadDoc(`${LLAMA}/protocols`, opts, "defi.protocols");
			if (isFailure(doc)) return doc;

			let aliases;
			if (chain !== undefined) {
				const chainsDoc = await loadDoc(`${LLAMA}/v2/chains`, opts, "defi.protocols");
				if (isFailure(chainsDoc)) return chainsDoc;
				aliases = chainAliases(chainsDoc, chain);
				if (!aliases)
					return failure(`defi.protocols: no DefiLlama chain named ${chain} (defi.chains() lists them)`);
			}
			const wantedCategory = category === undefined ? undefined : singular(category);

			const picked = [];
			for (const entry of Array.isArray(doc) ? doc : []) {
				if (!entry?.slug) continue;
				if (wantedCategory !== undefined && singular(entry.category) !== wantedCategory) continue;
				let chainTvl;
				if (aliases) {
					if (!(Array.isArray(entry.chains) ? entry.chains : []).some((c) => aliases.has(norm(c)))) continue;
					chainTvl = chainTvlOf(entry, aliases) ?? 0;
				}
				picked.push({ entry, chainTvl });
			}
			picked.sort((a, b) => (aliases ? b.chainTvl - a.chainTvl : (b.entry.tvl ?? 0) - (a.entry.tvl ?? 0)));
			const top = picked.slice(0, limit);
			return opts.raw ? top.map((p) => p.entry) : top.map((p) => protocolRow(p.entry, p.chainTvl));
		},

		/**
		 * One protocol's TVL, globally and per chain, plus history only when asked for.
		 *
		 * Without `{ history }` this costs no fetch beyond the memoised protocol list, so the
		 * common question is nearly free. With it, DefiLlama's detail route is the only source of
		 * the series and it is a MULTI-MEGABYTE download - 13 MB for PancakeSwap - which is why it
		 * is opt-in and why, alone among the requests here, it is never memoised. `{ chain }`
		 * narrows the series to one chain instead of the global total.
		 *
		 * `chainTvls` keeps DefiLlama's accounting keys alongside real chains - `staking`,
		 * `borrowed`, `pool2`, `Binance-staking` - minus everything sitting at zero. There is no
		 * `raw` here on purpose: the untrimmed detail would be megabytes in the answer. Read
		 * `https://api.llama.fi/protocol/{slug}` directly if you truly want all of it.
		 *
		 * @param {string} slug - DefiLlama slug, e.g. `"pancakeswap-amm"`; a name also resolves.
		 * @param {object} [opts]
		 * @param {true|number} [opts.history] - Whole series, or the last N days.
		 * @param {string} [opts.chain] - Restrict the history to one chain.
		 * @param {number} [opts.points=90] - Downsample budget.
		 * @param {boolean} [opts.refresh=false] - Bypass the 10 minute memo.
		 * @param {number} [opts.timeout=30] - Timeout in seconds.
		 * @returns {Promise<object|{error: string, status?: number}>} `{name, slug, category,
		 *   symbol, tvl, chains, chainTvls, d1?, d7?, mcap?, history?}`, or an error value.
		 * @throws {TypeError} On a bad `slug`, `history`, `chain`, or `points`.
		 */
		async protocol(slug, opts = {}) {
			const wanted = checkString(slug, "defi.protocol", "slug");
			const history = checkHistory(opts.history, "defi.protocol");
			const chain = opts.chain === undefined ? undefined : checkString(opts.chain, "defi.protocol", "chain");
			const points = checkCount(opts.points, DEFAULT_HISTORY_POINTS, "defi.protocol", "points");
			const doc = await loadDoc(`${LLAMA}/protocols`, opts, "defi.protocol");
			if (isFailure(doc)) return doc;

			const list = Array.isArray(doc) ? doc : [];
			const key = norm(wanted);
			const entry =
				list.find((p) => p?.slug === wanted) ?? list.find((p) => norm(p?.slug) === key || norm(p?.name) === key);
			if (!entry) return failure(`defi.protocol: no protocol matching ${wanted} (defi.protocols() lists them)`);

			/** @type {Record<string, unknown>} */
			const out = {
				name: entry.name,
				slug: entry.slug,
				category: entry.category ?? null,
				symbol: entry.symbol ?? null,
				tvl: Math.round(entry.tvl ?? 0),
				chains: Array.isArray(entry.chains) ? entry.chains : [],
				chainTvls: Object.fromEntries(
					Object.entries(entry.chainTvls ?? {})
						.filter(([, v]) => typeof v === "number" && Math.round(v) !== 0)
						.sort((a, b) => Number(b[1]) - Number(a[1]))
						.map(([k, v]) => [k, Math.round(Number(v))]),
				),
			};
			if (typeof entry.change_1d === "number") out.d1 = round2(entry.change_1d);
			if (typeof entry.change_7d === "number") out.d7 = round2(entry.change_7d);
			if (typeof entry.mcap === "number") out.mcap = Math.round(entry.mcap);
			if (!history) return out;

			const url = `${LLAMA}/protocol/${encodeURIComponent(entry.slug)}`;
			let detail;
			try {
				detail = await getJson(url, opts.timeout ?? DEFAULT_TIMEOUT_SECONDS);
			} catch (error) {
				const status = /** @type {any} */ (error)?.status;
				return failure(
					`defi.protocol: ${url} ${/** @type {Error} */ (error).message}`,
					status ? { status } : undefined,
				);
			}
			let series = detail?.tvl;
			if (chain !== undefined) {
				const wantedChain = norm(chain);
				const found = Object.entries(detail?.chainTvls ?? {}).find(([k]) => norm(k) === wantedChain);
				if (!found) return failure(`defi.protocol: ${entry.slug} reports no TVL on ${chain}`);
				series = /** @type {any} */ (found[1])?.tvl;
			}
			out.history = renderHistory(series, "totalLiquidityUSD", history, points);
			return out;
		},
	};
}
