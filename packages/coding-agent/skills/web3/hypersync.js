/**
 * Envio HyperSync: deep historical EVM data over a per-chain REST query API, for everything an
 * RPC `eth_getLogs` cannot reach without chunking.
 *
 * Public nodes cap log ranges (~10-100k blocks) and prune old history; HyperSync indexes whole
 * chains and answers a range query of any depth over `POST https://<slug>.hypersync.xyz/query`.
 * So the routing rule is: deep history - event archaeology, transfer scans, indexer rebuilds,
 * governance/timelock audits, any `eth_getLogs` that came back "requested range too large" -
 * goes here, while latest-state reads stay on `web3.rpc.call`, which needs no key and wins on
 * latency. One round trip here is never cheaper than one `eth_call`.
 *
 * Auth is a Bearer token from `HYPERSYNC_API_KEY`, read from the environment at call time and
 * never printed, logged, or embedded in an error message.
 *
 * Chain discovery is PROBED, not listed. `meta.hypersync.xyz` carries the authoritative chain
 * list but is unreachable from many networks, so `chains()` probes the curated candidate list
 * below against each chain's own `/height` and returns the slugs that answer. An undocumented
 * slug still works directly - the base URL is just `https://<slug>.hypersync.xyz` - so pass a
 * name you trust even when `chains()` has never seen it.
 *
 * Response rows are NESTED: `{data: [{logs: [...]}], next_block, archive_height}`. Pagination
 * loops on `next_block` until the requested `maxRows` are in hand or the range is done, so a
 * caller never sees the cursor unless it wants one. Limits are a server-side time cap, a
 * response size cap, and `max_num_rows` - which the server may slightly OVERSHOOT to finish a
 * block group, so treat `maxRows` as a budget rather than an exact cap. `to_block` is
 * EXCLUSIVE, matching `eth_getLogs`.
 *
 * Errors follow the `rpc` and `defi` convention: an upstream that is down, rate-limited, slow,
 * or answered an error comes back as an `{error, status?}` value so the surrounding cell keeps
 * running, while a bad argument - an empty chain slug, a negative block - throws a TypeError,
 * because that is a bug in the caller.
 */

/** Archive queries can be slow; a 15s budget times out mid-scan on deep ranges. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Per-probe budget for `chains()`; a probe only answers yes/no, so it needs far less. */
const PROBE_TIMEOUT_SECONDS = 5;

/** How many chain probes run at once - enough to cover the list in seconds, few enough to be polite. */
const PROBE_CONCURRENCY = 8;

/** Default `maxRows` budget for one `logs()` scan. */
const DEFAULT_MAX_ROWS = 5000;

/**
 * The curated candidate list `chains()` probes. docs.envio.dev claims 80+ EVM chains; these are
 * the mainnets and testnets worth guessing first. A slug missing here still works - pass it
 * straight to `height`/`logs`/`query` and it becomes `https://<slug>.hypersync.xyz`.
 */
const CANDIDATE_CHAINS = [
	// mainnets
	"eth",
	"arbitrum",
	"base",
	"polygon",
	"optimism",
	"avalanche",
	"bsc",
	"scroll",
	"linea",
	"blast",
	"mode",
	"zksync",
	"mantle",
	"sei",
	"fraxtal",
	"unichain",
	"berachain",
	"sonic",
	"worldchain",
	"ink",
	"soneium",
	"lisk",
	"gnosis",
	"celo",
	"moonbeam",
	"moonriver",
	"boba",
	"metis",
	"polygon_zkevm",
	"immutable_zkevm",
	"taiko",
	"neon",
	"fuse",
	"astar",
	"cronos",
	"kava",
	"evmos",
	"hyperliquid",
	"abstract",
	// testnets
	"sepolia",
	"holesky",
	"base_sepolia",
	"arbitrum_sepolia",
	"optimism_sepolia",
];

/**
 * Fields asked for on every `logs` query. Log fields are FLAT - `topic0`..`topic3`, one name
 * each; a `topics` ARRAY is rejected with HTTP 400 "unknown variant" because it belongs to a
 * different version of the API.
 */
const FIELD_SELECTION = {
	block: ["number", "timestamp"],
	log: ["block_number", "address", "topic0", "topic1", "topic2", "topic3", "data", "transaction_hash"],
};

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

/** `chains()` memoises its probe result for the session; `clearHypersyncCache()` drops it. */
let chainMemo = null;

/** @returns {string} A short, readable type name for an error message. */
function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function failure(message, extra) {
	return extra?.status ? { error: message, status: extra.status } : { error: message };
}

/**
 * Validate a chain slug: it becomes a URL hostname, so it must look like one.
 *
 * @throws {TypeError} When it is empty or carries characters a hostname cannot.
 * @returns {string}
 */
function checkChain(chain, where) {
	if (typeof chain !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(chain.trim())) {
		throw new TypeError(
			`${where}: chain must be a HyperSync slug like "eth" or "base_sepolia", got ${typeName(chain)}`,
		);
	}
	return chain.trim();
}

/**
 * Validate a block number.
 *
 * @throws {TypeError} When it is not a non-negative integer.
 * @returns {number}
 */
function checkBlock(value, where, name) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new TypeError(`${where}: ${name} must be a non-negative integer block number, got ${typeName(value)}`);
	}
	return value;
}

/**
 * Normalise one filter value into the array the API wants: `address` and every `topicN` ride as
 * `string[]`, lowercased, omitted entirely when absent - and an omission IS the wildcard, the
 * same positional semantics as `eth_getLogs`.
 *
 * @throws {TypeError} On anything but a string or an array of strings.
 * @returns {string[]|undefined}
 */
function checkFilters(value, where, name) {
	if (value === undefined) return undefined;
	const list = Array.isArray(value) ? value : [value];
	for (const item of list) {
		if (typeof item !== "string" || item.trim() === "") {
			throw new TypeError(`${where}: ${name} entries must be non-empty hex strings, got ${typeName(item)}`);
		}
	}
	return list.map((item) => item.trim().toLowerCase());
}

/**
 * Build the fixed part of one `/query` body from `logs()` options.
 *
 * @returns {{to_block?: number, logs: object[], field_selection: object, max_num_rows: number}}
 */
function buildQueryBody({ toBlock, address, topic0, topic1, topic2, topic3, selections, maxRows }) {
	const where = "hypersync.logs";
	const selection =
		selections === undefined
			? [
					{
						address: checkFilters(address, where, "address"),
						topic0: checkFilters(topic0, where, "topic0"),
						topic1: checkFilters(topic1, where, "topic1"),
						topic2: checkFilters(topic2, where, "topic2"),
						topic3: checkFilters(topic3, where, "topic3"),
					},
				]
			: selections.map((entry) => ({
					address: checkFilters(entry?.address, where, "selection.address"),
					topic0: checkFilters(entry?.topic0, where, "selection.topic0"),
					topic1: checkFilters(entry?.topic1, where, "selection.topic1"),
					topic2: checkFilters(entry?.topic2, where, "selection.topic2"),
					topic3: checkFilters(entry?.topic3, where, "selection.topic3"),
				}));
	return {
		...(toBlock !== undefined ? { to_block: toBlock } : {}),
		logs: selection,
		field_selection: FIELD_SELECTION,
		max_num_rows: maxRows,
	};
}

/**
 * Flatten one `/query` response to its log rows. Rows live under `data[i].logs`, NOT under a
 * top-level `logs` - the single most common way to read this API wrong.
 *
 * @returns {object[]}
 */
function extractRows(response) {
	const data = /** @type {any} */ (response)?.data;
	if (!Array.isArray(data)) return [];
	return data.flatMap((group) => (Array.isArray(group?.logs) ? group.logs : []));
}

/**
 * One authenticated HyperSync REST call. GET when there is no body, POST when there is one.
 *
 * @throws {Error} With `.status` on an HTTP error, without one on a timeout or network failure.
 */
async function call(url, apiKey, body, timeoutSeconds) {
	const seconds = Number(timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
	const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
	const resp = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: { ...JSON_HEADERS, Authorization: `Bearer ${apiKey}` },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!resp.ok) {
		const detail = (await resp.text().catch(() => "")).trim().slice(0, 200);
		const error = new Error(`hypersync: ${url} returned HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
		error.status = resp.status;
		throw error;
	}
	try {
		return await resp.json();
	} catch {
		throw new Error(`hypersync: ${url} returned a non-JSON body`);
	}
}

/** Turn a thrown fetch/JSON error into the returned error value, naming timeouts. */
function transportFailure(where, url, error) {
	if (error?.name === "TimeoutError") {
		return failure(`${where}: request to ${url} timed out (raise { timeout })`);
	}
	return failure(`${where}: request to ${url} failed: ${error?.message || error}`, { status: error?.status });
}

/**
 * @param {number} total - Items to process.
 * @param {number} size - Concurrent workers.
 * @returns {number[][]} Contiguous chunks of indices `[0..total)`.
 */
function chunks(total, size) {
	const out = [];
	for (let start = 0; start < total; start += size) {
		out.push([...Array(Math.min(size, total - start)).keys()].map((i) => i + start));
	}
	return out;
}

export function createHypersync() {
	return {
		/**
		 * Latest indexed block for a chain - the cheap liveness probe and range planner.
		 *
		 * Returns the `height` NUMBER when the response carries one (the normal case), else the
		 * parsed body verbatim, so a caller rarely needs to know the envelope.
		 *
		 * @param {string} chain - HyperSync slug, e.g. `"eth"` or `"base_sepolia"`.
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=30] - Timeout in seconds.
		 * @returns {Promise<number|object|{error: string}>} The height, the raw body, or an error value.
		 */
		async height(chain, opts = {}) {
			const where = "hypersync.height";
			const slug = checkChain(chain, where);
			const apiKey = process.env.HYPERSYNC_API_KEY;
			if (!apiKey)
				return failure(`${where}: HYPERSYNC_API_KEY is not set (export it; never print or commit its value)`);
			const url = `https://${slug}.hypersync.xyz/height`;
			let out;
			try {
				out = await call(url, apiKey, undefined, opts.timeout);
			} catch (error) {
				return transportFailure(where, url, error);
			}
			const height = out?.height;
			return typeof height === "number" && Number.isFinite(height) ? height : out;
		},

		/**
		 * HyperSync slugs reachable from this machine, probed - NOT read off a listing service.
		 *
		 * `meta.hypersync.xyz`, the official chain list, is unreachable from many networks, so
		 * discovery asks each candidate chain's own `/height` instead and keeps the slugs that
		 * answer. Candidates come from `opts.candidates` or the curated list in this module.
		 * The result is memoised for the session; `{ refresh: true }` re-probes.
		 *
		 * A slug absent from the answer is absent only from THIS list - an undocumented chain
		 * still serves `https://<slug>.hypersync.xyz`, so pass a trusted name straight to
		 * `logs`/`height`/`query` rather than treating `chains()` as exhaustive.
		 *
		 * @param {object} [opts]
		 * @param {string[]} [opts.candidates] - Replace the curated candidate list.
		 * @param {boolean} [opts.refresh=false] - Re-probe past the session memo.
		 * @param {number} [opts.timeout=5] - Per-probe timeout in seconds.
		 * @returns {Promise<string[]|{error: string}>} Live slugs, sorted, or an error value
		 *   when nothing answered.
		 */
		async chains(opts = {}) {
			const where = "hypersync.chains";
			const candidates = opts.candidates ?? CANDIDATE_CHAINS;
			if (chainMemo && !opts.refresh) return chainMemo.slugs;
			const apiKey = process.env.HYPERSYNC_API_KEY;
			if (!apiKey)
				return failure(`${where}: HYPERSYNC_API_KEY is not set (export it; never print or commit its value)`);

			const live = new Set();
			let attempted = 0;
			for (const batch of chunks(candidates.length, PROBE_CONCURRENCY)) {
				const answers = await Promise.all(
					batch.map(async (index) => {
						const slug = candidates[index];
						attempted++;
						try {
							await call(
								`https://${slug}.hypersync.xyz/height`,
								apiKey,
								undefined,
								opts.timeout ?? PROBE_TIMEOUT_SECONDS,
							);
							return slug;
						} catch {
							return null;
						}
					}),
				);
				for (const slug of answers) if (slug) live.add(slug);
			}
			// Every probe failing means this machine cannot reach HyperSync at all; say so
			// instead of handing back an unverified list that looks authoritative.
			if (live.size === 0 && attempted > 0) {
				return failure(
					`${where}: none of ${attempted} candidate chains answered /height - HyperSync is unreachable from here`,
				);
			}
			const slugs = [...live].sort();
			chainMemo = { slugs };
			return slugs;
		},

		/**
		 * Historical event logs with pagination handled: give it a range and filters, get ROWS.
		 *
		 * This is the `eth_getLogs` replacement for DEEP history - governance event archaeology,
		 * transfer scans, indexer rebuilds, any range an RPC caps or prunes. It loops on
		 * `next_block` internally until `maxRows` rows are collected or the range completes, so
		 * a million-block scan is one call. It is the WRONG tool for a latest-state read - that
		 * is one `web3.rpc.call(url, "eth_getLogs", ...)` with no key and less latency.
		 *
		 * Filters mirror `eth_getLogs` positional semantics: omit a `topicN` and that position
		 * is a wildcard; several addresses or topics form an OR within the position. Pass
		 * `selections` instead of the flat filters to batch MULTIPLE filters into one query
		 * body - the recommended way to spend one rate-limited request per logical scan.
		 *
		 * `toBlock` is EXCLUSIVE. `maxRows` (default 5000) bounds the loop; the server may
		 * slightly overshoot it to finish a block group, so slice before trusting the exact
		 * count. Set the row budget deliberately either way - leaving `max_num_rows` implicit is
		 * what gets a client rate-limited.
		 *
		 * @param {string} chain - HyperSync slug.
		 * @param {object} opts
		 * @param {number} opts.fromBlock - First block, inclusive.
		 * @param {number} [opts.toBlock] - Last block, EXCLUSIVE.
		 * @param {string|string[]} [opts.address] - Contract address(es).
		 * @param {string|string[]} [opts.topic0] - Event signature hash(es).
		 * @param {string|string[]} [opts.topic1] [opts.topic2] [opts.topic3]
		 * @param {Array<object>} [opts.selections] - Multiple log selections in ONE query body,
		 *   each `{address?, topic0?, topic1?, topic2?, topic3?}`.
		 * @param {number} [opts.maxRows=5000] - Row budget across all pages.
		 * @param {number} [opts.timeout=30] - Per-request timeout in seconds.
		 * @returns {Promise<{rows: object[], nextBlock: number|null, archiveHeight: number|null, complete: boolean, queries: number}|{error: string, status?: number, rows?: object[], nextBlock?: number|null, complete?: boolean}>}
		 *   Collected rows plus the pagination state, or an error value. `complete` is false
		 *   with a non-null `nextBlock` when the budget stopped the scan early - resume by
		 *   passing that `nextBlock` as `fromBlock`.
		 */
		async logs(chain, opts = {}) {
			const where = "hypersync.logs";
			const slug = checkChain(chain, where);
			const fromBlock = checkBlock(opts.fromBlock, where, "fromBlock");
			const toBlock = opts.toBlock === undefined ? undefined : checkBlock(opts.toBlock, where, "toBlock");
			const maxRows = opts.maxRows === undefined ? DEFAULT_MAX_ROWS : checkBlock(opts.maxRows, where, "maxRows");
			if (toBlock !== undefined && toBlock <= fromBlock) {
				throw new TypeError(
					`${where}: toBlock (${toBlock}) must be greater than fromBlock (${fromBlock}); it is exclusive`,
				);
			}
			const apiKey = process.env.HYPERSYNC_API_KEY;
			if (!apiKey)
				return failure(`${where}: HYPERSYNC_API_KEY is not set (export it; never print or commit its value)`);

			const base = buildQueryBody({ ...opts, toBlock, maxRows });
			const url = `https://${slug}.hypersync.xyz/query`;
			const rows = [];
			let cursor = fromBlock;
			let nextBlock = null;
			let archiveHeight = null;
			let queries = 0;

			while (rows.length < maxRows) {
				let out;
				try {
					out = await call(url, apiKey, { ...base, from_block: cursor }, opts.timeout);
				} catch (error) {
					const err = transportFailure(where, url, error);
					// A mid-scan failure hands back what was already collected plus the cursor to
					// resume from, so a long scan survives one flake instead of restarting.
					return queries === 0 ? err : { ...err, rows, nextBlock: cursor };
				}
				queries++;
				rows.push(...extractRows(out));
				archiveHeight = typeof out?.archive_height === "number" ? out.archive_height : archiveHeight;
				nextBlock = typeof out?.next_block === "number" ? out.next_block : null;
				// No cursor ends the range; a cursor that does not advance cannot be followed
				// without looping forever; an exclusive to_block stops the walk itself.
				if (nextBlock === null || nextBlock <= cursor || (toBlock !== undefined && nextBlock >= toBlock)) {
					const complete = nextBlock === null || (toBlock !== undefined && nextBlock >= toBlock);
					return { rows, nextBlock, archiveHeight, complete, queries };
				}
				cursor = nextBlock;
			}
			return { rows, nextBlock, archiveHeight, complete: false, queries };
		},

		/**
		 * Raw `POST /query` passthrough for everything `logs` does not model: other row types
		 * (`transactions`, `blocks`, `traces`), custom `field_selection`, joins, contracts.
		 * Returns the parsed response VERBATIM - nested `data[i].logs`, `next_block` cursor and
		 * all - paginating is then the caller's job.
		 *
		 * @param {string} chain - HyperSync slug.
		 * @param {object} body - Query body per docs.envio.dev.
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=30] - Timeout in seconds.
		 * @returns {Promise<object|{error: string}>} The parsed response, or an error value.
		 */
		async query(chain, body, opts = {}) {
			const where = "hypersync.query";
			const slug = checkChain(chain, where);
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				throw new TypeError(`${where}: body must be a query object, got ${typeName(body)}`);
			}
			const apiKey = process.env.HYPERSYNC_API_KEY;
			if (!apiKey)
				return failure(`${where}: HYPERSYNC_API_KEY is not set (export it; never print or commit its value)`);
			const url = `https://${slug}.hypersync.xyz/query`;
			try {
				return await call(url, apiKey, body, opts.timeout);
			} catch (error) {
				return transportFailure(where, url, error);
			}
		},
	};
}

/** Drop the memoised `chains()` probe result. Exported for tests. */
export function clearHypersyncCache() {
	chainMemo = null;
}

/** The curated candidate list, exported for tests and caller inspection. */
export const candidateChains = CANDIDATE_CHAINS;
