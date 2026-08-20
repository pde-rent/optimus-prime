---
name: chart
description: Terminal charts over @crafter/charts (braille rendering), in two surfaces. Native — `chart(data, opts?)` plus `chart.bar/scatter/candle/spark/gauge/donut/histogram`, each returning a string. matplotlib.pyplot — `const plt = chart.plt` then plot, scatter, bar, barh, hist, step, title, xlabel, ylabel, legend, xlim, ylim, grid, figure, show, clf, close. `plot(x, y, fmt?, opts?)` takes `{label, color}` and named colours, as matplotlib does. `plt.show()` renders the figure and resets it, so each chart holds exactly the calls made since the last show. No subplots, savefig, colormaps, 3D or animation. Use it whenever numbers read better as a shape than as a table.
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

## matplotlib.pyplot

`chart.plt` (alias `chart.pyplot`) is a pyplot facade over the same renderer. The Python import
idiom transfers verbatim:

    const plt = chart.plt;               // like: import matplotlib.pyplot as plt
    plt.plot(xs, ys, "r-", { label: "p99" });
    plt.plot(xs, baseline, { label: "p50", color: "green" });
    plt.title("latency");
    plt.xlabel("request");
    plt.ylabel("ms");
    plt.show();                          // renders the chart

| Call | Notes |
|---|---|
| `plot(y)`, `plot(x, y)`, `plot(x, y, fmt)`, `plot(x, y, fmt?, opts?)` | `fmt` is a matplotlib format string — colour `bgrcmykw` or a name like `"red"`, line `-` or `:`, marker `o . + x *`. A marker with no line draws a scatter. |
| `scatter(x, y, opts?)` | points, unconnected |
| `bar(x, height, opts?)` | `x` must be numeric; for category labels use `barh` |
| `barh(labels, values)` | horizontal bars with the label printed beside each one |
| `hist(values, bins?)` | `bins` defaults to 10 |
| `step(x, y, opts?)` | staircase |
| `title(s)`, `xlabel(s)`, `ylabel(s)` | text lines above and below the plot; `ylabel` sits above the axis, since a terminal cannot rotate it |
| `legend(labels?)` | draws the legend, overriding plot-time labels positionally |

### Naming and colouring a series

`plot`, `scatter`, `step` and `bar` take an options object last, holding any of `label`, `color`,
`linestyle` (alias `ls`) and `marker`. It may follow a `fmt` or replace it, and it may sit where
`y` would be when `x` is implied:

    plt.plot(x, y, { label: "Ethereum" });
    plt.plot(x, y, "r--", { label: "Solana" });
    plt.plot(y, { color: "green", marker: "o" });

An option outside that list throws rather than being dropped, so `linewidth` tells you it is not
a thing here instead of quietly changing nothing.

Colours are the eight the renderer can draw — `blue green red cyan magenta yellow white gray` —
by name, or as the letters `bgrcmykw`. `grey` and `black` land on `gray`. Anything else (`orange`,
`#ff0000`, `tab:blue`) throws and lists what is available; nothing silently falls back to a
default, because a series drawn in a colour nobody chose is a chart that misleads. A series with
no colour takes the next one in the cycle, as matplotlib's property cycle does.

Naming a series with `label` draws the legend on its own — matplotlib also wants `legend()`, but
a terminal has no legend to toggle, so a named series that drew none would be a pure loss.
`legend([...])` still works and still wins where the two disagree, entry by entry.

### How many series can be told apart

**One, in a normal REPL cell. Eight if ANSI colour survives to the reader.** Colour is the
renderer's only per-series distinction — every line is drawn from the same braille glyphs and
there are no dash patterns — and its palette holds eight. The REPL runs with `NO_COLOR`, and tool
output is stripped of escapes before you see it, so in practice the curves in a multi-series chart
are not tellable apart at all.

So a multi-series chart says so, under the legend:

    note: all 10 series drew, in legend order, but this output carries no colour, ...

The legend itself wraps across lines and never truncates an entry, so ten series give ten whole
names in legend order. When you need to read ten series rather than see their envelope, draw them
one per `show()`, or compare a single number each with `barh`.

### Lifecycle and limits

| call | behaviour |
|---|---|
| `xlim(a, b)`, `ylim(a, b)` | also accept a single `[a, b]` |
| `figure(opts?)` | starts a fresh figure; `{ width, height, charset, color }` or `{ figsize: [w, h] }` in characters |
| `show()` | renders the figure, then resets it |
| `clf()`, `cla()`, `close()` | discard the figure without rendering |

Multiple series are repeated calls before one `show()`, exactly as in pyplot.

### State

A REPL cell persists, so a figure that outlived its `show()` would silently contaminate the next
chart. `show()` therefore renders **and resets**: a chart contains exactly the calls made since
the previous `show()`, and there is no call you can forget that changes what you get. Call
`clf()` (or `figure()`) only to abandon a figure — for instance after a cell threw part-way
through building one.

### show() and output

There is no display to show to, so `show()` returns the rendered chart. It renders as itself
both when it is the last expression in a cell and when passed to `console.log`, so either of
these prints the chart:

    plt.show();
    console.log(plt.show());

The return value is a `String` object rather than a primitive, which is what makes the bare
statement render. Every string method and template interpolation works on it; for an API that
demands a real primitive — `write(path, ...)` — wrap it: `write("chart.txt", String(plt.show()))`.

### Not supported

Fails loudly rather than silently, so you find out at the call and not in the output:

- `subplot` / `subplots` — two braille charts side by side in 80 columns are not legible. Draw
  one chart per `show()`.
- `savefig` — write the text instead, `write(path, String(plt.show()))`.
- `fill_between`, `errorbar`, `pie`, `imshow`, `contour`, colormaps, `twinx`, 3D, animation, and
  every `Axes`/`Figure` object method — absent, so calling one throws.

Accepted but does nothing: `grid(on)`. The renderer draws no gridlines; it is accepted only so a
matplotlib script runs unchanged.

## Native functions

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

`width`, `height` (characters), `charset: "box"` for box-drawing instead of braille, `yFormat`
(a function, e.g. `v => "$" + v.toFixed(0)`), `barColor`, and `color` to force ANSI on or off.

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

## Putting a chart in your answer

Reference it by name instead of retyping it. Assign what `show()` returned, then put the
reference alone on a line inside a fence so the renderer does not reflow the braille:

    const tvlChart = plt.show();

    ```
    {{repl:tvlChart}}
    ```

The host substitutes the variable's text as the message is sent, so the chart the user reads is
byte-for-byte the one the cell drew. A name that does not resolve becomes a visible
`[repl:tvlChart unavailable: ...]` marker and is reported back to you - so a chart is never
silently dropped, and never worth hand-truncating.
