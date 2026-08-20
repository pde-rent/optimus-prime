/**
 * A dataframe over columnar storage, named the way polars is named.
 *
 * WHY not a library: `nodejs-polars` ships a 99 MB native binary per platform against a 34 MB
 * node_modules, and arquero's verbs are dplyr-shaped (`derive`, `rollup`, `orderby`) while its
 * table expressions reject closures - `dt.filter(d => d.tvl > threshold)` throws
 * `Invalid variable reference` on the captured variable. That is the first line a model writes.
 * Here every predicate and every expression is a plain JS closure, capturing whatever it likes.
 *
 * Storage is arquero-shaped: one `Column` per name, backed by a `Float64Array`, `Int32Array` or
 * `Uint8Array` when the column is homogeneously numeric, boolean or a date, and by a plain
 * `Array` for strings, objects and mixed types. Rows are materialised only at the boundary -
 * `to_dicts`, `toString`, and the reused row view handed to a closure. `select`, `drop` and
 * `rename` share column objects outright; `filter`, `sort`, `unique` and `slice` are index
 * permutations over typed arrays rather than arrays of objects.
 *
 * Nulls live in a separate `Uint8Array` validity mask, `null` when a column has none, so a `null`
 * is never `0` and never `NaN` no matter what the value slot happens to hold.
 *
 * ponytail: no lazy plan, no query optimiser, no Arrow interop. Frames here are under ~1M rows;
 * the upgrade path past that is nodejs-polars, not a planner grown in this file.
 */

/** An absent key and an explicit `null` are the same missing value. */
const isNull = (v) => v === null || v === undefined;

const NUMERIC = new Set(["i64", "f64"]);
const MAX_CELL = 24;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const DESCRIBE_STATS = ["count", "null_count", "mean", "std", "min", "25%", "50%", "75%", "max"];

function kindOf(v) {
	if (isNull(v)) return null;
	switch (typeof v) {
		case "number":
			return Number.isInteger(v) ? "i64" : "f64";
		case "bigint":
			return "i64";
		case "boolean":
			return "bool";
		case "string":
			return "str";
		default:
			return v instanceof Date ? "date" : "obj";
	}
}

/** Widen over a column. Ints beside floats are one numeric column; anything else mixed is `obj`. */
function dtypeOf(values) {
	let dtype = null;
	for (const v of values) {
		const k = kindOf(v);
		if (k === null || k === dtype) continue;
		if (dtype === null) dtype = k;
		else dtype = NUMERIC.has(dtype) && NUMERIC.has(k) ? "f64" : "obj";
		if (dtype === "obj") break;
	}
	return dtype ?? "null";
}

/** Ordering for sort, min and max. Dates compare by instant; everything else by `<`. */
function cmp(a, b) {
	const x = a instanceof Date ? a.getTime() : a;
	const y = b instanceof Date ? b.getTime() : b;
	return x < y ? -1 : x > y ? 1 : 0;
}

/** A key that keeps types apart, so `1`, `"1"`, `true` and `null` never collide in a group. */
function keyOf(v) {
	if (isNull(v)) return " ";
	const t = typeof v;
	if (t === "string") return `s${v}`;
	if (t === "object") return v instanceof Date ? `d${v.getTime()}` : `o${JSON.stringify(v)}`;
	return `${t[0]}${String(v)}`;
}

/** The group a null belongs to. A sentinel, so it cannot be a value the data also holds. */
const NULL_KEY = Symbol("null");

/** Accept both `f("a", "b")` and `f(["a", "b"])`, the way polars accepts both. */
const flatten = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);

/** Push into a `Map` of buckets, creating the bucket on first sight. */
function bucket(map, key, value) {
	const hit = map.get(key);
	if (hit) hit.push(value);
	else map.set(key, [value]);
}

/**
 * One column: a value store, a dtype, and a validity mask that is `null` when nothing is missing.
 *
 * Typed stores hold `0` where a value is absent, so nothing here may read `values[i]` without
 * consulting `valid[i]` first. Columns are never mutated after packing, which is what lets
 * `select`, `drop` and `rename` hand the same object to a new frame instead of copying.
 */
export class Column {
	/** @param {ArrayLike<any>} values @param {string} dtype @param {Uint8Array | null} valid */
	constructor(values, dtype, valid) {
		this.values = values;
		this.dtype = dtype;
		this.valid = valid ?? null;
		this.typed = ArrayBuffer.isView(values);
	}

	get length() {
		return this.values.length;
	}

	/** The boxed value, re-widened from its typed store. */
	get(i) {
		if (this.valid !== null && this.valid[i] === 0) return null;
		const v = this.values[i];
		if (!this.typed) return v;
		if (this.dtype === "date") return new Date(v);
		if (this.dtype === "bool") return v === 1;
		return v;
	}

	/** A group key read straight off the store, so grouping never boxes a Date. */
	keyAt(i) {
		if (this.valid !== null && this.valid[i] === 0) return " ";
		return this.typed ? String(this.values[i]) : keyOf(this.values[i]);
	}

	/**
	 * A reader closed over this column's storage.
	 *
	 * WHY: `get` re-tests dtype and validity on every call, and a row loop over 100k rows pays for
	 * those branches 100k times. Binding them once hands the JIT one monomorphic function.
	 */
	reader() {
		const { values, valid, typed, dtype } = this;
		if (typed && dtype === "date") {
			return valid === null ? (i) => new Date(values[i]) : (i) => (valid[i] === 1 ? new Date(values[i]) : null);
		}
		if (typed && dtype === "bool") {
			return valid === null ? (i) => values[i] === 1 : (i) => (valid[i] === 1 ? values[i] === 1 : null);
		}
		return valid === null ? (i) => values[i] : (i) => (valid[i] === 1 ? values[i] : null);
	}

	/** A key reader, same bargain as `reader`. */
	keyReader() {
		const { values, valid, typed } = this;
		const raw = typed ? (i) => String(values[i]) : (i) => keyOf(values[i]);
		return valid === null ? raw : (i) => (valid[i] === 1 ? raw(i) : " ");
	}

	/** Gather by index. A negative index means "no such row" and lands as a null. */
	take(idx) {
		const n = idx.length;
		const { values: src, valid: mask, typed } = this;
		let gaps = false;
		for (let k = 0; k < n; k++) {
			if (idx[k] < 0) {
				gaps = true;
				break;
			}
		}
		const out = typed ? new src.constructor(n) : new Array(n);
		// The common gather is a straight copy; only a mask or a gap costs the extra branches.
		if (mask === null && !gaps) {
			for (let k = 0; k < n; k++) out[k] = src[idx[k]];
			return new Column(out, this.dtype, null);
		}
		const valid = new Uint8Array(n);
		for (let k = 0; k < n; k++) {
			const i = idx[k];
			const present = i >= 0 && (mask === null || mask[i] === 1);
			valid[k] = present ? 1 : 0;
			out[k] = present ? src[i] : typed ? 0 : null;
		}
		return new Column(out, this.dtype, valid);
	}

	/** A contiguous run, which a typed store copies in one go. */
	slice(from, to) {
		return new Column(this.values.slice(from, to), this.dtype, this.valid?.slice(from, to) ?? null);
	}

	/** @returns {any[]} Boxed values with nulls in place - the frame's boundary with plain JS. */
	toArray() {
		const read = this.reader();
		const out = new Array(this.values.length);
		for (let i = 0; i < out.length; i++) out[i] = read(i);
		return out;
	}
}

/** Choose a typed store, or `null` to say "this one has to stay a plain Array". */
function storeFor(dtype, values, valid) {
	const n = values.length;
	const present = (i) => valid === null || valid[i] === 1;
	if (dtype === "bool") {
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i++) out[i] = present(i) && values[i] ? 1 : 0;
		return out;
	}
	if (dtype === "date") {
		const out = new Float64Array(n);
		for (let i = 0; i < n; i++) out[i] = present(i) ? values[i].getTime() : 0;
		return out;
	}
	if (!NUMERIC.has(dtype)) return null;
	// A bigint column keeps its exact values in a plain Array rather than losing them to a float.
	let int32 = dtype === "i64";
	for (let i = 0; i < n; i++) {
		if (!present(i)) continue;
		const v = values[i];
		if (typeof v !== "number") return null;
		if (int32 && (v < INT32_MIN || v > INT32_MAX)) int32 = false;
	}
	const out = int32 ? new Int32Array(n) : new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = present(i) ? values[i] : 0;
	return out;
}

/** Build a column from a plain array, choosing its storage and lifting its nulls into a mask. */
export function pack(values) {
	const n = values.length;
	// One pass for both questions the storage decision needs: which dtype, and are any missing.
	let dtype = null;
	let missing = false;
	for (let i = 0; i < n; i++) {
		const k = kindOf(values[i]);
		if (k === null) {
			missing = true;
			continue;
		}
		if (dtype === null || dtype === k) dtype = k;
		else if (dtype !== "obj") dtype = NUMERIC.has(dtype) && NUMERIC.has(k) ? "f64" : "obj";
	}
	dtype = dtype ?? "null";
	let valid = null;
	if (missing) {
		valid = new Uint8Array(n);
		for (let i = 0; i < n; i++) valid[i] = isNull(values[i]) ? 0 : 1;
	}
	const store = storeFor(dtype, values, valid);
	if (store !== null) return new Column(store, dtype, valid);
	const plain = new Array(n);
	for (let i = 0; i < n; i++) plain[i] = values[i] ?? null;
	return new Column(plain, dtype, valid);
}

/** Numeric aggregates refuse to coerce: a `"3"` in a sum is a data bug worth surfacing. */
function numbers(values, where, column) {
	const out = [];
	for (const v of values) {
		if (isNull(v)) continue;
		if (typeof v !== "number") {
			throw new TypeError(`${where}: column "${column}" holds a ${typeof v} (${String(v)}), expected number`);
		}
		out.push(v);
	}
	return out;
}

function quantile(sorted, q) {
	if (sorted.length === 0) return null;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const add = (a, b) => a + b;

/**
 * The aggregate names `agg` accepts. Every one skips nulls; `sum` of nothing is `0` (as in
 * polars), every other numeric aggregate of nothing is `null`. `count` is the non-null count,
 * `len` the row count including nulls, and `n_unique` counts `null` as one distinct value.
 */
const AGGS = {
	sum: (v, w, c) => numbers(v, w, c).reduce(add, 0),
	mean: (v, w, c) => {
		const n = numbers(v, w, c);
		return n.length ? n.reduce(add, 0) / n.length : null;
	},
	median: (v, w, c) =>
		quantile(
			numbers(v, w, c).sort((a, b) => a - b),
			0.5,
		),
	std: (v, w, c) => {
		const n = numbers(v, w, c);
		if (n.length < 2) return null;
		const mu = n.reduce(add, 0) / n.length;
		return Math.sqrt(n.reduce((a, b) => a + (b - mu) ** 2, 0) / (n.length - 1));
	},
	min: (v) => v.reduce((a, b) => (isNull(b) ? a : isNull(a) || cmp(b, a) < 0 ? b : a), null),
	max: (v) => v.reduce((a, b) => (isNull(b) ? a : isNull(a) || cmp(b, a) > 0 ? b : a), null),
	count: (v) => v.reduce((a, b) => a + (isNull(b) ? 0 : 1), 0),
	len: (v) => v.length,
	first: (v) => (v.length ? v[0] : null),
	last: (v) => (v.length ? v[v.length - 1] : null),
	n_unique: (v) => new Set(v.map(keyOf)).size,
};

function applyAgg(how, values, rows, where, column) {
	if (typeof how === "function") return how(values, rows) ?? null;
	const fn = AGGS[how];
	if (!fn) {
		const known = Object.keys(AGGS).join(", ");
		throw new TypeError(
			`${where}: unknown aggregate "${String(how)}" for column "${column}" (${known}, or a function)`,
		);
	}
	return fn(values, where, column) ?? null;
}

export class DataFrame {
	/**
	 * Columns must already be packed - use `df(rows)`, which is what does the packing.
	 *
	 * @param {string[]} columns @param {Map<string, Column>} data @param {number} height
	 */
	constructor(columns, data, height) {
		this._columns = columns;
		this._data = data;
		this._height = height;
	}

	get columns() {
		return [...this._columns];
	}
	get shape() {
		return [this._height, this._columns.length];
	}
	get height() {
		return this._height;
	}
	get width() {
		return this._columns.length;
	}
	/** @returns {Record<string, string>} column -> `i64` | `f64` | `str` | `bool` | `date` | `obj` | `null`. */
	get dtypes() {
		return Object.fromEntries(this._columns.map((c) => [c, this._data.get(c).dtype]));
	}
	len() {
		return this._height;
	}

	/** @throws {TypeError} When a name is not a column of this frame. */
	_have(name, where) {
		if (typeof name !== "string" || !this._data.has(name)) {
			throw new TypeError(`${where}: no column named ${JSON.stringify(name)} (have ${this._columns.join(", ")})`);
		}
		return name;
	}

	/** `subset` defaults to every column, the way polars' `unique` and `drop_nulls` do. */
	_subset(subset, where) {
		return subset === undefined ? this._columns : flatten([subset]).map((c) => this._have(c, where));
	}

	/**
	 * One row object, reused for every row and backed by getters onto the columns.
	 *
	 * WHY reused: a closure over 100k rows would otherwise allocate 100k objects that all die
	 * immediately. The cost is that the view is only valid until the next `seek` - a closure that
	 * stashes the row away gets the last one, so spread it (`{ ...r }`) to keep a copy.
	 */
	_view() {
		let i = 0;
		const row = {};
		for (const name of this._columns) {
			const read = this._data.get(name).reader();
			Object.defineProperty(row, name, { get: () => read(i), enumerable: true, configurable: true });
		}
		return {
			row,
			seek(k) {
				i = k;
			},
		};
	}

	/**
	 * A composite-key reader, with the column lookups hoisted out of the row loop.
	 *
	 * The separator keeps `["ab", "c"]` and `["a", "bc"]` apart; a single key column needs none.
	 */
	_keyer(names) {
		if (names.length === 1) {
			const { values, valid, dtype } = this._data.get(names[0]);
			// One column carries one dtype, so its raw slot is already an unambiguous Map key -
			// a number stays a number and never has to become a string.
			if (dtype !== "obj") {
				return valid === null ? (i) => values[i] : (i) => (valid[i] === 1 ? values[i] : NULL_KEY);
			}
		}
		const readers = names.map((n) => this._data.get(n).keyReader());
		if (readers.length === 1) return readers[0];
		return (i) => {
			let out = "";
			for (const read of readers) out += `\u0001${read(i)}`;
			return out;
		};
	}

	_take(idx) {
		const data = new Map();
		for (const c of this._columns) data.set(c, this._data.get(c).take(idx));
		return new DataFrame([...this._columns], data, idx.length);
	}

	_pick(names) {
		// Columns are immutable, so a projection shares them rather than copying any values.
		return new DataFrame([...names], new Map(names.map((c) => [c, this._data.get(c)])), this._height);
	}

	select(...cols) {
		const names = flatten(cols);
		if (names.length === 0) throw new TypeError("df.select: expected at least one column name");
		for (const n of names) this._have(n, "df.select");
		return this._pick(names);
	}

	drop(...cols) {
		const gone = new Set(flatten(cols).map((n) => this._have(n, "df.drop")));
		return this._pick(this._columns.filter((c) => !gone.has(c)));
	}

	/** @param {Record<string, string>} map Old name -> new name; column order is kept. */
	rename(map) {
		if (!map || typeof map !== "object" || Array.isArray(map)) {
			throw new TypeError(`df.rename: expected an object of old -> new names, got ${typeof map}`);
		}
		for (const from of Object.keys(map)) this._have(from, "df.rename");
		const to = (c) => map[c] ?? c;
		return new DataFrame(
			this._columns.map(to),
			new Map(this._columns.map((c) => [to(c), this._data.get(c)])),
			this._height,
		);
	}

	/** @param {(row: Record<string, any>, i: number) => any} fn A plain closure, free to capture. */
	filter(fn) {
		if (typeof fn !== "function") {
			throw new TypeError(`df.filter: expected a predicate function, got ${fn === null ? "null" : typeof fn}`);
		}
		const { row, seek } = this._view();
		const idx = new Uint32Array(this._height);
		let n = 0;
		for (let i = 0; i < this._height; i++) {
			seek(i);
			if (fn(row, i)) idx[n++] = i;
		}
		return this._take(idx.subarray(0, n));
	}

	/** Replace or append one already-packed column. */
	_set(name, column) {
		const data = new Map(this._data);
		data.set(name, column);
		return new DataFrame(this._data.has(name) ? [...this._columns] : [...this._columns, name], data, column.length);
	}

	/**
	 * Add or replace columns. Entries are applied in order, so a later one sees what an earlier
	 * one just made (pandas `assign`); polars evaluates its expressions against the input frame
	 * instead, which only differs when one entry overwrites a column another entry reads.
	 *
	 * @param {Record<string, ((row: Record<string, any>, i: number) => any) | any>} spec
	 */
	with_columns(spec) {
		if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
			throw new TypeError(`df.with_columns: expected an object of {name -> fn or value}, got ${typeof spec}`);
		}
		let out = this;
		for (const [name, how] of Object.entries(spec)) {
			const values = new Array(this._height);
			if (typeof how === "function") {
				// Rebuilt each entry, so the next expression can read the column just added.
				const { row, seek } = out._view();
				for (let i = 0; i < this._height; i++) {
					seek(i);
					values[i] = how(row, i) ?? null;
				}
			} else {
				values.fill(how ?? null);
			}
			out = out._set(name, pack(values));
		}
		return out;
	}

	/**
	 * Stable sort. Nulls go last in both directions unless `{nulls_last: false}`.
	 *
	 * @param {string | string[] | ((row: Record<string, any>) => any)} by
	 * @param {{descending?: boolean | boolean[], ascending?: boolean | boolean[], nulls_last?: boolean}} [opts]
	 */
	sort(by, opts = {}) {
		const keys = typeof by === "function" || typeof by === "string" ? [by] : by;
		if (!Array.isArray(keys) || keys.length === 0) {
			throw new TypeError(`df.sort: expected a column name, an array of names, or a key function, got ${typeof by}`);
		}
		// Sort keys are read once into raw stores rather than per comparison; a column key needs no
		// copy at all, since its store is already the array the comparator wants.
		const sortKeys = keys.map((k) => {
			if (typeof k !== "function") {
				const col = this._data.get(this._have(k, "df.sort"));
				return { values: col.values, valid: col.valid, typed: col.typed };
			}
			const { row, seek } = this._view();
			const values = new Array(this._height);
			for (let i = 0; i < this._height; i++) {
				seek(i);
				values[i] = k(row, i) ?? null;
			}
			return { values, valid: null, typed: false };
		});
		const asc = opts.ascending;
		const desc = asc === undefined ? (opts.descending ?? false) : Array.isArray(asc) ? asc.map((a) => !a) : !asc;
		const dir = (k) => ((Array.isArray(desc) ? desc[k] : desc) ? -1 : 1);
		const nullDir = (opts.nulls_last ?? true) ? 1 : -1;
		const idx = Array.from({ length: this._height }, (_, i) => i);
		// Negate the comparison rather than reversing the array, so ties keep their input order.
		// One key over a typed store with nothing missing is the common case and gets its own
		// comparator, because everything the general one re-tests per comparison is known here.
		const one = sortKeys[0];
		if (sortKeys.length === 1 && one.typed && one.valid === null) {
			const v = one.values;
			const d = dir(0);
			idx.sort((a, b) => (v[a] < v[b] ? -d : v[a] > v[b] ? d : 0));
			return this._take(idx);
		}
		idx.sort((a, b) => {
			for (let k = 0; k < sortKeys.length; k++) {
				const { values, valid } = sortKeys[k];
				const na = valid !== null ? valid[a] === 0 : isNull(values[a]);
				const nb = valid !== null ? valid[b] === 0 : isNull(values[b]);
				if (na || nb) {
					if (na && nb) continue;
					return (na ? 1 : -1) * nullDir;
				}
				const c = cmp(values[a], values[b]);
				if (c !== 0) return c * dir(k);
			}
			return 0;
		});
		return this._take(idx);
	}

	head(n = 5) {
		return this.slice(0, n);
	}
	tail(n = 5) {
		return this.slice(-n);
	}

	/** @param {number} offset Negative counts from the end. @param {number} [len] Omitted means to the end. */
	slice(offset = 0, len) {
		if (typeof offset !== "number" || (len !== undefined && typeof len !== "number")) {
			throw new TypeError("df.slice: expected (offset: number, len?: number)");
		}
		const from = Math.min(this._height, offset < 0 ? Math.max(0, this._height + offset) : offset);
		const to = len === undefined ? this._height : Math.min(this._height, from + Math.max(0, len));
		const data = new Map();
		for (const c of this._columns) data.set(c, this._data.get(c).slice(from, to));
		return new DataFrame([...this._columns], data, to - from);
	}

	/** Keep the first row of each distinct combination. */
	unique(subset) {
		const key = this._keyer(this._subset(subset, "df.unique"));
		const seen = new Set();
		const idx = new Uint32Array(this._height);
		let n = 0;
		for (let i = 0; i < this._height; i++) {
			const k = key(i);
			if (seen.has(k)) continue;
			seen.add(k);
			idx[n++] = i;
		}
		return this._take(idx.subarray(0, n));
	}

	/** Drop rows holding a null in any of `subset` (all columns by default). */
	drop_nulls(subset) {
		// Only columns that actually carry a mask can reject anything, so the rest are skipped.
		const masks = this._subset(subset, "df.drop_nulls")
			.map((c) => this._data.get(c).valid)
			.filter((v) => v !== null);
		if (masks.length === 0) return this._pick(this._columns);
		const idx = new Uint32Array(this._height);
		let n = 0;
		for (let i = 0; i < this._height; i++) {
			let keep = true;
			for (let m = 0; m < masks.length && keep; m++) keep = masks[m][i] === 1;
			if (keep) idx[n++] = i;
		}
		return this._take(idx.subarray(0, n));
	}

	/** Groups keep first-appearance order, so the result is deterministic. */
	group_by(...cols) {
		const keys = flatten(cols).map((c) => this._have(c, "df.group_by"));
		if (keys.length === 0) throw new TypeError("df.group_by: expected at least one column name");
		const groups = new Map();
		const key = this._keyer(keys);
		for (let i = 0; i < this._height; i++) bucket(groups, key(i), i);
		const frame = this;
		const build = (names, fill) => {
			const buckets = [...groups.values()];
			const data = new Map();
			const heads = buckets.map((idx) => idx[0]);
			for (const k of keys) data.set(k, frame._data.get(k).take(heads));
			const cells = new Map(names.map((n) => [n, new Array(buckets.length)]));
			for (let g = 0; g < buckets.length; g++) fill(buckets[g], g, cells);
			for (const n of names) data.set(n, pack(cells.get(n)));
			return new DataFrame([...keys, ...names.filter((n) => !keys.includes(n))], data, buckets.length);
		};
		return {
			/** @param {Record<string, string | Function | string[]>} spec column -> aggregate. */
			agg(spec) {
				const where = "df.group_by().agg";
				if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
					throw new TypeError(`${where}: expected an object of {column -> aggregate}, got ${typeof spec}`);
				}
				const plan = Object.entries(spec).map(([col, how]) => [frame._have(col, where), how]);
				const named = (col, how) => (Array.isArray(how) ? how.map((h) => `${col}_${h}`) : [col]);
				return build(
					plan.flatMap(([col, how]) => named(col, how)),
					(idx, g, cells) => {
						for (const [col, how] of plan) {
							const read = frame._data.get(col).reader();
							const values = idx.map(read);
							const each = Array.isArray(how) ? how : [how];
							named(col, how).forEach((name, k) => {
								cells.get(name)[g] = applyAgg(each[k], values, idx, where, col);
							});
						}
					},
				);
			},
			/** Row count per group, in a column called `len` (polars' name). */
			len() {
				return build(["len"], (idx, g, cells) => {
					cells.get("len")[g] = idx.length;
				});
			},
		};
	}

	/**
	 * @param {DataFrame} other
	 * @param {{on?: string | string[], left_on?: string | string[], right_on?: string | string[],
	 *   how?: "inner" | "left" | "outer", suffix?: string}} opts
	 */
	join(other, opts = {}) {
		if (!(other instanceof DataFrame)) {
			throw new TypeError(`df.join: expected a DataFrame, got ${other === null ? "null" : typeof other}`);
		}
		const { how = "inner", suffix = "_right" } = opts;
		if (!["inner", "left", "outer"].includes(how)) {
			throw new TypeError(`df.join: unknown how "${String(how)}" (inner, left, outer)`);
		}
		const on = (side) => (opts.on !== undefined ? flatten([opts.on]) : side === undefined ? null : flatten([side]));
		const left = on(opts.left_on);
		const right = on(opts.right_on);
		if (!left || !right || left.length !== right.length) {
			throw new TypeError("df.join: expected {on} or a matching {left_on, right_on}");
		}
		for (const c of left) this._have(c, "df.join");
		for (const c of right) other._have(c, "df.join");

		// The right frame's key columns are dropped; a non-key name that collides takes the suffix.
		const carried = other._columns.filter((c) => !right.includes(c));
		const as = new Map(carried.map((c) => [c, this._columns.includes(c) ? c + suffix : c]));
		const index = new Map();
		const rightKey = other._keyer(right);
		for (let i = 0; i < other._height; i++) bucket(index, rightKey(i), i);

		// The join is planned as two index vectors, so the values are gathered once, per column.
		const leftIdx = [];
		const rightIdx = [];
		const matched = new Set();
		const leftKey = this._keyer(left);
		for (let i = 0; i < this._height; i++) {
			const k = leftKey(i);
			const hits = index.get(k);
			if (!hits) {
				if (how !== "inner") {
					leftIdx.push(i);
					rightIdx.push(-1);
				}
				continue;
			}
			matched.add(k);
			for (const j of hits) {
				leftIdx.push(i);
				rightIdx.push(j);
			}
		}
		if (how === "outer") {
			for (const [k, hits] of index) {
				if (matched.has(k)) continue;
				for (const j of hits) {
					leftIdx.push(-1);
					rightIdx.push(j);
				}
			}
		}

		const data = new Map();
		for (const c of this._columns) data.set(c, this._data.get(c).take(leftIdx));
		for (const c of carried) data.set(as.get(c), other._data.get(c).take(rightIdx));
		// An outer row that matched nothing on the left still knows its key, from the right side.
		if (how === "outer") {
			left.forEach((c, p) => {
				const lc = this._data.get(c);
				const rc = other._data.get(right[p]);
				data.set(c, pack(leftIdx.map((i, k) => (i >= 0 ? lc.get(i) : rc.get(rightIdx[k])))));
			});
		}
		return new DataFrame([...this._columns, ...as.values()], data, leftIdx.length);
	}

	/**
	 * Long to wide. `on` supplies the new column names, `index` the row identity, `values` the
	 * cell; combinations with no row become `null`.
	 *
	 * @param {string | {on: string, index?: string | string[], values?: string, aggregate_function?: any}} on
	 * @param {{index?: string | string[], values?: string, aggregate_function?: any}} [opts]
	 */
	pivot(on, opts = {}) {
		const o = typeof on === "object" && on !== null ? on : { ...opts, on };
		const where = "df.pivot";
		const key = this._data.get(this._have(o.on, where));
		const source = this._data.get(this._have(o.values, where));
		const index = flatten([o.index ?? []]).map((c) => this._have(c, where));
		if (index.length === 0) throw new TypeError(`${where}: expected {index} naming at least one column`);
		const how = o.aggregate_function ?? "first";

		const names = [];
		const wide = new Map();
		const indexKey = this._keyer(index);
		const readKey = key.reader();
		for (let i = 0; i < this._height; i++) {
			const on = readKey(i);
			const name = isNull(on) ? "null" : String(on);
			if (!names.includes(name)) names.push(name);
			const k = indexKey(i);
			if (!wide.has(k)) wide.set(k, { head: i, cells: new Map() });
			bucket(wide.get(k).cells, name, i);
		}
		const rows = [...wide.values()];
		const readSource = source.reader();
		const data = new Map();
		for (const c of index) data.set(c, this._data.get(c).take(rows.map((b) => b.head)));
		for (const name of names) {
			data.set(
				name,
				pack(
					rows.map((b) => {
						const idx = b.cells.get(name);
						return idx ? applyAgg(how, idx.map(readSource), idx, where, o.values) : null;
					}),
				),
			);
		}
		return new DataFrame([...index, ...names.filter((n) => !index.includes(n))], data, rows.length);
	}

	/** @returns {any[]} The column as a plain array - what `chart` and `stats` take. */
	get_column(name) {
		return this._data.get(this._have(name, "df.get_column")).toArray();
	}

	/** @returns {Record<string, any>[]} Fresh objects, the boundary where rows are materialised. */
	to_dicts() {
		const out = new Array(this._height);
		const readers = this._columns.map((c) => this._data.get(c).reader());
		// Spreading one template gives every row the same hidden class, which the JIT then reuses.
		const shape = Object.fromEntries(this._columns.map((c) => [c, null]));
		for (let i = 0; i < this._height; i++) {
			const r = { ...shape };
			for (let j = 0; j < readers.length; j++) r[this._columns[j]] = readers[j](i);
			out[i] = r;
		}
		return out;
	}

	/** @returns {Record<string, any[]>} */
	to_columns() {
		return Object.fromEntries(this._columns.map((c) => [c, this._data.get(c).toArray()]));
	}

	/**
	 * One summary row per statistic, as a frame, the way polars returns it. Non-numeric columns
	 * get `null` for everything but `count`, `null_count`, `min` and `max`. For a single
	 * `number[]` the sibling `stats` skill is the better tool - it has quantiles, correlation and
	 * a compensated sum.
	 */
	describe() {
		const summary = this._columns.map((c) => {
			const col = this._data.get(c);
			const v = col.toArray();
			const num = NUMERIC.has(col.dtype);
			const sorted = num ? numbers(v, "df.describe", c).sort((a, b) => a - b) : [];
			const q = (p) => (num ? quantile(sorted, p) : null);
			const count = AGGS.count(v);
			return [
				c,
				{
					count,
					null_count: v.length - count,
					mean: num ? AGGS.mean(v, "df.describe", c) : null,
					std: num ? AGGS.std(v, "df.describe", c) : null,
					min: AGGS.min(v),
					"25%": q(0.25),
					"50%": q(0.5),
					"75%": q(0.75),
					max: AGGS.max(v),
				},
			];
		});
		const rows = DESCRIBE_STATS.map((s) =>
			Object.fromEntries([["statistic", s], ...summary.map(([c, o]) => [c, o[s] ?? null])]),
		);
		return normalize(rows, "df.describe");
	}

	/** A polars-style box table, so a bare frame in a REPL cell prints something readable. */
	toString() {
		const [h, w] = this.shape;
		const header = `shape: (${h}, ${w})`;
		if (w === 0) return header;
		const dtypes = this.dtypes;
		// Past ten rows, show the first five and the last five with an ellipsis between them.
		const shown = h > 10 ? [...range(0, 5), -1, ...range(h - 5, h)] : range(0, h);
		const body = shown.map((i) => this._columns.map((c) => (i < 0 ? "…" : fmt(this._data.get(c).get(i)))));
		const widths = this._columns.map((c, i) =>
			Math.max(c.length, 3, dtypes[c].length, ...body.map((row) => row[i].length)),
		);
		const pad = (s, i) => s + " ".repeat(widths[i] - s.length);
		const rule = (l, m, r, fill) => l + widths.map((n) => fill.repeat(n + 2)).join(m) + r;
		const line = (cells) => `│ ${cells.map(pad).join(" ┆ ")} │`;
		return [
			header,
			rule("┌", "┬", "┐", "─"),
			line(this._columns),
			line(this._columns.map(() => "---")),
			line(this._columns.map((c) => dtypes[c])),
			rule("╞", "╪", "╡", "═"),
			...body.map(line),
			rule("└", "┴", "┘", "─"),
		].join("\n");
	}

	[Symbol.for("nodejs.util.inspect.custom")]() {
		return this.toString();
	}
}

// pandas spellings for the polars names, so either muscle memory lands.
DataFrame.prototype.assign = DataFrame.prototype.with_columns;
DataFrame.prototype.sort_values = DataFrame.prototype.sort;
DataFrame.prototype.groupby = DataFrame.prototype.group_by;
DataFrame.prototype.to_records = DataFrame.prototype.to_dicts;
DataFrame.prototype.dropna = DataFrame.prototype.drop_nulls;
DataFrame.prototype.drop_duplicates = DataFrame.prototype.unique;

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

function fmt(v) {
	if (isNull(v)) return "null";
	const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
	return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

/** Row-oriented input, transposed once into columns. An absent key is a null, not a hole. */
function normalize(rows, where) {
	if (!Array.isArray(rows)) {
		throw new TypeError(`${where}: expected an array of row objects, got ${rows === null ? "null" : typeof rows}`);
	}
	const columns = [];
	for (const [i, r] of rows.entries()) {
		if (!r || typeof r !== "object" || Array.isArray(r)) {
			throw new TypeError(`${where}: row ${i} is not an object (${r === null ? "null" : typeof r})`);
		}
		for (const c of Object.keys(r)) if (!columns.includes(c)) columns.push(c);
	}
	const arrays = columns.map(() => new Array(rows.length));
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		for (let j = 0; j < columns.length; j++) arrays[j][i] = r[columns[j]] ?? null;
	}
	const data = new Map();
	for (let j = 0; j < columns.length; j++) data.set(columns[j], pack(arrays[j]));
	return new DataFrame(columns, data, rows.length);
}

/** @param {Record<string, any>[]} rows */
function df(rows) {
	return rows instanceof DataFrame ? rows : normalize(rows, "df");
}

/** @param {Record<string, any[]>} cols Column name -> values, all the same length. */
function from_columns(cols) {
	if (!cols || typeof cols !== "object" || Array.isArray(cols)) {
		throw new TypeError(`df.from_columns: expected an object of {column -> values}, got ${typeof cols}`);
	}
	const entries = Object.entries(cols);
	const height = entries.length ? entries[0][1]?.length : 0;
	for (const [name, values] of entries) {
		if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
			throw new TypeError(`df.from_columns: column "${name}" is not an array`);
		}
		if (values.length !== height) {
			throw new TypeError(`df.from_columns: column "${name}" has ${values.length} values, expected ${height}`);
		}
	}
	return new DataFrame(
		entries.map(([name]) => name),
		new Map(entries.map(([name, values]) => [name, pack(Array.from(values))])),
		height,
	);
}

/** Stack frames vertically, taking the union of their columns and filling the gaps with null. */
function concat(frames) {
	if (!Array.isArray(frames)) throw new TypeError(`df.concat: expected an array of frames, got ${typeof frames}`);
	const columns = [];
	let height = 0;
	for (const f of frames) {
		if (!(f instanceof DataFrame)) throw new TypeError("df.concat: every element must be a DataFrame");
		for (const c of f._columns) if (!columns.includes(c)) columns.push(c);
		height += f._height;
	}
	const data = new Map();
	for (const c of columns) {
		const values = new Array(height);
		let k = 0;
		for (const f of frames) {
			const col = f._data.get(c);
			for (let i = 0; i < f._height; i++) values[k++] = col ? col.get(i) : null;
		}
		data.set(c, pack(values));
	}
	return new DataFrame(columns, data, height);
}

export default function createSkill() {
	return Object.assign(df, {
		from_records: df,
		from_dicts: df,
		from_columns,
		from_dict: from_columns,
		concat,
		DataFrame,
	});
}

export { AGGS, cmp, concat, df, dtypeOf, from_columns, isNull };
