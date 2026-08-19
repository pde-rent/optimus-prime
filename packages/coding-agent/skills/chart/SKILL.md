---
name: chart
description: Draw terminal charts with `chart(data, opts?)` — line, bar, scatter, candlestick, sparkline, gauge, donut, histogram — returned as a string. Backed by @crafter/charts (braille rendering); use it whenever numbers are easier to read as a shape than as a table.
---

# Chart

Render data as a terminal chart. Every function returns a string, so print it, embed it in a
report, or write it to a file.

    chart([3, 1, 4, 1, 5, 9, 2, 6])     // line chart, index as x
    chart.bar([41, 118, 77])            // bars
    chart.spark(latencies)              // inline sparkline
    chart.gauge(0.62)                   // 62%

Drawing is done by [`@crafter/charts`](https://www.npmjs.com/package/@crafter/charts), which uses
braille (2x4 dots per character cell) so lines read as curves rather than staircases.

## Functions

| Call | Shape |
|---|---|
| `chart.line(data, opts?)` | connected line; `chart(...)` is the same function |
| `chart.bar(data, opts?)` | bars |
| `chart.scatter(data, opts?)` | points, unconnected |
| `chart.candle(data, opts?)` | candlesticks |
| `chart.spark(values, opts?)` | one-line sparkline, no axes |
| `chart.plot(values)` | quickest look, no options |
| `chart.histogram(values, opts?)` | distribution |
| `chart.gauge(value, max?, opts?)` | progress bar with percent; `max` defaults to 1 |
| `chart.donut(value, max?, opts?)` | same, as a ring |
| `chart.winLoss(values, opts?)` | up/down ticks |

## Data shapes

`line`, `bar`, `scatter` accept any of:

    [3, 1, 4]                           // y values, x is the index
    [[0, 3], [1, 1], [2, 4]]            // [x, y] pairs
    [{ x: 0, y: 3 }, { x: 1, y: 1 }]    // {x, y} objects
    [{ name: "p50", data: [...] },      // named series, drawn with a legend
     { name: "p99", data: [...] }]

`candle` accepts `[{open, high, low, close}, ...]` or `[o, h, l, c]` tuples.

## Options

`width`, `height` (characters), `title`, `charset: "box"` for box-drawing instead of braille,
`yFormat` (a function, e.g. `v => "$" + v.toFixed(0)`), `barColor`, and `color` to force ANSI on
or off.

Colour is off by default when output is captured rather than written to a terminal, which is the
usual case for a REPL cell. Pass `{ color: true }` to keep the escapes — for example when writing
a file that will be `cat`-ed.

## Beyond these wrappers

`chart.builder` is the library's own composable API, and `chart.render` / `chart.renderToString` /
`chart.renderToHtml` are its renderers:

    const spec = chart.builder({ width: 60, height: 14 })
      .data(rows, { xKey: "t" })
      .yAxis({ format: (v) => `${v}ms` })
      .line({ key: "p50", color: "green", label: "p50" })
      .line({ key: "p99", color: "red", label: "p99" });
    console.log(chart.render(spec));

## When to use it

Reach for a chart when the shape of the data is the answer: a latency distribution, a trend over
time, a benchmark comparison, a price series. For three numbers, a sentence is better. Charts are
for when a table would make the reader do the work of seeing the pattern.
