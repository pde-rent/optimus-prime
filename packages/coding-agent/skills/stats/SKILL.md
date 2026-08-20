---
name: stats
description: Array statistics `Math` lacks, on `number[]`. `stats.mean|median|sum|min|max(xs)` -> number (`min`/`max` loop, so no spread-arg stack limit). `stats.variance|stddev(xs, {population}?)` -> number, sample (n-1) by default. `stats.quantile(xs, q)` -> number, `q` in 0..1, linear interpolation. `stats.corr(xs, ys)` -> Pearson r in -1..1. `stats.describe(xs)` -> `{n, min, max, mean, median, stddev, sum, q1, q3}`. Throws TypeError on a non-array, an empty array, or a non-finite element.
---

# Stats

Statistics over a `number[]`. `Math` already covers scalars, so nothing here mirrors it - this
is only what an array needs.

    stats.mean([12, 9, 41, 7])            // 17.25
    stats.quantile(latencies, 0.99)       // p99
    stats.describe(tokenCounts)           // { n, min, max, mean, median, stddev, sum, q1, q3 }
    stats.corr(promptChars, latencyMs)    // Pearson r

## Functions

| Call | Returns |
|---|---|
| `stats.sum(xs)` | `number` - compensated (Neumaier) sum |
| `stats.mean(xs)` | `number` - arithmetic mean |
| `stats.median(xs)` | `number` - 0.5 quantile, averaging the middle pair when `n` is even |
| `stats.min(xs)` / `stats.max(xs)` | `number` |
| `stats.quantile(xs, q)` | `number` - `q` in `0..1`, linear interpolation |
| `stats.variance(xs, opts?)` | `number` - sample (`n - 1`) unless `{ population: true }` |
| `stats.stddev(xs, opts?)` | `number` - `sqrt(variance)`, same default |
| `stats.corr(xs, ys)` | `number` - Pearson `r` in `-1..1` |
| `stats.describe(xs)` | `{n, min, max, mean, median, stddev, sum, q1, q3}` |

`describe` returns an **object**, not an array: read `summary.median`, not `.find(...)`.

## Why these and not one-liners

Each of these replaces a hand-rolled version that is wrong only once the data gets big:

- **`sum` is compensated.** `xs.reduce((a, b) => a + b)` drops low-order bits as the running
  total grows, and over ten thousand samples the error is visible in the mean. Neumaier
  summation keeps those bits in a second accumulator and adds them back at the end. It also
  handles the case Kahan gets wrong, where the next term is larger than the total so far.
- **`min` and `max` loop.** `Math.min(...xs)` passes every element as a function argument and
  overflows the call stack somewhere past ~100k elements - a crash that shows up only on the
  large input, which is exactly when you cannot afford it.
- **Order statistics sort a copy, numerically.** `xs.sort()` is lexicographic, so `[10, 9]`
  comes back unchanged. `median`, `quantile`, and `describe` sort a copy with a numeric
  comparator and never reorder the caller's array.
- **`variance` is two-pass.** Deviations from the mean, not `E[x²] - E[x]²`, which subtracts two
  large nearly-equal numbers and can return a negative variance.

## Sample vs population

`variance` and `stddev` are the **sample** forms, dividing by `n - 1`, because a measured series
is almost always a sample of a larger population and dividing by `n` underestimates the spread.
Pass `{ population: true }` when the array really is the entire population:

    stats.stddev(latencies)                        // sample, n - 1
    stats.stddev(allNodesInCluster, { population: true })   // population, n

Sample variance is undefined for a single value, so `variance([1])` throws and asks for
`{ population: true }`. `describe` reports `stddev: 0` for `n = 1` instead of throwing - a
summary should describe whatever it was given.

## Quantiles

`quantile` interpolates linearly between order statistics (the R type-7 definition, which numpy
and pandas also use by default). `q` must be a finite number in `0..1`; `0` is the minimum, `1`
the maximum.

    stats.quantile([1, 2, 3, 4], 0.5)     // 2.5
    stats.quantile(latencies, 0.95)       // p95

## Correlation

`corr(xs, ys)` needs equal-length arrays of at least 2 pairs and returns Pearson `r` in
`-1..1`. A constant series has no variance and therefore no correlation to measure, so `r` is
`NaN` in that case - check with `Number.isNaN` before reporting it.

## Errors

Every function throws a `TypeError` naming the problem: a non-array, an empty array, or a
non-finite element (`NaN`, `Infinity`, a string) with its index. That is deliberate - a
statistic of bad data is a caller bug, and a silent `NaN` propagating into a report is worse
than a stack trace. Filter first if the input may be dirty:

    const clean = raw.filter(Number.isFinite);
    if (clean.length > 0) console.log(stats.describe(clean));
