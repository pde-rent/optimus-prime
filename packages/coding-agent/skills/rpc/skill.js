/**
 * JSON-RPC 2.0 over HTTP: one `fetch` POST per round trip, no SDK.
 *
 * A JSON-RPC request is `{jsonrpc: "2.0", id, method, params}` posted as JSON, and every chain
 * node, Bitcoin-style daemon, and plain JSON-RPC service speaks it. That is small enough that a
 * client library buys nothing but a dependency, so this skill is the transport plus the one
 * thing a caller cannot compose from nothing -- a working endpoint URL. No ABI encoding, no key
 * handling, no signing. The caller composes the method and params.
 *
 * Discovery reads a live registry at call time instead of shipping a chain table, because a
 * bundled table is stale the week it lands. The only hardcoded URLs are the Solana and Tron seed
 * lists, which exist because neither chain has a registry to read.
 *
 * The value helpers are the part that is not obvious. A uint256 does not fit in a JS number --
 * `Number.MAX_SAFE_INTEGER` is 2^53-1, a uint256 goes to 2^256-1 -- and neither does a token
 * balance once it is scaled by 18 decimals. Reading a balance into a `number` and dividing by
 * `1e18` is the single most common correctness bug in chain code, and it is silent: the answer
 * looks plausible and is wrong in the low digits. So `toBigInt`, `fromUnits`, and `toUnits` are
 * exact by construction and contain no floating-point arithmetic at all -- BigInt and string
 * surgery only.
 *
 * Errors follow the websearch convention: an expected, recoverable failure (the node is down,
 * the request timed out, the method returned a JSON-RPC error) is returned as a value so the
 * surrounding cell keeps running, while a bad argument -- a non-string URL, a fractional value
 * where an integer is required -- throws, because that is a bug in the caller, not a condition
 * to handle.
 *
 * Public endpoints degrade constantly -- a 429 here, a dead node there -- so `call` and `batch`
 * also take a CHAIN and roll to the next ranked endpoint themselves. What must not be retried is
 * the larger half of that: an answer from the chain is the same answer everywhere, and spending
 * ten round trips to hear "execution reverted" ten times is worse than hearing it once. See
 * `retryable`.
 */

const DEFAULT_TIMEOUT_SECONDS = 15;

/** Distinct endpoints one call may burn. Three covers a rate-limited head plus one flake. */
const MAX_ATTEMPTS = 3;

/** A turn cannot sit on a `Retry-After: 30`. Past this, another endpoint is the faster answer. */
const MAX_RETRY_AFTER_MS = 2000;

/** Beyond this, `10n ** BigInt(decimals)` is a denial of service rather than a unit. */
const MAX_DECIMALS = 256;

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

/** Request ids only have to be unique within a connection; a counter is enough. */
let nextId = 1;

/** @returns {string} A short, readable type name for an error message. */
function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Validate the pieces every request shares.
 *
 * @throws {TypeError} On a bad method or params - both caller bugs.
 */
function checkCall(method, params) {
	if (typeof method !== "string" || method === "") {
		throw new TypeError(`rpc: method must be a non-empty string, got ${typeName(method)}`);
	}
	if (params !== undefined && params !== null && typeof params !== "object") {
		throw new TypeError(`rpc: params must be an array or object, got ${typeName(params)}`);
	}
}

/** Build one JSON-RPC 2.0 envelope. */
function envelope(id, method, params) {
	return { jsonrpc: "2.0", id, method, params: params ?? [] };
}

/**
 * Normalise one entry of a `batch` list into `{method, params}`.
 *
 * Accepts `{method, params}`, `[method, params]`, or a bare method name, because all three read
 * naturally at a call site and guessing wrong should not cost a round trip.
 *
 * @throws {TypeError} When the entry is none of those shapes.
 */
export function normalizeCall(entry, index) {
	if (typeof entry === "string") return { method: entry, params: [] };
	if (Array.isArray(entry)) return { method: entry[0], params: entry[1] };
	if (entry && typeof entry === "object") return { method: entry.method, params: entry.params };
	throw new TypeError(
		`rpc.batch: call ${index} must be {method, params}, [method, params], or a method name, got ${typeName(entry)}`,
	);
}

/**
 * The error value returned (never thrown) for a failed call.
 *
 * @param {string} message
 * @param {{code?: number, data?: unknown, status?: number}} [extra]
 * @returns {{error: string, code?: number, data?: unknown, status?: number}}
 */
function failure(message, extra) {
	return { error: message, ...extra };
}

/** `Retry-After` is a second count or an HTTP date; both reduce to a wait in ms, 0 when absent. */
function retryAfterMs(value) {
	if (!value) return 0;
	const ms = Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Is this failure the ENDPOINT's fault, i.e. would another node plausibly answer?
 *
 * Transport, timeout, 429 and 5xx are. So are 401 and 403: a public node's key check or paywall
 * is its own policy, not the chain's - `ethereum-rpc.publicnode.com` answers `trace_block` with
 * `403 archive requests require a paid plan`, and its neighbours serve it. Any other status, and
 * any well-formed JSON-RPC error, is the chain answering the question that was asked and the
 * next node answers it identically - except `-32601`, which `call` raises as a throw because a
 * node's method list is its own choice too.
 */
function retryable(e) {
	if (typeof e?.status === "number") return e.status >= 500 || [401, 403, 429].includes(e.status);
	return true;
}

/** Turn a thrown fetch/JSON error into the returned error value, naming the likely cause. */
function transportFailure(url, error) {
	// AbortSignal.timeout rejects with a TimeoutError; the bare message ("The operation was
	// aborted") does not say which knob to turn, so name the option instead.
	if (error?.name === "TimeoutError") return failure(`rpc: request to ${url} timed out (raise { timeout })`);
	return failure(`rpc: request to ${url} failed: ${error?.message || error}`);
}

/**
 * POST a JSON-RPC body and parse the response.
 *
 * @returns {Promise<unknown>} The parsed response body.
 * @throws {Error} On HTTP, network, timeout, or JSON-parse failure; callers convert to a value.
 */
async function post(url, body, options = {}) {
	const seconds = Number(options.timeout ?? DEFAULT_TIMEOUT_SECONDS);
	const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;

	const resp = await fetch(url, {
		method: "POST",
		headers: { ...JSON_HEADERS, ...(options.headers ?? {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!resp.ok) {
		const detail = (await resp.text().catch(() => "")).trim().slice(0, 200);
		const error = new Error(`rpc: ${url} returned HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
		error.status = resp.status;
		if (resp.status === 429) error.retryAfter = retryAfterMs(resp.headers?.get("retry-after"));
		throw error;
	}
	try {
		return await resp.json();
	} catch {
		throw new Error(`rpc: ${url} returned a non-JSON body`);
	}
}

/**
 * Reduce one response envelope to either its `result` or an error value.
 *
 * `result` may legitimately be `null` (an unknown transaction hash, an empty slot), so presence
 * is tested rather than truthiness.
 */
function unwrap(envelopeOut, method) {
	if (envelopeOut && typeof envelopeOut === "object" && envelopeOut.error) {
		const e = envelopeOut.error;
		const message = typeof e === "string" ? e : e?.message || JSON.stringify(e);
		return failure(`rpc: ${method} failed: ${message}`, {
			...(typeof e?.code === "number" ? { code: e.code } : {}),
			...(e?.data !== undefined ? { data: e.data } : {}),
		});
	}
	if (envelopeOut && typeof envelopeOut === "object" && "result" in envelopeOut) return envelopeOut.result;
	return failure(`rpc: ${method} returned a malformed response (no result and no error)`);
}

/**
 * Reject the numbers that cannot describe a unit scale.
 *
 * @returns {number} The validated decimal count.
 * @throws {TypeError} When it is not an integer in `0..256`.
 */
function checkDecimals(decimals, where) {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
		throw new TypeError(`${where}: decimals must be an integer in 0..${MAX_DECIMALS}, got ${String(decimals)}`);
	}
	return decimals;
}

/**
 * Convert a JSON-RPC numeric value to a BigInt, exactly.
 *
 * Accepts a hex quantity (`"0x1f"`, the form every EVM node returns), a decimal string, a
 * BigInt, or a safe integer Number. A Number outside the safe range is rejected rather than
 * converted: by the time it arrives it has already lost the digits, and returning a
 * confidently wrong BigInt is worse than failing.
 *
 * @param {string|number|bigint} value
 * @returns {bigint}
 * @throws {TypeError} On a non-integer, an unsafe Number, or an unparseable string.
 */
export function toBigInt(value) {
	if (typeof value === "bigint") return value;

	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new TypeError(`rpc.toBigInt: ${value} is not an integer; use toUnits(value, decimals) to scale it`);
		}
		if (!Number.isSafeInteger(value)) {
			throw new TypeError(
				`rpc.toBigInt: ${value} is past Number.MAX_SAFE_INTEGER and has already lost precision; pass a string or bigint`,
			);
		}
		return BigInt(value);
	}

	if (typeof value === "string") {
		const text = value.trim();
		if (text === "") throw new TypeError("rpc.toBigInt: empty string");
		// BigInt() parses "0x1f" but not "-0x1f", so the sign is peeled off first.
		const negative = text.startsWith("-");
		const digits = negative || text.startsWith("+") ? text.slice(1) : text;
		try {
			const parsed = BigInt(digits);
			return negative ? -parsed : parsed;
		} catch {
			throw new TypeError(`rpc.toBigInt: "${value}" is not a hex or decimal integer`);
		}
	}

	throw new TypeError(`rpc.toBigInt: expected string, number, or bigint, got ${typeName(value)}`);
}

/**
 * Scale a raw integer amount down by `decimals`, exactly.
 *
 * Pure string surgery on the digits - no division, no `Number`, so a uint256 balance survives
 * intact. The result is the shortest exact decimal: trailing fractional zeros are dropped, and
 * an integral result carries no decimal point.
 *
 * @param {string|number|bigint} value - Raw amount, e.g. `"0xde0b6b3a7640000"`.
 * @param {number} decimals - Unit scale, e.g. `18`.
 * @returns {string} Exact decimal string, e.g. `"1"`.
 * @throws {TypeError} On a bad value or a `decimals` outside `0..256`.
 */
export function fromUnits(value, decimals) {
	const d = checkDecimals(decimals, "rpc.fromUnits");
	const raw = toBigInt(value);
	const negative = raw < 0n;
	// padStart guarantees at least one whole digit, so "0.5" never comes out as ".5".
	const digits = (negative ? -raw : raw).toString().padStart(d + 1, "0");
	const whole = digits.slice(0, digits.length - d);
	const fraction = d === 0 ? "" : digits.slice(digits.length - d).replace(/0+$/, "");
	return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Decimal-string grammar, including the exponent form `String(1e21)` produces. */
const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Scale a decimal amount up by `decimals`, exactly.
 *
 * Prefer a string: a Number argument is converted through its own shortest decimal form, which
 * is exact for what the double actually holds but not for what was typed (`0.1 + 0.2` really is
 * `0.30000000000000004`).
 *
 * More precision than `decimals` can hold is a RangeError rather than a silent truncation -
 * quietly dropping digits off an amount is how funds go missing. Excess *zeros* are fine, since
 * dropping them changes nothing.
 *
 * @param {string|number|bigint} value - Decimal amount, e.g. `"1.5"` or `"1e-6"`.
 * @param {number} decimals - Unit scale, e.g. `18`.
 * @returns {bigint} Raw integer amount.
 * @throws {TypeError} On an unparseable value or a `decimals` outside `0..256`.
 * @throws {RangeError} When the value carries more significant decimal places than `decimals`.
 */
export function toUnits(value, decimals) {
	const d = checkDecimals(decimals, "rpc.toUnits");
	if (typeof value === "bigint") return value * 10n ** BigInt(d);
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new TypeError(`rpc.toUnits: ${value} is not a finite number`);
	}
	if (typeof value !== "number" && typeof value !== "string") {
		throw new TypeError(`rpc.toUnits: expected a decimal string, number, or bigint, got ${typeName(value)}`);
	}

	const text = String(value).trim();
	const match = DECIMAL.exec(text);
	// A hex string has no decimal point to scale, so it is a caller mistake, not an input format.
	if (!match || (match[2] === "" && !match[3])) {
		throw new TypeError(`rpc.toUnits: "${text}" is not a decimal number`);
	}

	const [, sign, whole = "", fraction = "", exponent = "0"] = match;
	let digits = whole + fraction;
	// Applying the exponent moves the point inside `digits` instead of multiplying by a float.
	let fractionLength = digits.length - (whole.length + Number(exponent));
	if (fractionLength < 0) {
		digits += "0".repeat(-fractionLength);
		fractionLength = 0;
	}

	if (fractionLength > d) {
		const drop = fractionLength - d;
		const tail = digits.slice(digits.length - drop);
		if (/[^0]/.test(tail)) {
			throw new RangeError(
				`rpc.toUnits: "${text}" has more than ${d} decimal places; round it before converting to avoid losing value`,
			);
		}
		digits = digits.slice(0, digits.length - drop);
		fractionLength = d;
	}

	const scaled = BigInt(digits || "0") * 10n ** BigInt(d - fractionLength);
	return sign === "-" ? -scaled : scaled;
}

/* -------------------------------------------------------------------------------------------
 * Endpoint discovery
 * ----------------------------------------------------------------------------------------- */

/**
 * DefiLlama's enriched mirror of ethereum-lists/chains: same chain ids, more RPCs, plus the
 * `tracking` flag and the `chainSlug` this file resolves names with. The canonical list at
 * https://chainid.network/chains.json is a fine substitute, but its `rpc` entries are plain
 * strings; both shapes are accepted below so either document parses.
 */
const CHAINLIST_URL = "https://chainlist.org/rpcs.json";

/** The registry is ~2MB over 2800 chains, so it gets a longer budget than a node call. */
const REGISTRY_TIMEOUT_SECONDS = 30;

/** A node that cannot answer `eth_chainId` in this long is not the one to pick. */
const PROBE_TIMEOUT_SECONDS = 5;

/** Chain 1 lists 88 endpoints. Probing all of them costs 88 requests to answer one question. */
const DEFAULT_PROBE_LIMIT = 12;

/** Solana has no endpoint registry; this is a curated keyless seed list. */
const SOLANA_SEEDS = [
	"https://api.mainnet-beta.solana.com",
	"https://solana-rpc.publicnode.com",
	"https://solana.drpc.org",
	"https://solana.api.onfinality.io/public",
	"https://solana.lavenderfive.com",
	"https://solana-mainnet.gateway.tatum.io",
	"https://public.rpc.solanavibestation.com",
	"https://solana.leorpc.com/?api_key=FREE",
];

/** Tron full-node REST bases (not JSON-RPC). TronGrid answers keyless at low volume. */
const TRON_SEEDS = ["https://api.trongrid.io", "https://tron.drpc.org", "https://api.tronstack.io"];

/**
 * Multi-chain public gateways, by registrable-domain label. Membership only breaks ties in the
 * ordering, so a name going stale costs an endpoint its tier and nothing else; `opts.providers`
 * replaces the list outright.
 */
const PUBLIC_PROVIDERS = new Set([
	"1rpc",
	"alchemy",
	"ankr",
	"blastapi",
	"blockpi",
	"chainstack",
	"drpc",
	"gateway",
	"getblock",
	"infura",
	"lavenderfive",
	"llamarpc",
	"meowrpc",
	"nodereal",
	"nodies",
	"omniatech",
	"onfinality",
	"publicnode",
	"quiknode",
	"stackup",
	"tatum",
	"therpc",
	"thirdweb",
	"unifra",
	"zan",
]);

/** Healthy first, then provenance, then latency. See `endpointTier`. */
const TIER_ORDER = { official: 2, provider: 1, other: 0 };

/** Words that appear in half the chain names in the registry and identify nothing. */
const TOKEN_STOPWORDS = new Set([
	"beta",
	"blockchain",
	"chain",
	"main",
	"mainnet",
	"network",
	"node",
	"protocol",
	"public",
	"smart",
	"testnet",
]);

/** Below this a token matches by accident: "eth" is inside "cloudflare-eth" and "ethical". */
const MIN_TOKEN_CHARS = 4;

/**
 * The registrable domain's own label: `solana` in `api.mainnet-beta.solana.com`, `publicnode` in
 * `arbitrum-one.publicnode.com`.
 *
 * Subdomains are deliberately excluded, because that is the whole discriminator: an operator can
 * put any chain name in a subdomain of a host it owns, and only the registered domain says who
 * owns it. A two-label public suffix (`.co.uk`) lands on the suffix instead and scores as
 * unknown - the cost is a missed promotion, never a false one.
 *
 * @param {string} url
 * @returns {string} The label, or "" when the URL will not parse.
 */
export function domainLabel(url) {
	try {
		const labels = new URL(url).hostname.toLowerCase().split(".").filter(Boolean);
		return labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? "");
	} catch {
		return "";
	}
}

/**
 * Words from a chain's registry identity that a domain could plausibly carry.
 *
 * @param {...unknown} values - e.g. the chain's `name`, `chainSlug`, `shortName`.
 * @returns {string[]} Lowercase tokens, deduplicated.
 */
export function chainTokens(...values) {
	const out = new Set();
	for (const value of values) {
		for (const word of String(value ?? "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)) {
			if (word.length >= MIN_TOKEN_CHARS && !TOKEN_STOPWORDS.has(word)) out.add(word);
		}
	}
	return [...out];
}

/**
 * Classify an endpoint's provenance. A heuristic, and honest about it: this is string matching
 * on a hostname, not an attestation. It decides ordering only - health always wins - and
 * `opts.rank` turns it off.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string[]} [opts.tokens] - Chain identity words from `chainTokens`.
 * @param {Set<string>|string[]} [opts.providers] - Known multi-chain gateways, by domain label.
 * @param {string[]} [opts.officialHosts] - Hosts the caller declares official, always tier 1.
 * @returns {"official"|"provider"|"other"}
 */
export function endpointTier(url, { tokens = [], providers = PUBLIC_PROVIDERS, officialHosts = [] } = {}) {
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return "other";
	}
	for (const raw of officialHosts) {
		const declared = String(raw).toLowerCase();
		if (host === declared || host.endsWith(`.${declared}`)) return "official";
	}
	const label = domainLabel(url);
	if (!label) return "other";
	if (tokens.some((token) => label.includes(token))) return "official";
	const known = providers instanceof Set ? providers : new Set(providers);
	return known.has(label) ? "provider" : "other";
}

/**
 * Session memo for the registry document, as a promise so concurrent callers share one fetch.
 * A rejection clears it, so a failed fetch does not poison the rest of the session.
 */
let registryPromise = null;

/**
 * Session memo of the healthy endpoints for a chain, best first, keyed by the normalised chain
 * request. A ladder rather than a single winner: failover needs the runners-up, and `pick` is
 * just its head.
 */
const pickCache = new Map();

/** The endpoint that served the last completed `call` or `batch`. See `lastEndpoint`. */
let lastServed = null;

/** Drop both session memos. Exported for tests and for a long-lived REPL. */
export function clearRpcCache() {
	registryPromise = null;
	pickCache.clear();
	lastServed = null;
}

/**
 * Drop a dead endpoint from the ladder, so the memo cannot hand it back. Emptying the ladder
 * deletes the key, which makes the next lookup re-discover and re-rank from scratch.
 */
function evict(key, url) {
	const rest = (pickCache.get(key) ?? []).filter((u) => u !== url);
	if (rest.length > 0) pickCache.set(key, rest);
	else pickCache.delete(key);
}

/**
 * The chain registry, fetched at most once per session.
 *
 * @returns {Promise<object[]>}
 * @throws {Error} On HTTP, network, timeout, or a non-array body.
 */
function chainRegistry({ refresh = false, registryTimeout = REGISTRY_TIMEOUT_SECONDS } = {}) {
	if (refresh) registryPromise = null;
	if (!registryPromise) {
		registryPromise = (async () => {
			const resp = await fetch(CHAINLIST_URL, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(registryTimeout * 1000),
			});
			if (!resp.ok) throw new Error(`rpc: chain registry returned HTTP ${resp.status}`);
			const chains = await resp.json();
			if (!Array.isArray(chains)) throw new Error("rpc: chain registry did not return a list of chains");
			return chains;
		})().catch((e) => {
			registryPromise = null;
			throw e;
		});
	}
	return registryPromise;
}

/**
 * Normalise the `chain` argument into a request.
 *
 * @param {number|string} chain
 * @returns {{key: string, kind: "evm"|"name"|"solana"|"tron", id?: number, name?: string}}
 * @throws {TypeError} On anything that cannot name a chain - a caller bug.
 */
export function chainRequest(chain) {
	if (typeof chain === "number" || typeof chain === "bigint") {
		const id = Number(chain);
		if (!Number.isSafeInteger(id) || id <= 0) {
			throw new TypeError(`rpc: chain id must be a positive integer, got ${String(chain)}`);
		}
		return { key: `evm:${id}`, kind: "evm", id };
	}
	if (typeof chain !== "string" || chain.trim() === "") {
		throw new TypeError(
			`rpc: chain must be an EVM chain id, a chain name, "solana", or "tron", got ${typeName(chain)}`,
		);
	}
	const text = chain.trim().toLowerCase();
	if (/^\d+$/.test(text)) return { key: `evm:${Number(text)}`, kind: "evm", id: Number(text) };
	if (text === "solana" || text === "sol") return { key: "solana", kind: "solana" };
	if (text === "tron" || text === "trx") return { key: "tron", kind: "tron" };
	return { key: `name:${text}`, kind: "name", name: text };
}

/** Comparable form of a chain name: case, spacing and punctuation carry no meaning here. */
function normalizeName(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

/**
 * Find one chain in the registry. Names resolve against the registry's own `chainSlug`,
 * `shortName` and `name` fields rather than a table in this file, so a new chain is findable the
 * day it is listed.
 *
 * @param {object[]} chains - Parsed registry.
 * @param {{kind: string, id?: number, name?: string}} request
 * @returns {{chain: object}|{error: string}} An error value when absent or ambiguous.
 */
export function findChain(chains, request) {
	if (request.kind === "evm") {
		const chain = chains.find((c) => Number(c?.chainId) === request.id);
		return chain ? { chain } : failure(`rpc: chain id ${request.id} is not in the registry`);
	}

	const wanted = request.name;
	const target = normalizeName(wanted);
	const exact = chains.filter((c) =>
		[c?.chainSlug, c?.shortName, c?.name].some((v) => String(v ?? "").toLowerCase() === wanted),
	);
	// "bnb-smart-chain" should find "BNB Smart Chain Mainnet"; the suffix is noise on every entry.
	const loose = chains.filter((c) =>
		[c?.chainSlug, c?.shortName, c?.name, String(c?.name ?? "").replace(/mainnet$/i, "")].some(
			(v) => normalizeName(v) === target,
		),
	);
	const matched = exact.length > 0 ? exact : loose;
	// The registry lists testnets under the same short names ("eth" is both chain 1 and a testnet).
	const live = matched.filter((c) => c?.isTestnet !== true);
	const pool = live.length > 0 ? live : matched;

	if (pool.length === 0) {
		return failure(`rpc: no chain named "${wanted}" in the registry; pass its numeric chain id instead`);
	}
	if (pool.length > 1) {
		const names = pool
			.slice(0, 5)
			.map((c) => `${c.chainId} (${c.name})`)
			.join(", ");
		return failure(`rpc: "${wanted}" matches ${pool.length} chains - pass a chain id: ${names}`);
	}
	return { chain: pool[0] };
}

/**
 * Endpoint URLs this skill can actually use: http(s) only, no API-key template.
 *
 * A `${ALCHEMY_API_KEY}` placeholder is a URL the caller has to finish, and `wss://` is a
 * different transport than the one `post` speaks; both are dropped rather than probed and
 * reported dead. The registry also carries a handful of malformed entries (a `website:` scheme,
 * a host with no scheme at all, one prefixed with a zero-width space) which the same test drops.
 *
 * @param {object} chain - A registry entry.
 * @returns {string[]} Unique candidate URLs, in registry order.
 */
export function chainRpcUrls(chain) {
	const raw = Array.isArray(chain?.rpc) ? chain.rpc : [];
	const urls = raw
		.map((entry) => (typeof entry === "string" ? entry : entry?.url))
		.filter((url) => typeof url === "string" && url.startsWith("http") && !url.includes("${"));
	return [...new Set(urls)];
}

/** A single response, whether the server wrapped it in a batch array or not. */
function single(body) {
	return Array.isArray(body) ? body[0] : body;
}

/** One line of `detail` for a failed probe: the cause, not a stack. */
function briefError(e) {
	if (e?.name === "TimeoutError") return "timed out";
	if (e?.status) return `HTTP ${e.status}`;
	return String(e?.message || e)
		.replace(/^rpc: /, "")
		.slice(0, 80);
}

/**
 * Run one probe, timing it. `work` returns the `detail` string on success and throws otherwise,
 * so "unreachable" and "answered wrongly" take the same path.
 *
 * @returns {Promise<{url: string, ok: boolean, ms: number, detail: string}>}
 */
async function timed(url, work) {
	const started = performance.now();
	try {
		const detail = await work();
		return { url, ok: true, ms: Math.round(performance.now() - started), detail };
	} catch (e) {
		return { url, ok: false, ms: Math.round(performance.now() - started), detail: briefError(e) };
	}
}

/** Probe an EVM node, verifying it is on the chain that was asked for. */
function probeEvm(url, chainId, opts) {
	return timed(url, async () => {
		const value = unwrap(single(await post(url, envelope(nextId++, "eth_chainId", []), opts)), "eth_chainId");
		if (value && typeof value === "object" && "error" in value) throw new Error(value.error);
		// A public URL can front a different network than its name suggests, and an unverified
		// endpoint is worse than none: the read succeeds and the answer is from the wrong chain.
		const got = toBigInt(value);
		if (got !== BigInt(chainId)) throw new Error(`wrong chain (${got}, want ${chainId})`);
		return `chainId ${got}`;
	});
}

/** Probe a Solana node. `getSlot` is the cheapest call that proves the node is synced enough. */
function probeSolana(url, opts) {
	return timed(url, async () => {
		const value = unwrap(single(await post(url, envelope(nextId++, "getSlot", []), opts)), "getSlot");
		if (typeof value !== "number") throw new Error(value?.error || "no slot in reply");
		return `slot ${value}`;
	});
}

/** Probe a Tron full node over its REST wallet API - not JSON-RPC. See `tron` below. */
function probeTron(base, opts) {
	return timed(base, async () => {
		const block = await post(`${base.replace(/\/+$/, "")}/wallet/getnowblock`, {}, opts);
		const height = block?.block_header?.raw_data?.number;
		if (typeof height !== "number") throw new Error("no block in reply");
		return `block ${height}`;
	});
}

/**
 * Discover and health-check endpoints. Implementation of `rpc.endpoints`; see its JSDoc.
 *
 * @returns {Promise<Array<object>|{error: string}>}
 */
async function discover(chain, opts = {}) {
	const request = chainRequest(chain);
	const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_PROBE_LIMIT;
	const ranked = opts.rank !== false && opts.rank !== "latency";
	const probeOpts = { timeout: opts.timeout ?? PROBE_TIMEOUT_SECONDS, headers: opts.headers };

	let urls;
	let tokens;
	let probe;
	if (request.kind === "solana") {
		urls = SOLANA_SEEDS;
		tokens = ["solana"];
		probe = (url) => probeSolana(url, probeOpts);
	} else if (request.kind === "tron") {
		urls = TRON_SEEDS;
		tokens = ["tron"];
		probe = (url) => probeTron(url, probeOpts);
	} else {
		let chains;
		try {
			// `refresh` re-probes; re-downloading 2MB of registry needs its own opt-in, because the
			// list of chains moves far more slowly than the health of any node on it.
			chains = await chainRegistry({ refresh: opts.registryRefresh, registryTimeout: opts.registryTimeout });
		} catch (e) {
			return e?.name === "TimeoutError"
				? failure("rpc.endpoints: the chain registry timed out (raise { registryTimeout })")
				: failure(`rpc.endpoints: could not read the chain registry: ${e?.message || e}`);
		}
		const found = findChain(chains, request);
		if (found.error) return found;
		urls = chainRpcUrls(found.chain);
		tokens = chainTokens(found.chain.name, found.chain.chainSlug, found.chain.shortName);
		const chainId = Number(found.chain.chainId);
		probe = (url) => probeEvm(url, chainId, probeOpts);
	}

	if (urls.length === 0) return failure(`rpc.endpoints: no keyless http endpoint is listed for ${request.key}`);

	const scored = urls.map((url) => ({
		url,
		tier: endpointTier(url, { tokens, providers: opts.providers, officialHosts: opts.officialHosts ?? [] }),
	}));
	// Rank before slicing too: with 88 candidates and a budget of 12, probing the registry's
	// arbitrary order would spend the budget before reaching the chain's own node.
	if (ranked) scored.sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier]);

	const probes = await Promise.all(
		scored.slice(0, limit).map(async ({ url, tier }) => ({ ...(await probe(url)), tier })),
	);
	probes.sort((a, b) => {
		if (a.ok !== b.ok) return a.ok ? -1 : 1;
		if (ranked && a.tier !== b.tier) return TIER_ORDER[b.tier] - TIER_ORDER[a.tier];
		return a.ms - b.ms;
	});
	return probes;
}

/* -------------------------------------------------------------------------------------------
 * Failover
 * ----------------------------------------------------------------------------------------- */

/** A URL, as opposed to a chain: only a URL carries a scheme, so the two cannot collide. */
function isUrl(value) {
	return typeof value === "string" && value.trim().toLowerCase().startsWith("http");
}

/**
 * Turn the first argument of `call`/`batch` into the endpoints to try, best first.
 *
 * An explicit URL is used exactly as given - a caller who already has one must not be dragged
 * through discovery. A chain resolves through the same ranked, health-probed ladder `pick`
 * returns the head of, memoised per session, so only the first call for a chain costs probes.
 *
 * @param {boolean} [jsonrpc] - The caller speaks JSON-RPC, which for Tron is a different URL
 *   than the REST base the ladder holds; the two forms are memoised under separate keys.
 * @returns {Promise<{urls: string[], key: string|null}|{error: string}>}
 * @throws {TypeError} When the argument is neither a URL nor anything that can name a chain.
 */
async function resolveTarget(target, opts = {}, jsonrpc = false) {
	if (isUrl(target)) return { urls: [target.trim()], key: null };
	const request = chainRequest(target);
	const tronRpc = jsonrpc && request.kind === "tron";
	const key = tronRpc ? `${request.key}:jsonrpc` : request.key;
	if (!opts.refresh) {
		const cached = pickCache.get(key);
		if (cached?.length) return { urls: cached, key };
	}
	const probes = await discover(target, opts);
	if (!Array.isArray(probes)) return probes;
	const healthy = probes.filter((p) => p.ok).map((p) => (tronRpc ? `${p.url}/jsonrpc` : p.url));
	if (healthy.length === 0) return failure(`rpc: no healthy endpoint for ${request.key} (probed ${probes.length})`);
	pickCache.set(key, healthy);
	return { urls: healthy, key };
}

/**
 * Run `attempt` against one endpoint after another until one answers.
 *
 * Only an endpoint's own failure advances the ladder (see `retryable`) and evicts it from the
 * memo; anything the chain said comes straight back. With a single candidate - an explicit URL -
 * that candidate's own error surfaces unchanged, so the URL form behaves as it always did.
 *
 * @param {{urls: string[], key: string|null}} resolved
 * @param {(url: string) => Promise<unknown>} attempt - Throws to report a failed endpoint.
 * @returns {Promise<unknown>} The answer, or an error value naming every endpoint tried.
 */
async function overEndpoints({ urls, key }, opts, attempt) {
	const failover = opts.failover !== false;
	const queue = urls.slice(0, failover ? MAX_ATTEMPTS : 1);
	const tried = [];
	let slept = false;
	for (;;) {
		const url = queue[0];
		try {
			const value = await attempt(url);
			lastServed = url;
			return value;
		} catch (e) {
			const value = e?.value ?? (e?.status ? failure(e.message, { status: e.status }) : transportFailure(url, e));
			if (!failover || !retryable(e)) return value;
			// The endpoint said when it will be free again; obeying beats burning a candidate, but
			// only while the wait is shorter than a round trip somewhere else. One wait per call.
			if (!slept && e?.retryAfter > 0 && e.retryAfter <= MAX_RETRY_AFTER_MS) {
				slept = true;
				await new Promise((resolve) => setTimeout(resolve, e.retryAfter));
				continue;
			}
			if (key) evict(key, url);
			tried.push(`${url} (${briefError(e)})`);
			queue.shift();
			if (queue.length === 0) {
				return tried.length > 1
					? failure(`rpc: all ${tried.length} endpoints failed - ${tried.join("; ")}`)
					: value;
			}
		}
	}
}

export default function createSkill() {
	return {
		/**
		 * Call one JSON-RPC method and return its `result`.
		 *
		 * Chain-agnostic: `method` is whatever the node speaks -
		 * `rpc.call(1, "eth_call", [{to, data}, "latest"])` on an EVM node,
		 * `rpc.call("solana", "getBalance", [address])`, `rpc.call(url, "getblockcount")` on
		 * Bitcoin. Nothing here encodes calldata or knows a chain's methods.
		 *
		 * `target` is either an endpoint URL, used as given, or a chain (EVM id or name,
		 * `"solana"`, `"tron"`), in which case the best endpoint is discovered, memoised, and
		 * REPLACED on the fly when it rate-limits or dies - so a caller never has to notice.
		 *
		 * Never throws on a network, HTTP, or RPC-level failure: those come back as
		 * `{error, code?, data?, status?}`, so check `.error` before using the value. Bad
		 * arguments (an empty method, params that are not an object) throw, as caller bugs.
		 *
		 * @param {string|number} target - Endpoint URL, or a chain to resolve one from.
		 * @param {string} method - JSON-RPC method name.
		 * @param {unknown[]|object} [params=[]] - Positional or named params.
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=15] - Timeout in seconds.
		 * @param {Record<string,string>} [opts.headers] - Extra headers, e.g. an API key.
		 * @param {boolean} [opts.failover=true] - False stops after the first endpoint.
		 * @returns {Promise<unknown>} The `result` value, or an error object.
		 */
		async call(target, method, params, opts = {}) {
			checkCall(method, params);
			const resolved = await resolveTarget(target, opts, true);
			if (resolved.error) return resolved;
			return overEndpoints(resolved, opts, async (url) => {
				// A server may answer a single request with a one-element batch; accept both.
				const out = unwrap(single(await post(url, envelope(nextId++, method, params), opts)), method);
				// The one JSON-RPC error worth another endpoint: which methods a node exposes
				// (`trace_*`, `debug_*`) is that node's choice, not the chain's answer.
				if (out?.code === -32601) throw Object.assign(new Error(out.error), { value: out });
				return out;
			});
		},

		/**
		 * Call many methods in ONE round trip, using a JSON-RPC batch array.
		 *
		 * The cost of N calls is one request, which is the whole point: fetching 50 balances
		 * sequentially is 50 round trips of latency, and a batch is one.
		 *
		 * Always resolves to an array with one entry per call, in the order the calls were
		 * given - responses are re-matched by request id, since a server is free to reorder
		 * them. One call failing does not affect the others: that entry holds its own
		 * `{error, code?}` object and every sibling still holds its result. When the request
		 * itself fails (network, timeout, HTTP status), every entry holds that one error, so
		 * the return shape never changes.
		 *
		 * @param {string|number} target - Endpoint URL, or a chain to resolve one from, as `call`.
		 * @param {Array<{method: string, params?: unknown}|[string, unknown]|string>} calls
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=15] - Timeout in seconds.
		 * @param {Record<string,string>} [opts.headers] - Extra headers.
		 * @param {boolean} [opts.failover=true] - False stops after the first endpoint.
		 * @returns {Promise<unknown[]>} One entry per call: the `result`, or an error object.
		 */
		async batch(target, calls, opts = {}) {
			if (!Array.isArray(calls)) throw new TypeError(`rpc.batch: calls must be an array, got ${typeName(calls)}`);
			if (calls.length === 0) return [];

			const normalized = calls.map((entry, index) => normalizeCall(entry, index));
			for (const { method, params } of normalized) checkCall(method, params);

			const resolved = await resolveTarget(target, opts, true);
			const out = resolved.error
				? resolved
				: await overEndpoints(resolved, opts, async (url) => {
						// Fresh ids per attempt: a retry is a new request, not a resend.
						const ids = normalized.map(() => nextId++);
						const body = normalized.map(({ method, params }, i) => envelope(ids[i], method, params));
						const response = await post(url, body, opts);

						if (!Array.isArray(response)) {
							// A batch answered with a bare object is either a server-level error or a
							// server that does not implement batching; either way, no call has a result.
							const asValue = unwrap(response, "batch");
							const wrapped =
								asValue && typeof asValue === "object" && "error" in asValue
									? asValue
									: failure(`rpc: ${url} answered a batch with a single object, not an array`);
							return normalized.map(() => wrapped);
						}

						const byId = new Map(response.filter((r) => r && typeof r === "object").map((r) => [r.id, r]));
						return normalized.map(({ method }, i) => {
							const found = byId.get(ids[i]);
							return found === undefined
								? failure(`rpc: ${method} had no matching response in the batch`)
								: unwrap(found, method);
						});
					});
			// One failure for the whole request fans out to one entry per call: the shape is fixed.
			return Array.isArray(out) ? out : normalized.map(() => out);
		},

		/**
		 * Discover public endpoints for a chain and health-check them concurrently.
		 *
		 * `chain` is an EVM chain id (`1`, `42161`), an EVM chain name resolved against the
		 * registry's own `chainSlug`/`shortName`/`name` fields (`"arbitrum"`, `"base"`), or
		 * `"solana"` / `"tron"`. EVM candidates come from a live registry, filtered to http(s)
		 * URLs with no `${API_KEY}` placeholder; Solana and Tron have no registry, so they use a
		 * curated keyless seed list.
		 *
		 * Every EVM probe verifies `eth_chainId` matches the chain that was asked for, because a
		 * URL answering for the wrong network is the failure this call exists to prevent. Solana
		 * probes `getSlot`; Tron probes `POST /wallet/getnowblock`, its REST API.
		 *
		 * Ordering is healthy first, then `tier`, then latency - so a fast working fallback
		 * always outranks a dead official endpoint. `{ rank: false }` drops the tier step and
		 * sorts healthy-then-fastest only.
		 *
		 * @param {number|string} chain - EVM chain id or name, `"solana"`, or `"tron"`.
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=5] - Per-probe timeout in seconds.
		 * @param {number} [opts.limit=12] - How many candidates to probe.
		 * @param {false|"latency"} [opts.rank] - Turn the provenance heuristic off.
		 * @param {string[]} [opts.officialHosts] - Hosts to treat as official.
		 * @param {string[]} [opts.providers] - Replace the known-gateway list.
		 * @param {boolean} [opts.registryRefresh=false] - Re-download the chain registry.
		 * @param {number} [opts.registryTimeout=30] - Registry timeout in seconds.
		 * @returns {Promise<Array<{url: string, ok: boolean, ms: number, detail: string, tier: string}>|{error: string}>}
		 *   Ranked probes, or an error value when the chain or the registry could not be read.
		 */
		endpoints(chain, opts = {}) {
			return discover(chain, opts);
		},

		/**
		 * The single best endpoint URL for a chain, memoised for the session.
		 *
		 * The first call discovers and probes; every later call for the same chain returns the
		 * cached URL with no round trip at all. A `call` or `batch` that fails over drops the
		 * endpoint it gave up on from that memo, so this never hands back a URL already known to
		 * be dead. `{ refresh: true }` re-probes from scratch.
		 *
		 * @param {number|string} chain - As `endpoints`.
		 * @param {object} [opts] - As `endpoints`, plus `{ refresh }` to bypass the memo.
		 * @returns {Promise<string|{error: string}>} A URL, or an error value when nothing
		 *   healthy was found.
		 */
		async pick(chain, opts = {}) {
			const resolved = await resolveTarget(chain, opts);
			return resolved.error ? resolved : resolved.urls[0];
		},

		/**
		 * The endpoint that answered the last SUCCESSFUL `call`, `batch` or `tron`, or null - so a
		 * caller that passed a chain can see which URL served it. Concurrent calls overwrite each
		 * other, so read it right after the one you care about.
		 *
		 * @returns {string|null}
		 */
		get lastEndpoint() {
			return lastServed;
		},

		/**
		 * Call Tron's REST wallet API, which is what a Tron full node actually speaks.
		 *
		 * Tron's main API is not JSON-RPC: it is `POST /wallet/<method>` with a plain JSON body,
		 * so `rpc.call` cannot reach it. Use this for anything under `/wallet`. Tron nodes ALSO
		 * expose an EVM-compatible JSON-RPC at `<base>/jsonrpc`, and that one is an ordinary
		 * `rpc.call` target - reach for it when the question is an EVM question (a contract read,
		 * a block number) and for this when the question is a Tron-native one.
		 *
		 * @param {string} baseUrl - Full-node base, e.g. `https://api.trongrid.io`, or `"tron"` to
		 *   resolve one and fail over between them exactly as `call` does.
		 * @param {string} path - Wallet path, e.g. `"wallet/getnowblock"`.
		 * @param {object} [body={}] - JSON body; Tron wants one even when it is empty.
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=15] - Timeout in seconds.
		 * @param {Record<string,string>} [opts.headers] - Extra headers, e.g. `TRON-PRO-API-KEY`.
		 * @param {boolean} [opts.failover=true] - False stops after the first endpoint.
		 * @returns {Promise<unknown>} The parsed JSON body, or `{error, status?}`.
		 */
		async tron(baseUrl, path, body = {}, opts = {}) {
			if (typeof path !== "string" || path.trim() === "") {
				throw new TypeError(`rpc.tron: path must be a non-empty string, got ${typeName(path)}`);
			}
			const resolved = await resolveTarget(baseUrl, opts);
			if (resolved.error) return resolved;
			const tail = path.replace(/^\/+/, "");
			return overEndpoints(resolved, opts, (base) => post(`${base.replace(/\/+$/, "")}/${tail}`, body ?? {}, opts));
		},

		toBigInt,
		fromUnits,
		toUnits,
	};
}
