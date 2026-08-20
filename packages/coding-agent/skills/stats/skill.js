/**
 * The numeric helpers `Math` genuinely lacks: statistics over an array.
 *
 * `Math` already covers scalars, so nothing here mirrors it. What it has no answer for is a
 * `number[]` - a run of latencies, a column of token counts, a benchmark series - and the
 * hand-rolled one-liners for that are wrong in ways that only show up on real data:
 *
 *   - `xs.reduce((a, b) => a + b)` loses low-order bits as the running total grows. Over ten
 *     thousand samples the error is visible in the mean. `sum` uses Neumaier compensation,
 *     which keeps the lost bits in a separate accumulator and adds them back at the end.
 *   - `Math.min(...xs)` passes every element as an argument and overflows the call stack
 *     somewhere past ~100k elements - a crash that appears only once the data gets big. `min`
 *     and `max` loop instead.
 *   - `xs.sort()` sorts lexicographically, so `[10, 9]` comes back as `[10, 9]`. Every
 *     order-statistic function here sorts a *copy* numerically, leaving the caller's array
 *     untouched.
 *
 * Every function validates its input and throws a `TypeError` naming the problem, because a
 * statistic of a bad array is a caller bug, not a recoverable condition - and `NaN` propagating
 * silently through a report is exactly what that should not become.
 */

/**
 * Validate a sample and return it unchanged.
 *
 * @param {number[]} xs
 * @param {string} where - Function name, for the message.
 * @returns {number[]}
 * @throws {TypeError} When `xs` is not an array, is empty, or holds a non-finite value.
 */
function sample(xs, where) {
	if (!Array.isArray(xs)) {
		throw new TypeError(`${where}: expected an array of numbers, got ${xs === null ? "null" : typeof xs}`);
	}
	if (xs.length === 0) throw new TypeError(`${where}: expected a non-empty array`);
	for (let i = 0; i < xs.length; i++) {
		if (typeof xs[i] !== "number" || !Number.isFinite(xs[i])) {
			throw new TypeError(`${where}: element ${i} is not a finite number (${String(xs[i])})`);
		}
	}
	return xs;
}

/**
 * Neumaier compensated summation: an improvement on Kahan that is also correct when the next
 * term is larger in magnitude than the running total.
 *
 * @param {number[]} xs
 * @returns {number} The sum, with the accumulated rounding error added back.
 */
export function sum(xs) {
	sample(xs, "stats.sum");
	let total = 0;
	let lost = 0; // the low-order bits each addition dropped
	for (const x of xs) {
		const next = total + x;
		lost += Math.abs(total) >= Math.abs(x) ? total - next + x : x - next + total;
		total = next;
	}
	return total + lost;
}

/**
 * Arithmetic mean, over the compensated sum.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
	sample(xs, "stats.mean");
	return sum(xs) / xs.length;
}

/**
 * Smallest value. Loops rather than `Math.min(...xs)`, which blows the call stack past ~100k
 * elements.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function min(xs) {
	sample(xs, "stats.min");
	let out = xs[0];
	for (const x of xs) if (x < out) out = x;
	return out;
}

/**
 * Largest value. Loops, for the same reason as `min`.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function max(xs) {
	sample(xs, "stats.max");
	let out = xs[0];
	for (const x of xs) if (x > out) out = x;
	return out;
}

/** Numerically sorted copy; the caller's array is never reordered. */
function sorted(xs) {
	return [...xs].sort((a, b) => a - b);
}

/**
 * Quantile by linear interpolation between order statistics (the R type-7 definition, which is
 * also numpy's and pandas' default), so `quantile(xs, 0.5)` is the median including the
 * even-length average.
 *
 * @param {number[]} xs
 * @param {number} q - In `0..1` inclusive.
 * @returns {number} The interpolated value; an element of `xs` when the position lands exactly.
 * @throws {TypeError} On a bad array, or a `q` that is not a finite number in `0..1`.
 */
export function quantile(xs, q) {
	sample(xs, "stats.quantile");
	if (typeof q !== "number" || !Number.isFinite(q) || q < 0 || q > 1) {
		throw new TypeError(`stats.quantile: q must be a number in 0..1, got ${String(q)}`);
	}
	const values = sorted(xs);
	const position = (values.length - 1) * q;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return values[lower];
	return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

/**
 * Median: the 0.5 quantile, averaging the middle pair on an even-length sample.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function median(xs) {
	sample(xs, "stats.median");
	return quantile(xs, 0.5);
}

/**
 * Variance. **Sample** variance (Bessel-corrected, divided by `n - 1`) by default, because a
 * measured series is nearly always a sample of a larger population and dividing by `n`
 * underestimates the spread. Pass `{ population: true }` for the `/ n` form.
 *
 * @param {number[]} xs
 * @param {{population?: boolean}} [opts]
 * @returns {number} Always >= 0.
 * @throws {TypeError} On a bad array, or on a single-element array without `{population: true}`,
 *   since sample variance is undefined for `n = 1`.
 */
export function variance(xs, opts = {}) {
	sample(xs, "stats.variance");
	const n = xs.length;
	const population = opts?.population === true;
	if (!population && n < 2) {
		throw new TypeError(
			"stats.variance: sample variance needs at least 2 values; pass { population: true } for n = 1",
		);
	}
	const m = mean(xs);
	// Two-pass (deviations from the mean), not the E[x^2] - E[x]^2 shortcut: the shortcut
	// subtracts two large nearly-equal numbers and can return a negative variance.
	const squares = xs.map((x) => (x - m) ** 2);
	return sum(squares) / (population ? n : n - 1);
}

/**
 * Standard deviation: the square root of `variance`, so **sample** (`n - 1`) by default.
 *
 * @param {number[]} xs
 * @param {{population?: boolean}} [opts]
 * @returns {number} Always >= 0, in the same units as the input.
 */
export function stddev(xs, opts = {}) {
	sample(xs, "stats.stddev");
	return Math.sqrt(variance(xs, opts));
}

/**
 * Pearson correlation coefficient of two equal-length samples.
 *
 * @param {number[]} xs
 * @param {number[]} ys - Must be the same length as `xs`.
 * @returns {number} `r` in `-1..1`; `NaN` when either series is constant, since a series with
 *   no variance has no correlation to measure.
 * @throws {TypeError} On a bad array, mismatched lengths, or fewer than 2 pairs.
 */
export function corr(xs, ys) {
	sample(xs, "stats.corr");
	sample(ys, "stats.corr");
	if (xs.length !== ys.length) {
		throw new TypeError(`stats.corr: arrays must be the same length, got ${xs.length} and ${ys.length}`);
	}
	if (xs.length < 2) throw new TypeError("stats.corr: needs at least 2 pairs");

	const mx = mean(xs);
	const my = mean(ys);
	const covariance = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)));
	const spreadX = Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)));
	const spreadY = Math.sqrt(sum(ys.map((y) => (y - my) ** 2)));
	const denominator = spreadX * spreadY;
	if (denominator === 0) return Number.NaN;
	// Rounding can push a perfect correlation a hair past 1; clamp so the range holds.
	return Math.min(1, Math.max(-1, covariance / denominator));
}

/**
 * One summary of a sample, for when the shape matters more than any single number.
 *
 * @param {number[]} xs
 * @returns {{n: number, min: number, max: number, mean: number, median: number,
 *   stddev: number, sum: number, q1: number, q3: number}} `stddev` is the sample form, and is
 *   `0` for a single value rather than throwing - a summary should describe what it was given.
 */
export function describe(xs) {
	sample(xs, "stats.describe");
	const values = sorted(xs);
	return {
		n: values.length,
		min: values[0],
		max: values[values.length - 1],
		mean: mean(values),
		median: quantile(values, 0.5),
		stddev: values.length < 2 ? 0 : stddev(values),
		sum: sum(values),
		q1: quantile(values, 0.25),
		q3: quantile(values, 0.75),
	};
}

export default function createSkill() {
	return { sum, mean, min, max, median, quantile, variance, stddev, corr, describe };
}
