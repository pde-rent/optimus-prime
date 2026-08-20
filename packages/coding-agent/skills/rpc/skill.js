/**
 * JSON-RPC 2.0 over HTTP: one `fetch` POST per round trip, no SDK.
 *
 * A JSON-RPC request is `{jsonrpc: "2.0", id, method, params}` posted as JSON, and every chain
 * node, Bitcoin-style daemon, and plain JSON-RPC service speaks it. That is small enough that a
 * client library buys nothing but a dependency and a chain list that goes stale, so this skill
 * is the transport and nothing else: no chain registry, no bundled endpoints, no ABI encoding,
 * no key handling, no signing. The caller composes the method and params.
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
 */

const DEFAULT_TIMEOUT_SECONDS = 15;

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
 * @throws {TypeError} On a bad url, method, or params - all caller bugs.
 */
function checkRequest(url, method, params) {
	if (typeof url !== "string" || url.trim() === "") {
		throw new TypeError(`rpc: url must be a non-empty string, got ${typeName(url)}`);
	}
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

export default function createSkill() {
	return {
		/**
		 * Call one JSON-RPC method and return its `result`.
		 *
		 * Chain-agnostic: `url` and `method` are whatever the node speaks -
		 * `rpc.call(url, "eth_call", [{to, data}, "latest"])` on an EVM node,
		 * `rpc.call(url, "getBalance", [address])` on Solana, `rpc.call(url, "getblockcount")`
		 * on Bitcoin. Nothing here knows about chains.
		 *
		 * Never throws on a network, HTTP, or RPC-level failure: those come back as
		 * `{error, code?, data?, status?}`, so check `.error` before using the value. Bad
		 * arguments (non-string url or method) throw, because those are caller bugs.
		 *
		 * @param {string} url - Node HTTP endpoint.
		 * @param {string} method - JSON-RPC method name.
		 * @param {unknown[]|object} [params=[]] - Positional or named params.
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=15] - Timeout in seconds.
		 * @param {Record<string,string>} [opts.headers] - Extra headers, e.g. an API key.
		 * @returns {Promise<unknown>} The `result` value, or an error object.
		 */
		async call(url, method, params, opts = {}) {
			checkRequest(url, method, params);
			try {
				const body = await post(url, envelope(nextId++, method, params), opts);
				// A server may answer a single request with a one-element batch; accept both.
				return unwrap(Array.isArray(body) ? body[0] : body, method);
			} catch (e) {
				return e?.status ? failure(e.message, { status: e.status }) : transportFailure(url, e);
			}
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
		 * @param {string} url - Node HTTP endpoint.
		 * @param {Array<{method: string, params?: unknown}|[string, unknown]|string>} calls
		 * @param {object} [opts]
		 * @param {number} [opts.timeout=15] - Timeout in seconds.
		 * @param {Record<string,string>} [opts.headers] - Extra headers.
		 * @returns {Promise<unknown[]>} One entry per call: the `result`, or an error object.
		 */
		async batch(url, calls, opts = {}) {
			if (!Array.isArray(calls)) throw new TypeError(`rpc.batch: calls must be an array, got ${typeName(calls)}`);
			if (calls.length === 0) return [];

			const normalized = calls.map((entry, index) => normalizeCall(entry, index));
			for (const { method, params } of normalized) checkRequest(url, method, params);

			const ids = normalized.map(() => nextId++);
			const body = normalized.map(({ method, params }, i) => envelope(ids[i], method, params));

			let response;
			try {
				response = await post(url, body, opts);
			} catch (e) {
				const asValue = e?.status ? failure(e.message, { status: e.status }) : transportFailure(url, e);
				return normalized.map(() => asValue);
			}

			if (!Array.isArray(response)) {
				// A batch answered with a bare object is either a server-level error or a server
				// that does not implement batching; either way no call produced a result.
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
		},

		toBigInt,
		fromUnits,
		toUnits,
	};
}
