---
name: chart
description: Draw terminal charts with `chart(data, opts?)` — line, scatter, bar, column, candlestick, sparkline and histogram, returned as a string. Braille rendering gives smooth curves; use it whenever numbers are easier to read as a shape than as a table.
---

# Chart

Render data as a terminal chart. Every function returns a string, so print it,
embed it in a report, or write it to a file.

    chart([3, 1, 4, 1, 5, 9, 2, 6])            // line chart, index as x
    chart.bar({ bun: 41, node: 118 })          // horizontal bars
    chart.spark(latencies)                     // inline sparkline

Plots are drawn with braille, which packs a 2x4 dot grid into each character, so
a 64x14 chart really has 128x56 points of resolution. Bars use eighth-block
elements, so lengths are exact to an eighth of a cell.

## Functions

| Call | Shape |
|---|---|
| `chart.line(data, opts?)` | connected line; `chart(...)` is the same function |
| `chart.scatter(data, opts?)` | same inputs, points unconnected |
| `chart.bar(data, opts?)` | horizontal bars, one row per item |
| `chart.column(data, opts?)` | vertical bars, one column per value |
| `chart.candle(data, opts?)` | candlesticks, green up / red down |
| `chart.spark(values, opts?)` | one-line sparkline, no axes |
| `chart.histogram(values, opts?)` | buckets the values, draws the counts |

## Data shapes

`line`, `scatter` accept any of:

    [3, 1, 4]                                  // y values, x is the index
    [[0, 3], [1, 1], [2, 4]]                   // [x, y] pairs
    [{ x: 0, y: 3 }, { x: 1, y: 1 }]           // {x, y} objects
    [{ name: "p50", data: [...] },             // named series, auto-coloured
     { name: "p99", data: [...] }]

`bar`, `column` accept `{label: value}`, `[[label, value], ...]` or
`[{label, value, color}, ...]`. `candle` accepts `[{open, high, low, close}, ...]`
or `[o, h, l, c]` tuples.

## Options

`width`, `height` (in characters), `title`, `min`/`max` or `minY`/`maxY` to pin
the scale, `decimals` for axis label precision, `barColor`, and `color` to force
ANSI on or off.

Colour is off by default when output is captured rather than written to a
terminal, which is the usual case for a REPL cell — pass `{ color: true }` to
keep the escapes, for example when writing a file that will be `cat`-ed.

## When to use it

Reach for a chart when the shape of the data is the answer: a latency
distribution, a trend over time, a benchmark comparison, a price series. For
three numbers, a sentence is better. Charts are for when a table would make the
reader do the work of seeing the pattern.
