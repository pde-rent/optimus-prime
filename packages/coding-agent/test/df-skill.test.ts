import { describe, expect, it } from "bun:test";
import { inspect } from "node:util";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as dfSkill from "../skills/df/skill.js";

const { default: createSkill, DataFrame, Column, pack, AGGS, dtypeOf } = dfSkill;

const df = createSkill();

type Row = Record<string, unknown>;

const CHAINS: Row[] = [
	{ name: "Ethereum", symbol: "ETH", tvl: 46, volume: 2305 },
	{ name: "BSC", symbol: "BNB", tvl: 5.2, volume: 2978 },
	{ name: "Solana", symbol: "SOL", tvl: 5.1, volume: 6267 },
	{ name: "Base", symbol: null, tvl: 5.0, volume: null },
];

describe("construction", () => {
	it("builds a frame from an array of objects", () => {
		const frame = df(CHAINS);
		expect(frame).toBeInstanceOf(DataFrame);
		expect(frame.columns).toEqual(["name", "symbol", "tvl", "volume"]);
		expect(frame.shape).toEqual([4, 4]);
		expect(frame.len()).toBe(4);
		expect(frame.height).toBe(4);
		expect(frame.width).toBe(4);
	});

	it("takes the union of every row's keys, in first-appearance order", () => {
		const frame = df([{ b: 1 }, { a: 2 }, { c: 3, a: 4 }]);
		expect(frame.columns).toEqual(["b", "a", "c"]);
	});

	it("fills an absent key with null rather than leaving a hole", () => {
		const frame = df([{ a: 1 }, { b: 2 }]);
		expect(frame.to_dicts()).toEqual([
			{ a: 1, b: null },
			{ a: null, b: 2 },
		]);
	});

	it("keeps null distinguishable from 0", () => {
		const frame = df([{ v: 0 }, { v: null }, { v: undefined }]);
		expect(frame.get_column("v")).toEqual([0, null, null]);
		expect(frame.drop_nulls().len()).toBe(1);
		expect(frame.group_by("v").len().to_dicts()).toEqual([
			{ v: 0, len: 1 },
			{ v: null, len: 2 },
		]);
	});

	it("passes an existing frame through unchanged", () => {
		const frame = df(CHAINS);
		expect(df(frame)).toBe(frame);
	});

	it("builds from columns, with the pandas alias", () => {
		const frame = df.from_columns({ a: [1, 2], b: ["x", "y"] });
		expect(frame.to_dicts()).toEqual([
			{ a: 1, b: "x" },
			{ a: 2, b: "y" },
		]);
		expect(df.from_dict).toBe(df.from_columns);
		expect(df.from_records).toBe(df);
		expect(df.from_dicts).toBe(df);
	});

	it("concatenates frames, filling the columns one side lacks", () => {
		const out = df.concat([df([{ a: 1 }]), df([{ a: 2, b: 3 }])]);
		expect(out.columns).toEqual(["a", "b"]);
		expect(out.to_dicts()).toEqual([
			{ a: 1, b: null },
			{ a: 2, b: 3 },
		]);
	});

	it("reports polars short dtypes, widening ints beside floats", () => {
		expect(df(CHAINS).dtypes).toEqual({ name: "str", symbol: "str", tvl: "f64", volume: "i64" });
		expect(dtypeOf([1, 2, 3])).toBe("i64");
		expect(dtypeOf([1, 2.5])).toBe("f64");
		expect(dtypeOf([null, null])).toBe("null");
		expect(dtypeOf([true, false])).toBe("bool");
		expect(dtypeOf([new Date(0)])).toBe("date");
		expect(dtypeOf([1, "a"])).toBe("obj");
	});
});

describe("select, drop, rename", () => {
	it("selects columns in the order asked for, varargs or array", () => {
		expect(df(CHAINS).select("tvl", "name").columns).toEqual(["tvl", "name"]);
		expect(df(CHAINS).select(["tvl", "name"]).columns).toEqual(["tvl", "name"]);
	});

	it("drops columns", () => {
		expect(df(CHAINS).drop("symbol", "volume").columns).toEqual(["name", "tvl"]);
	});

	it("renames while keeping column order", () => {
		const out = df(CHAINS).rename({ tvl: "value" });
		expect(out.columns).toEqual(["name", "symbol", "value", "volume"]);
		expect(out.get_column("value")[0]).toBe(46);
	});

	it("leaves the source frame untouched", () => {
		const frame = df(CHAINS);
		frame.drop("tvl");
		frame.rename({ tvl: "value" });
		expect(frame.columns).toEqual(["name", "symbol", "tvl", "volume"]);
	});
});

describe("filter", () => {
	// The exact case arquero cannot do: its table expressions are compiled and reject a captured
	// variable outright, which is why this library exists at all.
	it("runs a closure that captures an outer variable", () => {
		const cutoff = 5.15;
		const out = df(CHAINS).filter((r: Row) => (r.tvl as number) >= cutoff);
		expect(out.get_column("name")).toEqual(["Ethereum", "BSC"]);
	});

	it("passes the row index as the second argument", () => {
		const out = df(CHAINS).filter((_r: Row, i: number) => i % 2 === 0);
		expect(out.get_column("name")).toEqual(["Ethereum", "Solana"]);
	});

	it("coerces the predicate's return to a boolean", () => {
		expect(
			df(CHAINS)
				.filter((r: Row) => r.symbol)
				.len(),
		).toBe(3);
	});
});

describe("with_columns", () => {
	// Same captured-variable guarantee as filter, on the expression side.
	it("runs a closure that captures an outer variable", () => {
		const total = 61.3;
		const out = df(CHAINS).with_columns({ share: (r: Row) => (r.tvl as number) / total });
		expect(out.columns).toEqual(["name", "symbol", "tvl", "volume", "share"]);
		expect(out.get_column("share")[0]).toBeCloseTo(46 / total, 10);
	});

	it("applies entries in order, so a later one sees an earlier one", () => {
		const out = df([{ qty: 2, price: 10 }]).with_columns({
			gross: (r: Row) => (r.qty as number) * (r.price as number),
			net: (r: Row) => (r.gross as number) * 0.5,
		});
		expect(out.to_dicts()).toEqual([{ qty: 2, price: 10, gross: 20, net: 10 }]);
	});

	it("replaces an existing column in place", () => {
		const out = df(CHAINS).with_columns({ tvl: (r: Row) => (r.tvl as number) * 2 });
		expect(out.columns).toEqual(["name", "symbol", "tvl", "volume"]);
		expect(out.get_column("tvl")).toEqual([92, 10.4, 10.2, 10]);
	});

	it("accepts a constant and turns undefined into null", () => {
		const out = df([{ a: 1 }]).with_columns({ tag: "x", missing: () => undefined });
		expect(out.to_dicts()).toEqual([{ a: 1, tag: "x", missing: null }]);
	});

	it("is aliased as assign", () => {
		expect(DataFrame.prototype.assign).toBe(DataFrame.prototype.with_columns);
		expect(
			df([{ a: 1 }])
				.assign({ b: (r: Row) => (r.a as number) + 1 })
				.get_column("b"),
		).toEqual([2]);
	});
});

describe("sort", () => {
	const ties = [
		{ k: "b", i: 0 },
		{ k: "a", i: 1 },
		{ k: "b", i: 2 },
		{ k: "a", i: 3 },
	];

	it("is stable, ascending and descending alike", () => {
		expect(df(ties).sort("k").get_column("i")).toEqual([1, 3, 0, 2]);
		expect(df(ties).sort("k", { descending: true }).get_column("i")).toEqual([0, 2, 1, 3]);
	});

	it("sorts descending by value", () => {
		expect(df(CHAINS).sort("tvl", { descending: true }).get_column("name")).toEqual([
			"Ethereum",
			"BSC",
			"Solana",
			"Base",
		]);
	});

	it("sorts by several columns with per-column direction", () => {
		const rows = [
			{ g: "a", v: 1 },
			{ g: "b", v: 2 },
			{ g: "a", v: 3 },
		];
		const out = df(rows).sort(["g", "v"], { descending: [false, true] });
		expect(out.to_dicts()).toEqual([
			{ g: "a", v: 3 },
			{ g: "a", v: 1 },
			{ g: "b", v: 2 },
		]);
	});

	it("accepts a key function", () => {
		expect(
			df([{ n: "b" }, { n: "A" }])
				.sort((r: Row) => (r.n as string).toLowerCase())
				.get_column("n"),
		).toEqual(["A", "b"]);
	});

	it("puts nulls last in both directions, and first on request", () => {
		const rows = [{ v: 2 }, { v: null }, { v: 1 }];
		expect(df(rows).sort("v").get_column("v")).toEqual([1, 2, null]);
		expect(df(rows).sort("v", { descending: true }).get_column("v")).toEqual([2, 1, null]);
		expect(df(rows).sort("v", { nulls_last: false }).get_column("v")).toEqual([null, 1, 2]);
	});

	// sort_values stopped being an alias when it took on the pandas positional signature, so what
	// is pinned here is that both spellings still reach the same sort, not that they are one object.
	it("takes the pandas ascending option through sort_values", () => {
		expect(df(CHAINS).sort_values("tvl", { ascending: false }).get_column("name")[0]).toBe("Ethereum");
		expect(df(CHAINS).sort_values("tvl").get_column("name")[0]).toBe("Base");
	});

	// The transcript's call. It used to be read as `{}`, so it sorted ascending and returned the
	// bottom of the table under the name of the top — wrong data, no error.
	it("reads the pandas second positional as ascending, not as options", () => {
		expect(df(CHAINS).sort_values("tvl", false).get_column("name")).toEqual(["Ethereum", "BSC", "Solana", "Base"]);
		expect(df(CHAINS).sort_values("tvl", true).get_column("name")).toEqual(["Base", "Solana", "BSC", "Ethereum"]);
	});

	it("takes a per-column direction array positionally too", () => {
		const rows = [
			{ g: "a", v: 1 },
			{ g: "b", v: 2 },
			{ g: "a", v: 3 },
		];
		expect(df(rows).sort_values(["g", "v"], [true, false]).to_dicts()).toEqual([
			{ g: "a", v: 3 },
			{ g: "a", v: 1 },
			{ g: "b", v: 2 },
		]);
	});

	// polars spells the direction `descending`, pandas spells it `ascending`; a bare boolean under
	// the polars name would mean the opposite of what a pandas hand wrote.
	it("refuses a bare boolean on the polars sort rather than guessing its sense", () => {
		expect(() => df(CHAINS).sort("tvl", false)).toThrow(TypeError);
		expect(() => df(CHAINS).sort("tvl", false)).toThrow(/sort_values\(by, ascending\)/);
	});

	it("orders dates and strings, not just numbers", () => {
		const rows = [{ d: new Date(2000) }, { d: new Date(1000) }];
		expect(df(rows).sort("d").get_column("d")[0]).toEqual(new Date(1000));
	});
});

describe("head, tail, slice", () => {
	it("takes from either end, defaulting to 5", () => {
		expect(df(CHAINS).head(2).get_column("name")).toEqual(["Ethereum", "BSC"]);
		expect(df(CHAINS).tail(2).get_column("name")).toEqual(["Solana", "Base"]);
		expect(df(CHAINS).head().len()).toBe(4);
	});

	it("slices, counting a negative offset from the end", () => {
		expect(df(CHAINS).slice(1, 2).get_column("name")).toEqual(["BSC", "Solana"]);
		expect(df(CHAINS).slice(2).get_column("name")).toEqual(["Solana", "Base"]);
		expect(df(CHAINS).slice(-1).get_column("name")).toEqual(["Base"]);
	});
});

describe("unique and drop_nulls", () => {
	const dupes = [
		{ a: 1, b: "x" },
		{ a: 1, b: "y" },
		{ a: 1, b: "x" },
		{ a: 2, b: "x" },
	];

	it("keeps the first row of each distinct combination", () => {
		expect(df(dupes).unique().len()).toBe(3);
		expect(df(dupes).unique("a").to_dicts()).toEqual([
			{ a: 1, b: "x" },
			{ a: 2, b: "x" },
		]);
		expect(df(dupes).unique(["a", "b"]).len()).toBe(3);
	});

	it("does not collide values of different types", () => {
		expect(
			df([{ v: 1 }, { v: "1" }, { v: true }, { v: null }])
				.unique()
				.len(),
		).toBe(4);
	});

	it("drops rows holding a null, over all columns or a subset", () => {
		expect(df(CHAINS).drop_nulls().len()).toBe(3);
		expect(df(CHAINS).drop_nulls("volume").len()).toBe(3);
		expect(df(CHAINS).drop_nulls("tvl").len()).toBe(4);
		expect(DataFrame.prototype.dropna).toBe(DataFrame.prototype.drop_nulls);
		expect(DataFrame.prototype.drop_duplicates).toBe(DataFrame.prototype.unique);
	});
});

describe("group_by", () => {
	const sales = [
		{ region: "eu", product: "a", qty: 2, note: null },
		{ region: "eu", product: "b", qty: 3, note: "x" },
		{ region: "us", product: "a", qty: 5, note: null },
		{ region: "eu", product: "a", qty: 4, note: "y" },
	];

	it("aggregates by one key, in first-appearance order", () => {
		const out = df(sales).group_by("region").agg({ qty: "sum" });
		expect(out.columns).toEqual(["region", "qty"]);
		expect(out.to_dicts()).toEqual([
			{ region: "eu", qty: 9 },
			{ region: "us", qty: 5 },
		]);
	});

	it("groups by several keys at once", () => {
		const out = df(sales).group_by("region", "product").agg({ qty: "sum" });
		expect(out.to_dicts()).toEqual([
			{ region: "eu", product: "a", qty: 6 },
			{ region: "eu", product: "b", qty: 3 },
			{ region: "us", product: "a", qty: 5 },
		]);
		expect(df(sales).group_by(["region", "product"]).agg({ qty: "sum" }).len()).toBe(3);
	});

	it("counts rows per group with len()", () => {
		expect(df(sales).group_by("region").len().to_dicts()).toEqual([
			{ region: "eu", len: 3 },
			{ region: "us", len: 1 },
		]);
	});

	it("skips nulls in every aggregate and keeps them out of the count", () => {
		const out = df(sales)
			.group_by("region")
			.agg({ note: ["count", "len", "n_unique", "first"] });
		expect(out.to_dicts()).toEqual([
			{ region: "eu", note_count: 2, note_len: 3, note_n_unique: 3, note_first: null },
			{ region: "us", note_count: 0, note_len: 1, note_n_unique: 1, note_first: null },
		]);
	});

	it("returns 0 for a sum over only nulls and null for the other numeric aggregates", () => {
		const rows = [
			{ g: "a", v: null },
			{ g: "a", v: null },
		];
		const out = df(rows)
			.group_by("g")
			.agg({ v: ["sum", "mean", "median", "std", "min", "max"] });
		expect(out.to_dicts()).toEqual([
			{ g: "a", v_sum: 0, v_mean: null, v_median: null, v_std: null, v_min: null, v_max: null },
		]);
	});

	it("computes each aggregate over the non-null values only", () => {
		const rows = [{ v: 1 }, { v: null }, { v: 3 }, { v: 5 }, {}];
		const out = df(rows.map((r) => ({ g: "a", ...r })))
			.group_by("g")
			.agg({
				v: ["sum", "mean", "median", "std", "min", "max", "count", "len"],
			});
		const got = out.to_dicts()[0];
		expect(got.v_sum).toBe(9);
		expect(got.v_mean).toBe(3);
		expect(got.v_median).toBe(3);
		expect(got.v_std).toBeCloseTo(2, 10);
		expect(got.v_min).toBe(1);
		expect(got.v_max).toBe(5);
		expect(got.v_count).toBe(3);
		expect(got.v_len).toBe(5);
	});

	it("names the output column after the source column for a single aggregate", () => {
		expect(df(sales).group_by("region").agg({ qty: "mean" }).columns).toEqual(["region", "qty"]);
	});

	it("takes a custom function over the group's values and rows", () => {
		const out = df(sales)
			.group_by("region")
			.agg({ qty: (values: number[], rows: Row[]) => values.length + rows.length });
		expect(out.get_column("qty")).toEqual([6, 2]);
	});

	it("orders min and max on strings as well as numbers", () => {
		expect(AGGS.min(["b", "a", null])).toBe("a");
		expect(AGGS.max(["b", "a", null])).toBe("b");
		expect(AGGS.min([])).toBeNull();
	});

	it("is aliased as groupby", () => {
		expect(DataFrame.prototype.groupby).toBe(DataFrame.prototype.group_by);
		expect(df(sales).groupby("region").agg({ qty: "sum" }).len()).toBe(2);
	});
});

describe("join", () => {
	const left = df([
		{ chain: "eth", tvl: 46 },
		{ chain: "bsc", tvl: 5 },
		{ chain: "sol", tvl: 5 },
	]);
	const right = df([
		{ chain: "eth", id: 1 },
		{ chain: "bsc", id: 56 },
		{ chain: "arb", id: 42161 },
	]);

	it("inner joins, dropping both sides' unmatched rows", () => {
		const out = left.join(right, { on: "chain" });
		expect(out.columns).toEqual(["chain", "tvl", "id"]);
		expect(out.to_dicts()).toEqual([
			{ chain: "eth", tvl: 46, id: 1 },
			{ chain: "bsc", tvl: 5, id: 56 },
		]);
	});

	it("left joins, keeping the unmatched left rows with nulls", () => {
		const out = left.join(right, { on: "chain", how: "left" });
		expect(out.len()).toBe(3);
		expect(out.to_dicts()[2]).toEqual({ chain: "sol", tvl: 5, id: null });
	});

	it("outer joins, keeping the unmatched right rows and their key", () => {
		const out = left.join(right, { on: "chain", how: "outer" });
		expect(out.len()).toBe(4);
		expect(out.to_dicts()[3]).toEqual({ chain: "arb", tvl: null, id: 42161 });
	});

	it("joins on differently named columns, keeping the left name", () => {
		const named = df([{ name: "eth", id: 1 }]);
		const out = left.join(named, { left_on: "chain", right_on: "name" });
		expect(out.columns).toEqual(["chain", "tvl", "id"]);
		expect(out.to_dicts()).toEqual([{ chain: "eth", tvl: 46, id: 1 }]);
	});

	it("suffixes a colliding non-key column", () => {
		const other = df([{ chain: "eth", tvl: 99 }]);
		expect(left.join(other, { on: "chain" }).columns).toEqual(["chain", "tvl", "tvl_right"]);
		expect(left.join(other, { on: "chain", suffix: "_b" }).columns).toEqual(["chain", "tvl", "tvl_b"]);
	});

	it("emits one row per match when the right side has duplicates", () => {
		const dupes = df([
			{ chain: "eth", id: 1 },
			{ chain: "eth", id: 2 },
		]);
		expect(left.join(dupes, { on: "chain" }).get_column("id")).toEqual([1, 2]);
	});

	it("joins on several columns", () => {
		const a = df([{ g: "x", d: 1, v: 10 }]);
		const b = df([
			{ g: "x", d: 1, w: 20 },
			{ g: "x", d: 2, w: 30 },
		]);
		expect(a.join(b, { on: ["g", "d"] }).to_dicts()).toEqual([{ g: "x", d: 1, v: 10, w: 20 }]);
	});
});

describe("pivot", () => {
	const long = [
		{ date: "d1", chain: "eth", tvl: 1 },
		{ date: "d1", chain: "bsc", tvl: 2 },
		{ date: "d2", chain: "eth", tvl: 3 },
	];

	it("turns long into wide, filling missing combinations with null", () => {
		const out = df(long).pivot("chain", { index: "date", values: "tvl" });
		expect(out.columns).toEqual(["date", "eth", "bsc"]);
		expect(out.to_dicts()).toEqual([
			{ date: "d1", eth: 1, bsc: 2 },
			{ date: "d2", eth: 3, bsc: null },
		]);
	});

	it("aggregates collisions with the named function", () => {
		const dupes = [...long, { date: "d1", chain: "eth", tvl: 9 }];
		expect(
			df(dupes).pivot("chain", { index: "date", values: "tvl", aggregate_function: "sum" }).to_dicts()[0],
		).toEqual({ date: "d1", eth: 10, bsc: 2 });
	});

	it("accepts the whole call as one object", () => {
		expect(df(long).pivot({ on: "chain", index: "date", values: "tvl" }).columns).toEqual(["date", "eth", "bsc"]);
	});
});

describe("describe", () => {
	it("summarises mixed types, one row per statistic", () => {
		const out = df(CHAINS).describe();
		expect(out.columns).toEqual(["statistic", "name", "symbol", "tvl", "volume"]);
		expect(out.get_column("statistic")).toEqual([
			"count",
			"null_count",
			"mean",
			"std",
			"min",
			"25%",
			"50%",
			"75%",
			"max",
		]);
		const byStat = Object.fromEntries(out.to_dicts().map((r: Row) => [r.statistic, r]));
		expect(byStat.count.symbol).toBe(3);
		expect(byStat.null_count.symbol).toBe(1);
		// Non-numeric columns get no mean or quantiles, but min and max still order.
		expect(byStat.mean.name).toBeNull();
		expect(byStat["50%"].name).toBeNull();
		expect(byStat.min.name).toBe("BSC");
		expect(byStat.max.name).toBe("Solana");
		expect(byStat.mean.tvl).toBeCloseTo(15.325, 10);
		expect(byStat["50%"].tvl).toBeCloseTo(5.15, 10);
		expect(byStat.min.tvl).toBe(5);
		expect(byStat.max.tvl).toBe(46);
		// A null is excluded from the numeric summary but counted.
		expect(byStat.count.volume).toBe(3);
		expect(byStat.mean.volume).toBeCloseTo((2305 + 2978 + 6267) / 3, 10);
	});

	it("returns a frame, so it prints and chains like any other", () => {
		expect(df(CHAINS).describe()).toBeInstanceOf(DataFrame);
	});
});

describe("output", () => {
	it("hands back plain arrays and objects, copied", () => {
		const frame = df(CHAINS);
		const rows = frame.to_dicts();
		rows[0].name = "mutated";
		expect(frame.get_column("name")[0]).toBe("Ethereum");
		expect(frame.to_columns().tvl).toEqual([46, 5.2, 5.1, 5]);
		expect(DataFrame.prototype.to_records).toBe(DataFrame.prototype.to_dicts);
	});

	it("renders a polars box table with a shape line, names, and dtypes", () => {
		const out = String(df([{ name: "eth", tvl: 46 }]));
		expect(out.split("\n")).toEqual([
			"shape: (1, 2)",
			"┌──────┬─────┐",
			"│ name ┆ tvl │",
			"│ ---  ┆ --- │",
			"│ str  ┆ i64 │",
			"╞══════╪═════╡",
			"│ eth  ┆ 46  │",
			"└──────┴─────┘",
		]);
	});

	it("elides the middle past ten rows", () => {
		const out = String(df(Array.from({ length: 30 }, (_, i) => ({ i }))));
		const body = out.split("\n").slice(6, -1);
		expect(body).toHaveLength(11);
		expect(body[5]).toContain("…");
		expect(body[0]).toContain("0");
		expect(body[10]).toContain("29");
	});

	it("prints null as null, not as a blank or a zero", () => {
		expect(String(df([{ v: null }]))).toContain("null");
	});

	// A column of 16.89861185106625 is a column nobody can scan, and the width it forces pushes the
	// rest of the table sideways. Rounding is display-only, so the stored value stays exact.
	it("rounds a float for display without touching what it stores", () => {
		const frame = df([{ chg: 16.89861185106625, tvl: 46, tiny: 1e-9 }]);
		const out = String(frame);
		expect(out).toContain("16.898612");
		expect(out).not.toContain("16.89861185106625");
		// An integer keeps its exact spelling, and a value under the sixth decimal is printed whole
		// rather than rounded away to a zero that would read as "no change".
		expect(out).toContain("46");
		expect(out).toContain("1e-9");
		expect(frame.to_dicts()).toEqual([{ chg: 16.89861185106625, tvl: 46, tiny: 1e-9 }]);
		expect(frame.get_column("chg")[0]).toBe(16.89861185106625);
	});

	it("renders through the REPL's inspector", () => {
		const frame = df([{ a: 1 }]);
		expect(inspect(frame)).toBe(frame.toString());
	});

	it("reports an empty frame without a box", () => {
		expect(String(df([]))).toBe("shape: (0, 0)");
		expect(df([]).shape).toEqual([0, 0]);
	});
});

describe("bad arguments throw TypeError", () => {
	it("rejects a non-array of rows", () => {
		expect(() => df("nope")).toThrow(TypeError);
		expect(() => df(null)).toThrow(/expected an array of row objects, got null/);
		expect(() => df([1, 2])).toThrow(/row 0 is not an object \(number\)/);
	});

	it("rejects an unknown column name, naming the columns it has", () => {
		expect(() => df(CHAINS).select("nope")).toThrow(/no column named "nope" \(have name, symbol, tvl, volume\)/);
		expect(() => df(CHAINS).drop("nope")).toThrow(TypeError);
		expect(() => df(CHAINS).rename({ nope: "x" })).toThrow(TypeError);
		expect(() => df(CHAINS).sort("nope")).toThrow(TypeError);
		expect(() => df(CHAINS).get_column("nope")).toThrow(TypeError);
		expect(() => df(CHAINS).group_by("nope")).toThrow(TypeError);
		expect(() => df(CHAINS).drop_nulls("nope")).toThrow(TypeError);
	});

	it("rejects a predicate or expression of the wrong type", () => {
		expect(() => df(CHAINS).filter("r.tvl > 1")).toThrow(/expected a predicate function, got string/);
		expect(() => df(CHAINS).with_columns([])).toThrow(TypeError);
		expect(() => df(CHAINS).with_columns(null)).toThrow(/expected an object of \{name -> fn or value\}/);
	});

	it("rejects an empty or malformed selection", () => {
		expect(() => df(CHAINS).select()).toThrow(/expected at least one column name/);
		expect(() => df(CHAINS).group_by()).toThrow(/expected at least one column name/);
		expect(() => df(CHAINS).sort(42)).toThrow(/expected a column name, an array of names, or a key function/);
		expect(() => df(CHAINS).slice("1")).toThrow(TypeError);
	});

	it("rejects an unknown aggregate, listing the ones it knows", () => {
		expect(() => df(CHAINS).group_by("symbol").agg({ tvl: "avg" })).toThrow(/unknown aggregate "avg"/);
		expect(() => df(CHAINS).group_by("symbol").agg({ nope: "sum" })).toThrow(TypeError);
		expect(() => df(CHAINS).group_by("symbol").agg("sum")).toThrow(/expected an object of \{column -> aggregate\}/);
	});

	it("refuses to coerce a non-number in a numeric aggregate", () => {
		const rows = [{ g: "a", v: "3" }];
		expect(() => df(rows).group_by("g").agg({ v: "sum" })).toThrow(
			/column "v" holds a string \(3\), expected number/,
		);
		expect(() => df(rows).group_by("g").agg({ v: "mean" })).toThrow(TypeError);
		// min and max order anything, so they still work on that column.
		expect(df(rows).group_by("g").agg({ v: "max" }).get_column("v")).toEqual(["3"]);
	});

	it("rejects a malformed join", () => {
		const other = df([{ chain: "eth" }]);
		expect(() => df(CHAINS).join(other, {})).toThrow(/expected \{on\} or a matching \{left_on, right_on\}/);
		expect(() => df(CHAINS).join([{ chain: "eth" }], { on: "name" })).toThrow(/expected a DataFrame, got object/);
		expect(() => df(CHAINS).join(other, { on: "name", how: "sideways" })).toThrow(/unknown how "sideways"/);
		expect(() => df(CHAINS).join(other, { left_on: ["name"], right_on: ["chain", "chain"] })).toThrow(TypeError);
	});

	it("rejects a malformed pivot or from_columns", () => {
		expect(() => df(CHAINS).pivot("name", { values: "tvl" })).toThrow(/expected \{index\} naming at least one/);
		expect(() => df.from_columns({ a: 1 })).toThrow(/column "a" is not an array/);
		expect(() => df.from_columns({ a: [1, 2], b: [1] })).toThrow(/column "b" has 1 values, expected 2/);
		expect(() => df.from_columns(null)).toThrow(TypeError);
		expect(() => df.concat("nope")).toThrow(TypeError);
		expect(() => df.concat([[{ a: 1 }]])).toThrow(/every element must be a DataFrame/);
	});
});

describe("columnar storage", () => {
	it("backs a homogeneous numeric column with the narrowest typed array that holds it", () => {
		expect(pack([1, 2, 3]).values).toBeInstanceOf(Int32Array);
		expect(pack([1, 2.5]).values).toBeInstanceOf(Float64Array);
		// TVL-sized integers overflow Int32, so they widen rather than wrap.
		expect(pack([46187428786, 1]).values).toBeInstanceOf(Float64Array);
		expect(pack([46187428786, 1]).get(0)).toBe(46187428786);
		expect(pack([true, false]).values).toBeInstanceOf(Uint8Array);
		expect(pack([new Date(1000)]).values).toBeInstanceOf(Float64Array);
	});

	it("falls back to a plain array for strings, objects, bigints and mixed types", () => {
		expect(Array.isArray(pack(["a", "b"]).values)).toBe(true);
		expect(Array.isArray(pack([{ a: 1 }]).values)).toBe(true);
		expect(Array.isArray(pack([1, "a"]).values)).toBe(true);
		// A bigint would lose its exact value in a Float64Array, so it stays boxed.
		const big = pack([2n ** 70n]);
		expect(Array.isArray(big.values)).toBe(true);
		expect(big.get(0)).toBe(2n ** 70n);
		expect(big.dtype).toBe("i64");
	});

	it("tracks nulls in a separate validity mask, allocated only when one exists", () => {
		expect(pack([1, 2]).valid).toBeNull();
		const col = pack([1, null, 3]);
		expect(col.valid).toBeInstanceOf(Uint8Array);
		expect([...col.valid]).toEqual([1, 0, 1]);
		// The typed slot under a null holds 0; only the mask decides, so null never reads as 0.
		expect(col.values[1]).toBe(0);
		expect(col.get(1)).toBeNull();
		expect(col.toArray()).toEqual([1, null, 3]);
	});

	it("round-trips dates and booleans through their typed stores", () => {
		const frame = df([
			{ at: new Date("2026-08-20T00:00:00.000Z"), ok: true },
			{ at: new Date("2026-08-21T00:00:00.000Z"), ok: false },
		]);
		expect(frame.dtypes).toEqual({ at: "date", ok: "bool" });
		expect(frame.get_column("at")[1]).toEqual(new Date("2026-08-21T00:00:00.000Z"));
		expect(frame.get_column("ok")).toEqual([true, false]);
		expect(frame.sort("at", { descending: true }).get_column("ok")).toEqual([false, true]);
	});

	it("shares column objects across a projection instead of copying values", () => {
		const frame = df(CHAINS);
		const projected = frame.select("tvl", "name");
		expect(projected._data.get("tvl")).toBe(frame._data.get("tvl"));
		expect(frame.rename({ tvl: "value" })._data.get("value")).toBe(frame._data.get("tvl"));
		expect(frame.drop("name")._data.get("tvl")).toBe(frame._data.get("tvl"));
	});

	it("exposes Column so the next pass can compute over the raw store", () => {
		const frame = df(CHAINS);
		const col = frame._data.get("tvl");
		expect(col).toBeInstanceOf(Column);
		expect(col.length).toBe(4);
		expect(col.take([3, 0]).toArray()).toEqual([5, 46]);
		expect(col.slice(1, 3).toArray()).toEqual([5.2, 5.1]);
		// A negative index is the join's "no such row", and lands as a null.
		expect(col.take([0, -1]).toArray()).toEqual([46, null]);
	});

	it("keeps composite group keys apart across the column boundary", () => {
		const rows = [
			{ a: "ab", b: "c" },
			{ a: "a", b: "bc" },
		];
		expect(df(rows).unique().len()).toBe(2);
		expect(df(rows).group_by("a", "b").len().len()).toBe(2);
	});

	it("builds from typed arrays as readily as from plain ones", () => {
		const frame = df.from_columns({ t: new Float64Array([1, 2, 3]), n: [1, 2, 3] });
		expect(frame.shape).toEqual([3, 2]);
		expect(frame.get_column("t")).toEqual([1, 2, 3]);
	});

	it("hands closures one reused row view, so a kept reference has to be spread", () => {
		const seen: Row[] = [];
		const copies: Row[] = [];
		df(CHAINS).filter((r: Row) => {
			seen.push(r);
			copies.push({ ...r });
			return true;
		});
		// Every stashed reference is the same object; the spread copies are distinct.
		expect(seen[0]).toBe(seen[3]);
		expect(copies[0].name).toBe("Ethereum");
		expect(copies[3].name).toBe("Base");
	});

	it("stays correct over a frame far larger than the display", () => {
		const n = 100_000;
		const rows = Array.from({ length: n }, (_, i) => ({ g: i % 4, v: i, tag: `t${i % 7}` }));
		const frame = df(rows);
		expect(frame._data.get("v").values).toBeInstanceOf(Int32Array);
		const cutoff = n - 10;
		expect(frame.filter((r: Row) => (r.v as number) >= cutoff).len()).toBe(10);
		expect(frame.sort("v", { descending: true }).get_column("v")[0]).toBe(n - 1);
		const grouped = frame.group_by("g").agg({ v: "sum" });
		expect(grouped.len()).toBe(4);
		expect(grouped.get_column("v").reduce((a: number, b: number) => a + b, 0)).toBe((n * (n - 1)) / 2);
		expect(frame.unique("tag").len()).toBe(7);
	});
});
