import { describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as statsSkill from "../skills/stats/skill.js";

const { default: createSkill } = statsSkill;

const stats = createSkill();

/** Every function takes an array first, so one table drives the shared validation tests. */
const ARRAY_FUNCTIONS: Array<[string, (xs: unknown) => unknown]> = [
	["sum", (xs) => stats.sum(xs)],
	["mean", (xs) => stats.mean(xs)],
	["median", (xs) => stats.median(xs)],
	["min", (xs) => stats.min(xs)],
	["max", (xs) => stats.max(xs)],
	["quantile", (xs) => stats.quantile(xs, 0.5)],
	["variance", (xs) => stats.variance(xs, { population: true })],
	["stddev", (xs) => stats.stddev(xs, { population: true })],
	["describe", (xs) => stats.describe(xs)],
	["corr", (xs) => stats.corr(xs, [1, 2])],
];

describe("stats: input validation", () => {
	for (const [name, fn] of ARRAY_FUNCTIONS) {
		it(`${name} throws a TypeError on an empty array`, () => {
			expect(() => fn([])).toThrow(TypeError);
			expect(() => fn([])).toThrow(/non-empty/);
		});

		it(`${name} throws a TypeError on a non-array`, () => {
			for (const bad of [undefined, null, 5, "1,2,3", { 0: 1, length: 1 }]) {
				expect(() => fn(bad)).toThrow(TypeError);
			}
		});

		it(`${name} throws a TypeError naming the offending index`, () => {
			expect(() => fn([1, 2, Number.NaN])).toThrow(/element 2/);
			expect(() => fn([1, Number.POSITIVE_INFINITY, 3])).toThrow(TypeError);
			expect(() => fn([1, "2" as unknown as number, 3])).toThrow(/element 1/);
		});
	}

	it("corr validates its second array too", () => {
		expect(() => stats.corr([1, 2], [])).toThrow(TypeError);
		expect(() => stats.corr([1, 2], [1, Number.NaN])).toThrow(TypeError);
	});
});

describe("stats.sum", () => {
	it("sums an ordinary array", () => {
		expect(stats.sum([1, 2, 3, 4])).toBe(10);
		expect(stats.sum([5])).toBe(5);
		expect(stats.sum([-1.5, 1.5])).toBe(0);
	});

	it("is exact where a naive reduce is not", () => {
		// 1 plus 1e100 plus 1 minus 1e100: naive left-to-right summation loses both ones.
		const xs = [1, 1e100, 1, -1e100];
		expect(xs.reduce((a, b) => a + b, 0)).toBe(0); // the bug being avoided
		expect(stats.sum(xs)).toBe(2);
	});

	it("beats a naive reduce over many small values", () => {
		const xs = new Array(10_000).fill(0.1);
		expect(stats.sum(xs)).toBe(1000);
		expect(xs.reduce((a, b) => a + b, 0)).not.toBe(1000);
	});
});

describe("stats.mean", () => {
	it("returns the arithmetic mean", () => {
		expect(stats.mean([12, 9, 41, 7])).toBe(17.25);
		expect(stats.mean([5])).toBe(5);
		expect(stats.mean([-2, 2])).toBe(0);
	});
});

describe("stats.min / stats.max", () => {
	it("returns the extremes", () => {
		expect(stats.min([3, 1, 4, 1, 5])).toBe(1);
		expect(stats.max([3, 1, 4, 1, 5])).toBe(5);
		expect(stats.min([-0.5])).toBe(-0.5);
		expect(stats.max([-3, -1, -7])).toBe(-1);
	});

	it("handles an array far past the spread-argument stack limit", () => {
		// Math.min(...xs) overflows the call stack here; the loop does not.
		const xs = new Array(200_000).fill(1);
		xs[123_456] = -9;
		xs[7] = 42;
		expect(stats.min(xs)).toBe(-9);
		expect(stats.max(xs)).toBe(42);
	});
});

describe("stats.quantile / stats.median", () => {
	it("interpolates linearly between order statistics", () => {
		expect(stats.quantile([1, 2, 3, 4], 0)).toBe(1);
		expect(stats.quantile([1, 2, 3, 4], 1)).toBe(4);
		expect(stats.quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(stats.quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
		expect(stats.quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
		expect(stats.quantile([15, 20, 35, 40, 50], 0.4)).toBe(29);
	});

	it("medians an odd and an even sample", () => {
		expect(stats.median([3, 1, 2])).toBe(2);
		expect(stats.median([4, 1, 3, 2])).toBe(2.5);
		expect(stats.median([9])).toBe(9);
	});

	it("sorts numerically, not lexicographically", () => {
		// [10, 9].sort() is [10, 9]; a lexicographic median would be 9.5 either way, so use a
		// case where the difference is visible.
		expect(stats.median([2, 10, 9])).toBe(9);
		expect(stats.max([9, 10, 100])).toBe(100);
	});

	it("does not reorder the caller's array", () => {
		const xs = [3, 1, 2];
		stats.median(xs);
		stats.quantile(xs, 0.9);
		stats.describe(xs);
		expect(xs).toEqual([3, 1, 2]);
	});

	it("rejects a q outside 0..1", () => {
		for (const q of [-0.1, 1.1, Number.NaN, "0.5", undefined, null]) {
			expect(() => stats.quantile([1, 2, 3], q)).toThrow(TypeError);
		}
	});
});

describe("stats.variance / stats.stddev", () => {
	const xs = [2, 4, 4, 4, 5, 5, 7, 9];

	it("is the sample (n-1) form by default", () => {
		expect(stats.variance(xs)).toBeCloseTo(4.571428571428571, 12);
		expect(stats.stddev(xs)).toBeCloseTo(2.13808993529939, 12);
	});

	it("divides by n with { population: true }", () => {
		expect(stats.variance(xs, { population: true })).toBe(4);
		expect(stats.stddev(xs, { population: true })).toBe(2);
	});

	it("is 0 for a constant series and never negative", () => {
		expect(stats.variance([7, 7, 7])).toBe(0);
		expect(stats.stddev([7, 7, 7])).toBe(0);
		// The E[x²] - E[x]² shortcut can go negative here; the two-pass form cannot.
		expect(stats.variance([1e9 + 4, 1e9 + 7, 1e9 + 13], { population: true })).toBeGreaterThanOrEqual(0);
	});

	it("throws for n = 1 unless the population form is asked for", () => {
		expect(() => stats.variance([3])).toThrow(/at least 2 values/);
		expect(() => stats.stddev([3])).toThrow(TypeError);
		expect(stats.variance([3], { population: true })).toBe(0);
		expect(stats.stddev([3], { population: true })).toBe(0);
	});
});

describe("stats.corr", () => {
	it("returns 1 and -1 for perfect relationships, never past the range", () => {
		expect(stats.corr([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
		expect(stats.corr([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
		expect(stats.corr([1, 2, 3, 4], [2, 4, 6, 8])).toBeLessThanOrEqual(1);
		expect(stats.corr([1, 2, 3, 4], [8, 6, 4, 2])).toBeGreaterThanOrEqual(-1);
	});

	it("matches a known Pearson value", () => {
		// cov = 8, sxx = syy = 10 => r = 0.8
		expect(stats.corr([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 12);
	});

	it("is NaN when a series is constant", () => {
		expect(Number.isNaN(stats.corr([1, 1, 1], [1, 2, 3]))).toBe(true);
		expect(Number.isNaN(stats.corr([1, 2, 3], [5, 5, 5]))).toBe(true);
	});

	it("rejects mismatched lengths and single pairs", () => {
		expect(() => stats.corr([1, 2, 3], [1, 2])).toThrow(/same length/);
		expect(() => stats.corr([1], [1])).toThrow(/at least 2 pairs/);
	});
});

describe("stats.describe", () => {
	it("returns an object with every documented key", () => {
		const out = stats.describe([1, 2, 3, 4]);
		expect(Object.keys(out).sort()).toEqual(["max", "mean", "median", "min", "n", "q1", "q3", "stddev", "sum"]);
		expect(out).toEqual({
			n: 4,
			min: 1,
			max: 4,
			mean: 2.5,
			median: 2.5,
			stddev: stats.stddev([1, 2, 3, 4]),
			sum: 10,
			q1: 1.75,
			q3: 3.25,
		});
	});

	it("reports stddev 0 for a single value rather than throwing", () => {
		expect(stats.describe([5])).toEqual({
			n: 1,
			min: 5,
			max: 5,
			mean: 5,
			median: 5,
			stddev: 0,
			sum: 5,
			q1: 5,
			q3: 5,
		});
	});

	it("summarises an unsorted array correctly", () => {
		const out = stats.describe([9, 1, 5, 3]);
		expect(out.min).toBe(1);
		expect(out.max).toBe(9);
		expect(out.median).toBe(4);
	});
});

describe("stats skill surface", () => {
	it("exposes exactly the documented API and mirrors nothing from Math", () => {
		expect(Object.keys(stats).sort()).toEqual([
			"corr",
			"describe",
			"max",
			"mean",
			"median",
			"min",
			"quantile",
			"stddev",
			"sum",
			"variance",
		]);
	});
});
