---
name: df
description: A dataframe over an array of objects, polars-named with pandas aliases. `df(rows)` -> frame. Every predicate is a plain JS closure, free to capture outer variables - `.filter(r=>r.tvl>cut)`, `.with_columns({share:r=>r.tvl/tot})` (`assign`). Also `.select`/`.drop`/`.rename`/`.sort` (`sort_values`)/`.head`/`.tail`/`.slice`/`.unique`/`.drop_nulls`/`.pivot`/`.describe`, `.group_by(col).agg({tvl:"sum"})` (`groupby`), `.join(o,{on,how})`. Output via `.to_dicts()` (`to_records`), `.to_columns()`, `.get_column(c)` -> array, `.shape`/`.columns`/`.dtypes`, `toString()` -> box table. The row given to a closure is reused - spread it to keep one. Bad args throw TypeError.
---

# df

A dataframe for the shape data actually arrives in here: an array of objects out of a JSON API.
The names are polars', with pandas aliases where the two differ, so whichever one you already
know is the one that works.

    const chains = df(await web3.defi.chains({ limit: 10 }))
    chains.sort("tvl", { descending: true }).head(5)
    chains.group_by("symbol").agg({ tvl: "sum", name: "count" })
    chains.filter((r) => r.tvl > 1e9).with_columns({ share: (r) => r.tvl / total })

## Closures work everywhere

Every predicate and every expression is an ordinary JavaScript function over the row, closing
over whatever is in scope:

    const cutoff = 1e9
    frame.filter((r) => r.tvl > cutoff)                      // just works
    frame.with_columns({ big: (r) => r.tvl > cutoff })       // so does this

That is the whole reason this exists rather than a dependency. Arquero, the small alternative,
compiles its table expressions and rejects captured variables outright - `dt.filter(d => d.tvl >
cutoff)` throws `Invalid variable reference` and you have to write `.params({cutoff}).filter((d,
$) => d.tvl > $.t)` instead. `nodejs-polars` has the right names but ships a 99 MB native binary
per platform into a 34 MB node_modules. So: no dependency, Bun stdlib only, and the natural line
is the one that runs.

The row a closure receives is **one object, reused for every row**, with getters onto the columns.
Read from it freely; if you want to keep it, spread it:

    frame.filter((r) => r.tvl > cutoff)              // fine
    frame.filter((r) => { kept.push({ ...r }); ... }) // keep a copy, not the view

## Storage

Columnar, arquero-shaped. Each column is one array plus a validity mask, and the array is a
`Float64Array`, `Int32Array` or `Uint8Array` whenever the column is homogeneously numeric,
boolean or a date - a plain `Array` otherwise, for strings, objects, bigints and mixed types.
Rows are materialised only at the edges: `to_dicts`, `toString`, and the reused view above.

That is why `select`, `drop` and `rename` cost nothing - they hand the same column objects to a
new frame - and why `filter`, `sort`, `unique` and `slice` are index permutations over typed
arrays rather than arrays of objects. Frames are immutable, and columns are never mutated after
they are built, which is what makes the sharing safe.

## Construction

| Call | From |
|---|---|
| `df(rows)` | array of objects; `df.from_records` and `df.from_dicts` are the same function |
| `df.from_columns({ a: [1, 2], b: ["x", "y"] })` | columns; alias `df.from_dict` |
| `df.concat([a, b])` | stack frames vertically, union of columns, gaps filled with `null` |

Construction takes the union of every row's keys, in first-appearance order, and fills what a row
is missing with `null`. So a ragged JSON response becomes a rectangle without losing the fact that
something was absent.

## Methods

| Call | Alias | Returns |
|---|---|---|
| `.select(...cols)` | | frame with those columns, in that order |
| `.drop(...cols)` | | frame without them |
| `.rename({ old: "new" })` | | frame, column order kept |
| `.filter(fn)` | | frame; `fn(row, i)` |
| `.with_columns({ name: fn \| value })` | `.assign` | frame with columns added or replaced |
| `.sort(by, opts?)` | `.sort_values` | stable sort; `by` is a name, an array of names, or a key function |
| `.head(n = 5)` / `.tail(n = 5)` | | frame |
| `.slice(offset, len?)` | | frame; negative `offset` counts from the end |
| `.unique(cols?)` | `.drop_duplicates` | first row of each distinct combination |
| `.drop_nulls(cols?)` | `.dropna` | rows with no null in those columns (all columns by default) |
| `.group_by(...cols)` | `.groupby` | a grouping with `.agg(spec)` and `.len()` |
| `.join(other, opts)` | | frame; `inner`, `left`, `outer` |
| `.pivot(on, opts)` | | long to wide |
| `.describe()` | | a frame, one row per statistic |
| `.get_column(name)` | | plain array - what `chart` and `stats` take |
| `.to_dicts()` | `.to_records` | array of row objects (copies) |
| `.to_columns()` | | `{ column: values[] }` |
| `.shape` / `.height` / `.width` / `.len()` | | `[rows, cols]`, numbers |
| `.columns` / `.dtypes` | | `string[]`, `{ column: dtype }` |

Frames are immutable: every method returns a new one and leaves the receiver alone.

`dtypes` are polars' short names - `i64`, `f64`, `str`, `bool`, `date`, `obj`, `null` - inferred
from the values present. Integers beside floats widen to `f64`; anything else mixed is `obj`; a
column that is entirely null is `null`.

### `with_columns` applies in order

Entries are applied left to right, so a later one sees the column an earlier one just made -
pandas `assign` semantics:

    frame.with_columns({ gross: (r) => r.qty * r.price, net: (r) => r.gross * 0.997 })

Polars evaluates its expressions against the input frame instead. The two only disagree when one
entry overwrites a column another entry reads; if that matters, split it into two calls.

### `sort`

    frame.sort("tvl", { descending: true })
    frame.sort(["chain", "tvl"], { descending: [false, true] })
    frame.sort((r) => r.name.toLowerCase())
    frame.sort_values("tvl", { ascending: false })          // pandas spelling

The sort is stable, so ties keep their input order. Nulls go last in both directions; pass
`{ nulls_last: false }` to put them first.

### `group_by(...).agg(spec)`

`spec` maps a column to an aggregate name, an array of names, or a function:

    frame.group_by("chain").agg({ tvl: "sum", name: "count" })
    frame.group_by("chain", "category").agg({ tvl: ["sum", "mean"] })   // -> tvl_sum, tvl_mean
    frame.group_by("chain").agg({ tvl: (values) => Math.max(...values) })
    frame.group_by("chain").len()                                      // rows per group, column `len`

Groups come out in first-appearance order. The output carries the key columns first, then one
column per entry, named after the source column (or `col_agg` for the array form). A custom
function gets `(values, rows)` - the column's values for that group, and the group's rows.

| Aggregate | On nothing (empty or all-null) |
|---|---|
| `sum`, `mean`, `median`, `std`, `min`, `max` | `sum` -> `0` (as in polars), the rest -> `null` |
| `count` non-null count, `len` row count | `0` |
| `first`, `last` | `null` |
| `n_unique` | `0`; `null` counts as one distinct value |

Every aggregate skips nulls. The numeric ones (`sum`, `mean`, `median`, `std`) throw a TypeError
rather than coerce a string or a bigint - a `"3"` in a column you are summing is a data bug and
silently becoming `3` hides it. `min`/`max` order anything comparable, strings and dates included.

### `join(other, opts)`

    left.join(right, { on: "chain", how: "left" })
    left.join(right, { left_on: "chain", right_on: "name" })
    left.join(right, { on: ["chain", "date"], how: "inner", suffix: "_r" })

`how` is `inner` (default), `left`, or `outer`. Unmatched rows get `null` for the other side's
columns. The right frame's key columns are dropped; a non-key name that collides gets `suffix`,
`_right` by default.

### `pivot(on, opts)`

    long.pivot("chain", { index: "date", values: "tvl" })
    long.pivot("chain", { index: "date", values: "tvl", aggregate_function: "sum" })

`on` supplies the new column names (in first-appearance order), `index` the row identity, `values`
the cell. `aggregate_function` takes any `agg` name or a function and defaults to `"first"`;
combinations with no row become `null`.

## Nulls

A missing key, an explicit `null` and an `undefined` are all one value, and it is never `0`.
`drop_nulls` removes rows carrying one, aggregates skip them, sorts put them last, and
`describe()` counts them. `NaN` is not a null - it is a float, and it stays one.

Nulls live in a `Uint8Array` validity mask beside the values, not in the values, so a typed column
can carry a null without borrowing `0` or `NaN` to mean it. A column with nothing missing has no
mask at all, which is what makes `drop_nulls` nearly free on clean data.

Watch the seam with plain JS arithmetic, which does coerce: `null / 5` is `0`, not `null`. Guard
inside the closure or drop the rows first:

    frame.drop_nulls("volume24h").with_columns({ turnover: (r) => r.volume24h / r.tvl })

## Printing

`toString()` renders a polars box table, and the REPL's inspector uses it, so a bare frame in a
cell prints as one. Over ten rows it shows the first five, an ellipsis, and the last five; long
cells are truncated.

    shape: (5, 4)
    ┌──────────┬─────────────┬────────────┬──────────────────────┐
    │ name     ┆ tvl         ┆ volume24h  ┆ turnover             │
    │ ---      ┆ ---         ┆ ---        ┆ ---                  │
    │ str      ┆ i64         ┆ i64        ┆ f64                  │
    ╞══════════╪═════════════╪════════════╪══════════════════════╡
    │ Ethereum ┆ 46187428786 ┆ 2305418154 ┆ 0.04991440776410575  │
    │ BSC      ┆ 5258544136  ┆ 2978028120 ┆ 0.5663217884989147   │
    └──────────┴─────────────┴────────────┴──────────────────────┘

## The recipe: API -> frame -> table + chart

The default move for "rank these and show me the trend". Raw data from `web3.defi`, shaped by `df`,
drawn by `chart`. This runs as written:

    // 1. raw rows -> frame, with a derived column
    const chains = df(await web3.defi.chains({ limit: 8 }))
      .drop_nulls("volume24h")
      .with_columns({ turnover: (r) => r.volume24h / r.tvl })
      .sort("tvl", { descending: true });

    // 2. the current ranking, as a table
    console.log(String(chains.select("name", "tvl", "volume24h", "turnover")));

    // 3. history for the top three, long -> wide
    const top = chains.head(3).get_column("name");
    const series = await Promise.all(top.map((n) => web3.defi.chain(n, { history: 90, points: 30 })));
    const wide = df
      .concat(series.map((s) => df(s.history).with_columns({ chain: s.name })))
      .pivot("chain", { index: "date", values: "tvl" });

    // 4. rebased to 100 so chains of different size share one axis
    const base = Object.fromEntries(top.map((n) => [n, wide.get_column(n)[0]]));
    console.log(
      chart(
        top.map((n) => ({ name: n, data: wide.get_column(n).map((v) => (100 * v) / base[n]) })),
        { height: 12, width: 72 },
      ),
    );

`get_column` is the seam into `chart`: it hands back a plain array, which is exactly what
`chart(values)` takes. For multiple series, `chart` wants `[{ name, data }]` - one `get_column`
each, off a pivoted frame. `.to_dicts()` covers the `[{ x, y }]` shape when a frame already has
`x` and `y` columns, via `.rename({ date: "x", tvl: "y" })`.

## When to reach for `stats` instead

`describe()` summarises a whole frame - `count`, `null_count`, `mean`, `std`, `min`, the three
quartiles, `max`, one row per statistic, non-numeric columns null except the counts and the
extremes. That is the overview.

For real work on one series, take `.get_column(name)` and hand it to the `stats` skill, which owns
descriptive statistics on a `number[]`: `stats.quantile(xs, 0.99)`, `stats.corr(xs, ys)`,
`stats.stddev(xs, { population: true })`, and a compensated `stats.sum` that does not drift over
long series. Nothing here duplicates it.

    stats.corr(frame.get_column("tvl"), frame.get_column("volume24h"))

## Errors

A bad argument throws a `TypeError` naming what was expected - a wrong column name, a
non-function where a predicate goes, a non-numeric value in a numeric aggregate, ragged columns in
`from_columns`. This is pure local computation, so there is no error value to return; the throw is
the report.

    df.select: no column named "tvl" (have name, symbol, chain_id)
    df.filter: expected a predicate function, got string
    df.group_by().agg: unknown aggregate "avg" for column "tvl" (sum, mean, median, ...)

## Not this skill

No lazy evaluation, no query planner, no Arrow, no file IO, no SQL. Frames here are under about a
million rows and everything is eager; past that, reach for a real engine. Plotting belongs to
`chart`, single-series statistics to `stats`.
