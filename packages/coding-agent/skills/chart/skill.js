/**
 * Terminal charts, backed by `@crafter/charts`.
 *
 * The library does the drawing — braille sub-cell rendering, axes, labels, colour — and this
 * skill is the ergonomic layer over it: one `chart()` global that accepts the shapes an agent
 * actually has to hand (a bare array of numbers, `[x, y]` pairs, `{x, y}` objects, or named
 * series) and returns a string, plus the library's own builder for anything more involved.
 *
 * Everything returns a string, so it can be printed, embedded in a report, or written to a file.
 *
 * `chart.plt` is a second, matplotlib.pyplot-shaped surface over the same renderer, for the names
 * a Python-first model reaches for before it has read any of this.
 */

import {
	chart as crafterChart,
	plot,
	renderToAnsi,
	renderToHtml,
	renderToString,
	sparkBar,
	sparkDonut,
	sparkGauge,
	sparkHistogram,
	sparkline,
	sparkWinLoss,
} from "@crafter/charts";

/**
 * Colour is off when output is captured rather than written to a terminal, which is the usual
 * case for a REPL cell. `renderToString` drops the escapes; `renderToAnsi` keeps them.
 */
function shouldColor(option) {
	if (option === true || option === false) return option;
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return true;
	return Boolean(process.stdout?.isTTY);
}

const render = (spec, opts) => {
	const body = shouldColor(opts?.color) ? renderToAnsi(spec) : renderToString(spec);
	// @crafter/charts has no title field, so passing one through the spec dropped it silently.
	// Compose it here, the same way the pyplot path does, rather than leaving the option a no-op.
	return opts?.title ? `${centre(String(opts.title), opts.width ?? 64)}\n${body}` : body;
};

/**
 * Normalise the accepted inputs into rows the library can key on.
 *
 * Returns `{ rows, keys }`: one row per x position, one key per series.
 */
function toRows(data) {
	const isNamedSeries =
		Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" && "data" in data[0];

	if (isNamedSeries) {
		const byX = new Map();
		const keys = [];
		for (const [index, series] of data.entries()) {
			const key = series.name ?? series.label ?? `series${index + 1}`;
			keys.push({ key, color: series.color });
			for (const [i, point] of (series.data ?? []).entries()) {
				const x = Array.isArray(point)
					? Number(point[0])
					: point && typeof point === "object"
						? Number(point.x)
						: i;
				const y = Array.isArray(point)
					? Number(point[1])
					: point && typeof point === "object"
						? Number(point.y)
						: Number(point);
				const row = byX.get(x) ?? { x };
				row[key] = y;
				byX.set(x, row);
			}
		}
		// Series may cover different x ranges, so sort once the union is assembled.
		return { rows: [...byX.values()].sort((a, b) => a.x - b.x), keys };
	}

	const rows = (data ?? []).map((point, i) => {
		if (Array.isArray(point)) return { x: Number(point[0]), value: Number(point[1]) };
		if (point && typeof point === "object") return { x: Number(point.x), value: Number(point.y) };
		return { x: i, value: Number(point) };
	});
	return { rows, keys: [{ key: "value" }] };
}

/** Build a spec, applying one mark type per series. */
function build(data, opts, mark) {
	const options = opts ?? {};
	const { rows, keys } = toRows(data);
	let spec = crafterChart({
		width: options.width ?? 64,
		height: options.height ?? 14,
		...(options.charset ? { charset: options.charset } : {}),
	}).data(rows, { xKey: "x" });
	if (options.yFormat) spec = spec.yAxis({ format: options.yFormat });
	for (const series of keys) {
		const color = series.color ?? options.barColor;
		spec = spec[mark]({
			key: series.key,
			...(color ? { color } : {}),
			// Only label a named series; a lone "value" legend is noise.
			...(series.key === "value" ? {} : { label: series.key }),
		});
	}
	return spec;
}

// ---------------------------------------------------------------------------
// matplotlib.pyplot surface. Models are Python-first, so the names they reach for without
// reading a doc are `plot`/`title`/`show`, not this skill's own vocabulary. Everything below is
// a facade over the same builder above — no second renderer.
// ---------------------------------------------------------------------------

/**
 * The REPL echoes a cell's value through `util.inspect`, and a plain string comes back
 * JSON-escaped, collapsing a 14-line chart into one unreadable line of `\n`. A skill's code runs
 * in the REPL host realm, not the sandbox, so it cannot reach the cell's `console` — anything it
 * writes to stdout is a non-protocol line and is dropped. The return value is therefore the only
 * channel, and inspecting to itself is what makes a bare `plt.show()` render as the chart while
 * `String(...)` still yields an ordinary string.
 */
class Rendered extends String {
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return this.toString();
	}
}

/** matplotlib format strings, e.g. `"r--"`, `"bo"`, `"k."`. */
const FMT_COLORS = { b: "blue", g: "green", r: "red", c: "cyan", m: "magenta", y: "yellow", k: "gray", w: "white" };
const FMT_MARKERS = "o.,+x*sdv^<>ph";

function parseFmt(fmt) {
	if (fmt === undefined || fmt === null) return {};
	if (typeof fmt !== "string") {
		throw new TypeError(
			`plot(x, y, fmt) wants fmt as a string such as "r--" or "bo", got ${typeof fmt}. Series names come from legend([...]).`,
		);
	}
	let color;
	let hasMarker = false;
	let hasLine = false;
	for (const ch of fmt) {
		if (ch in FMT_COLORS) color = FMT_COLORS[ch];
		else if (ch === "-" || ch === ":") hasLine = true;
		else if (FMT_MARKERS.includes(ch)) hasMarker = true;
		else {
			throw new TypeError(
				`plot fmt "${fmt}" has an unknown character "${ch}". Use a colour (bgrcmykw), a line style (- or :), or a marker (o . + x *).`,
			);
		}
	}
	// A marker with no line is matplotlib's scatter; anything else stays a line.
	return { ...(color ? { color } : {}), mark: hasMarker && !hasLine ? "scatter" : "line" };
}

function asNumbers(where, name, value) {
	if (!Array.isArray(value)) {
		throw new TypeError(
			`${where} wants ${name} as an array of numbers, got ${value === null ? "null" : typeof value}`,
		);
	}
	return value.map((n, i) => {
		const num = Number(n);
		// Truncating or dropping a bad point would render a chart that quietly lies about the data.
		if (!Number.isFinite(num)) throw new TypeError(`${where} got a non-finite ${name}[${i}] of ${JSON.stringify(n)}`);
		return num;
	});
}

/** `plot(y)` implies x as the index; `plot(x, y)` pairs them and refuses a length mismatch. */
function toPoints(where, x, y) {
	const xs = asNumbers(where, y === undefined ? "y" : "x", x);
	if (y === undefined) return xs.map((v, i) => [i, v]);
	const ys = asNumbers(where, "y", y);
	if (xs.length !== ys.length) {
		throw new TypeError(`${where} got x of length ${xs.length} and y of length ${ys.length}, which must match`);
	}
	return xs.map((v, i) => [v, ys[i]]);
}

const FIGURE_DEFAULTS = { width: 64, height: 14 };

function newFigure(opts) {
	const o = opts ?? {};
	const [figW, figH] = Array.isArray(o.figsize) ? o.figsize : [];
	return {
		width: Math.max(24, Math.trunc(Number(o.width ?? figW ?? FIGURE_DEFAULTS.width))),
		height: Math.max(4, Math.trunc(Number(o.height ?? figH ?? FIGURE_DEFAULTS.height))),
		charset: o.charset,
		color: o.color,
		series: [],
		bars: null,
		title: "",
		xlabel: "",
		ylabel: "",
		legend: false,
		xlim: null,
		ylim: null,
	};
}

function centre(text, width) {
	const pad = Math.max(0, Math.floor((width - text.length) / 2));
	return " ".repeat(pad) + text;
}

function limitPair(where, a, b) {
	const [lo, hi] = Array.isArray(a) ? a : [a, b];
	const nums = asNumbers(where, "limits", [lo, hi]);
	if (nums[0] >= nums[1])
		throw new TypeError(`${where} got ${nums[0]} and ${nums[1]}, but the low bound must be less`);
	return nums;
}

function renderSeries(fig) {
	const byX = new Map();
	for (const s of fig.series) {
		for (const [x, y] of s.points) {
			if (fig.xlim && (x < fig.xlim[0] || x > fig.xlim[1])) continue;
			const row = byX.get(x) ?? { x };
			row[s.key] = y;
			byX.set(x, row);
		}
	}
	const rows = [...byX.values()].sort((a, b) => a.x - b.x);
	const size = { width: fig.width, height: fig.height, ...(fig.charset ? { charset: fig.charset } : {}) };
	let spec = crafterChart(size).data(rows, { xKey: "x" }).xAxis();
	if (fig.ylim) spec = spec.yDomain(fig.ylim);
	for (const s of fig.series) {
		spec = spec[s.mark]({
			key: s.key,
			...(s.color ? { color: s.color } : {}),
			// The renderer draws a legend for any labelled mark, so labels are withheld until
			// legend() asks for one — matplotlib shows no legend unless you call it.
			...(fig.legend && s.label ? { label: s.label } : {}),
		});
	}
	return render(spec, { color: fig.color });
}

/** Horizontal bars, the one chart shape that can carry category labels in a terminal. */
function renderBars(fig) {
	const max = Math.max(...fig.bars.map((b) => Math.abs(b.value)));
	const labelWidth = Math.max(...fig.bars.map((b) => b.label.length));
	const barWidth = Math.max(8, fig.width - labelWidth - 12);
	return fig.bars
		.map(
			(b) =>
				`${b.label.padStart(labelWidth)} ${sparkBar(b.value, max || 1, { width: barWidth })} ${+b.value.toFixed(2)}`,
		)
		.join("\n");
}

function renderFigure(fig) {
	if (fig.bars === null && fig.series.length === 0) {
		throw new Error("plt.show() has nothing to draw. Call plot(), scatter(), bar(), barh(), step() or hist() first.");
	}
	const lines = [];
	if (fig.title) lines.push(centre(fig.title, fig.width));
	// matplotlib rotates the y label down the left edge; a terminal cannot, so it sits above the
	// axis where it still reads as belonging to the vertical scale.
	if (fig.ylabel) lines.push(fig.ylabel);
	lines.push(fig.bars ? renderBars(fig) : renderSeries(fig));
	if (fig.xlabel) lines.push(centre(fig.xlabel, fig.width));
	return lines.join("\n");
}

function unsupported(name, hint) {
	return () => {
		throw new Error(`plt.${name} is not supported in a terminal. ${hint}`);
	};
}

/**
 * The pyplot facade over one implicit figure.
 *
 * Statefulness is the trap pyplot carries into a persistent REPL: a figure that outlives its
 * `show()` silently contaminates the next chart when a `clf()` is forgotten, and the model has
 * no way to see it happened. `show()` therefore renders and resets, so a chart always contains
 * exactly the calls made since the previous `show()` — an invariant nothing can forget its way
 * out of. `figure()` also starts clean, which recovers a figure abandoned by a cell that threw.
 */
function createPyplot() {
	let fig = newFigure();

	const push = (mark, points, color) => {
		if (fig.bars) throw new TypeError("barh cannot share a figure with plot/bar/scatter. Call show() between them.");
		fig.series.push({ key: `s${fig.series.length}`, mark, points, ...(color ? { color } : {}), label: "" });
	};

	const plot = (x, y, fmt) => {
		// `plot(y, "r-")` — matplotlib reads a trailing string as the format, not as data.
		const [ys, format] = typeof y === "string" ? [undefined, y] : [y, fmt];
		const { mark = "line", color } = parseFmt(format);
		push(mark, toPoints("plot(x, y?, fmt?)", x, ys), color);
	};

	const step = (x, y) => {
		const points = toPoints("step(x, y?)", x, y);
		const staircase = [];
		for (const [i, point] of points.entries()) {
			// The renderer keys rows by x, so the riser is nudged just left of the next sample
			// rather than duplicating its x, which would overwrite the row.
			if (i > 0) staircase.push([point[0] - (point[0] - points[i - 1][0]) * 1e-6, points[i - 1][1]]);
			staircase.push(point);
		}
		push("line", staircase);
	};

	const hist = (values, bins) => {
		const nums = asNumbers("hist(values, bins?)", "values", values);
		if (nums.length === 0) throw new TypeError("hist(values) got an empty array");
		const count = bins === undefined ? 10 : Math.trunc(Number(bins));
		if (!Number.isFinite(count) || count < 1) throw new TypeError(`hist(values, bins) wants bins >= 1, got ${bins}`);
		const lo = Math.min(...nums);
		const width = (Math.max(...nums) - lo) / count || 1;
		const counts = new Array(count).fill(0);
		for (const n of nums) counts[Math.min(count - 1, Math.floor((n - lo) / width))]++;
		push(
			"bar",
			counts.map((c, i) => [lo + width * (i + 0.5), c]),
		);
	};

	const barh = (labels, widths) => {
		if (!Array.isArray(labels)) throw new TypeError("barh(y, width) wants y as an array of labels");
		const [names, values] =
			widths === undefined ? [labels.map((_, i) => String(i)), labels] : [labels.map(String), widths];
		const nums = asNumbers("barh(y, width)", "width", values);
		if (names.length !== nums.length) {
			throw new TypeError(`barh(y, width) got y of length ${names.length} and width of length ${nums.length}`);
		}
		if (fig.series.length > 0) throw new TypeError("barh cannot share a figure with plot/bar/scatter.");
		fig.bars = names.map((label, i) => ({ label, value: nums[i] }));
	};

	const label = (field) => (text) => {
		if (typeof text !== "string") throw new TypeError(`${field}(s) wants a string, got ${typeof text}`);
		fig[field] = text;
	};

	const limit = (field) => (a, b) => {
		fig[field] = limitPair(`${field}(a, b)`, a, b);
	};

	// One reset behind figure/clf/cla/close: every one of them means "start a fresh figure", and
	// matplotlib's distinctions between them only matter once there is more than one axes.
	const reset = (opts) => {
		fig = newFigure(opts);
	};

	return {
		plot,
		step,
		hist,
		barh,
		scatter: (x, y) => push("scatter", toPoints("scatter(x, y?)", x, y)),
		bar: (x, height) => {
			if (Array.isArray(x) && x.some((v) => typeof v === "string")) {
				throw new TypeError("bar(x, height) wants numeric x. For category labels use barh(labels, values).");
			}
			push("bar", toPoints("bar(x, height)", x, height));
		},
		title: label("title"),
		xlabel: label("xlabel"),
		ylabel: label("ylabel"),
		legend: (labels) => {
			fig.legend = true;
			if (labels === undefined) return;
			if (!Array.isArray(labels)) throw new TypeError('legend(labels?) wants an array, e.g. legend(["p50", "p99"])');
			for (const [i, text] of labels.entries()) if (fig.series[i]) fig.series[i].label = String(text);
		},
		xlim: limit("xlim"),
		ylim: limit("ylim"),
		// Accepted so a matplotlib script runs unchanged, but @crafter/charts draws no gridlines,
		// so this changes nothing. SKILL.md lists it as a no-op rather than leaving it to surprise.
		grid: () => {},
		figure: reset,
		clf: reset,
		cla: reset,
		close: reset,
		show: () => {
			const out = renderFigure(fig);
			reset();
			return new Rendered(out);
		},
		savefig: unsupported("savefig", "Write the text instead: write(path, String(plt.show()))."),
		subplot: unsupported("subplot", "Draw one chart per show() call."),
		subplots: unsupported("subplots", "Draw one chart per show() call."),
	};
}

export default function createSkill() {
	/** Line chart. Accepts numbers, `[x, y]` pairs, `{x, y}` objects, or `[{name, data}, ...]`. */
	function line(data, opts) {
		return render(build(data, opts, "line"), opts);
	}

	/** Bar chart; same inputs as `line`. */
	function bar(data, opts) {
		return render(build(data, opts, "bar"), opts);
	}

	/** Scatter plot; same inputs as `line`. */
	function scatter(data, opts) {
		return render(build(data, opts, "scatter"), opts);
	}

	/** Candlestick chart from `[{open, high, low, close}, ...]` or `[o, h, l, c]` tuples. */
	function candle(data, opts) {
		const options = opts ?? {};
		const rows = (data ?? []).map((c, i) =>
			Array.isArray(c)
				? { x: i, open: Number(c[0]), high: Number(c[1]), low: Number(c[2]), close: Number(c[3]) }
				: { x: i, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) },
		);
		const spec = crafterChart({ width: options.width ?? 64, height: options.height ?? 14 })
			.data(rows, { xKey: "x" })
			.candlestick({ open: "open", high: "high", low: "low", close: "close" });
		return render(spec, options);
	}

	/** One-line sparkline; safe to embed in other output. */
	function spark(values, opts) {
		const nums = (values ?? []).map(Number).filter(Number.isFinite);
		if (nums.length === 0) return "";
		return sparkline(nums, opts);
	}

	/** Quickest look at a series: the library's own one-liner, no options. */
	function quick(values) {
		const nums = (values ?? []).map(Number).filter(Number.isFinite);
		if (nums.length === 0) return "";
		return plot(nums);
	}

	/**
	 * Gauge and donut take an explicit maximum. A ratio is the common case here, so `max`
	 * defaults to 1 rather than producing `NaN%` when it is omitted.
	 */
	const gauge = (value, max, opts) => sparkGauge(Number(value), Number(max ?? 1), opts);
	const donut = (value, max, opts) => sparkDonut(Number(value), Number(max ?? 1), opts);

	// `chart(...)` is the common case; everything else hangs off it, including the library's raw
	// builder for charts these wrappers do not cover.
	//
	// pyplot hangs off `chart` rather than claiming a `plt` global for two reasons: a skill gets
	// exactly one sandbox binding, named after the skill (skills.ts jsImportNameForSkill), and a
	// harness global refuses to be redeclared (repl-script.ts installHarnessGlobal) — a global
	// `plt` would make the reflexive `const plt = ...` throw. As a property it does not, so the
	// matplotlib import idiom transfers verbatim.
	const plt = createPyplot();
	return Object.assign(line, {
		line,
		bar,
		scatter,
		candle,
		spark,
		plot: quick,
		histogram: sparkHistogram,
		gauge,
		donut,
		winLoss: sparkWinLoss,
		sparkBar,
		plt,
		pyplot: plt,
		/** The underlying `@crafter/charts` builder, for full control. */
		builder: crafterChart,
		render: renderToAnsi,
		renderToString,
		renderToHtml,
		run: line,
	});
}
