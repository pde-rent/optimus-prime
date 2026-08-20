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

const render = (spec, color) => (color ? renderToAnsi(spec) : renderToString(spec));

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

/**
 * Build a spec, applying one mark type per series.
 *
 * Labels are deliberately withheld from the marks: the library's own legend is one grid row that
 * clips at the plot width, so it drops whole series. `legendBlock` draws them instead.
 */
function build(data, options, mark) {
	const { rows, keys } = toRows(data);
	let spec = crafterChart({
		width: options.width ?? 64,
		height: options.height ?? 14,
		...(options.charset ? { charset: options.charset } : {}),
	}).data(rows, { xKey: "x" });
	if (options.yFormat) spec = spec.yAxis({ format: options.yFormat });
	const entries = [];
	for (const [i, series] of keys.entries()) {
		const color = series.color ?? options.barColor ?? PALETTE[i % PALETTE.length];
		spec = spec[mark]({ key: series.key, color });
		// Only name a named series; a lone "value" legend is noise.
		if (series.key !== "value") entries.push({ label: series.key, mark, color });
	}
	return { spec, entries };
}

/** Everything the two surfaces stack around a plot, in one order. */
function compose(parts) {
	const lines = [];
	if (parts.title) lines.push(centre(String(parts.title), parts.width));
	if (parts.ylabel) lines.push(parts.ylabel);
	lines.push(parts.body);
	lines.push(...legendBlock(parts.entries, parts.width, parts.color));
	if (parts.xlabel) lines.push(centre(parts.xlabel, parts.width));
	const note = seriesNote(parts.entries, parts.color);
	if (note) lines.push(note);
	return lines.join("\n");
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
/**
 * The eight the renderer can actually draw, under the names matplotlib uses for them, plus the
 * two spellings that land on one of the eight. A colour outside this set is refused rather than
 * defaulted, because a series drawn in a colour nobody asked for is a chart that lies.
 */
const NAMED_COLORS = {
	blue: "blue",
	green: "green",
	red: "red",
	cyan: "cyan",
	magenta: "magenta",
	yellow: "yellow",
	white: "white",
	gray: "gray",
	grey: "gray",
	black: "gray",
};
const COLOR_NAMES = Object.keys(NAMED_COLORS).slice(0, 8);
/** Cycled over unclaimed series, in the same order the library's own `plot()` uses. */
const PALETTE = ["cyan", "green", "yellow", "magenta", "red", "blue", "white", "gray"];
/** @crafter/charts keeps its escape table internal, so the legend's swatches carry the codes. */
const ANSI_FG = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 };
const FMT_MARKERS = "o.,+x*sdv^<>ph";

/** Table lookups are own-key only, so a key like "constructor" cannot resolve to a prototype member. */
const lookup = (table, key) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined);

const paint = (text, color, on) => (on && lookup(ANSI_FG, color) ? `\x1b[${ANSI_FG[color]}m${text}\x1b[0m` : text);

function toColor(where, value) {
	const key = typeof value === "string" ? value.trim().toLowerCase() : value;
	const color = lookup(NAMED_COLORS, key) ?? lookup(FMT_COLORS, key);
	if (!color) {
		throw new TypeError(
			`${where} got colour ${JSON.stringify(value)}, which the renderer cannot draw. It has ${COLOR_NAMES.join(", ")}, or the letters bgrcmykw.`,
		);
	}
	return color;
}

function parseFmt(where, fmt) {
	if (fmt === undefined || fmt === null || fmt === "") return {};
	if (typeof fmt !== "string") {
		throw new TypeError(
			`${where} wants fmt as a string such as "r--" or "bo", got ${typeof fmt}. A name, colour or style goes in the options object instead, e.g. { label: "eth", color: "red" }.`,
		);
	}
	let rest = fmt;
	let color;
	// matplotlib's own fmt is single-character, but "red-" is what a model writes, so a leading
	// colour name is taken first and only the remainder read as style characters.
	for (const name of Object.keys(NAMED_COLORS)) {
		if (rest.toLowerCase().startsWith(name)) {
			color = NAMED_COLORS[name];
			rest = rest.slice(name.length);
			break;
		}
	}
	let hasMarker = false;
	let hasLine = false;
	for (const ch of rest) {
		const named = lookup(FMT_COLORS, ch);
		if (named) color = named;
		else if (ch === "-" || ch === ":") hasLine = true;
		else if (FMT_MARKERS.includes(ch)) hasMarker = true;
		else {
			throw new TypeError(
				`plot fmt "${fmt}" has an unknown character "${ch}". Use a colour (bgrcmykw, or a name — ${COLOR_NAMES.join(", ")}), a line style (- or :), or a marker (o . + x *).`,
			);
		}
	}
	// A marker with no line is matplotlib's scatter; anything else stays a line.
	return { ...(color ? { color } : {}), mark: hasMarker && !hasLine ? "scatter" : "line" };
}

const STYLE_OPTIONS = ["label", "color", "linestyle", "ls", "marker"];

/** A fmt string and the options object describe the same three things, so both parse in one place. */
function parseStyle(where, fmt, opts) {
	if (opts === undefined || opts === null) return parseFmt(where, fmt);
	if (typeof opts !== "object" || Array.isArray(opts)) {
		throw new TypeError(
			`${where} wants the options as an object, e.g. { label: "eth" }, got ${Array.isArray(opts) ? "an array" : typeof opts}`,
		);
	}
	for (const key of Object.keys(opts)) {
		if (!STYLE_OPTIONS.includes(key)) {
			throw new TypeError(`${where} got an unknown option "${key}". It takes ${STYLE_OPTIONS.join(", ")}.`);
		}
	}
	const style = parseFmt(where, `${fmt ?? ""}${opts.linestyle ?? opts.ls ?? ""}${opts.marker ?? ""}`);
	if (opts.color !== undefined) style.color = toColor(where, opts.color);
	if (opts.label !== undefined) style.label = String(opts.label);
	return style;
}

/**
 * matplotlib's `plot(x, y, fmt, **kwargs)`, in JS. `y` and `fmt` are each optional and the options
 * object is recognised by shape, so it may follow either — an array can only be data and a string
 * can only be a fmt, which leaves nothing ambiguous.
 */
function seriesArgs(where, args) {
	const rest = args.slice(1);
	const opts = rest.length > 0 && isOptions(rest[rest.length - 1]) ? rest.pop() : undefined;
	const fmt = rest.length > 0 && typeof rest[rest.length - 1] === "string" ? rest.pop() : undefined;
	if (rest.length > 1) {
		throw new TypeError(
			`${where} got ${args.length} arguments; it takes x, then an optional y, fmt and options object`,
		);
	}
	return { x: args[0], y: rest[0], ...parseStyle(where, fmt, opts) };
}

const isOptions = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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

const MARK_SYMBOL = { line: "─", scatter: "•", bar: "█" };
/** The renderer's y-axis gutter, so the legend lines up under the plot area as it used to. */
const LEGEND_INDENT = 8;

/**
 * The library writes its legend into a single grid row and clips it at the plot width, so with ten
 * series the sixth entry ends mid-word and the last four never appear at all. Wrapping keeps every
 * entry whole; an entry wider than the figure gets its own line rather than being cut.
 */
function legendBlock(entries, width, color) {
	if (!entries || entries.length === 0) return [];
	const room = Math.max(16, width - LEGEND_INDENT);
	const lines = [];
	let plain = "";
	let painted = "";
	for (const e of entries) {
		const symbol = lookup(MARK_SYMBOL, e.mark) ?? "─";
		const item = `${symbol} ${e.label}`;
		if (plain !== "" && plain.length + 2 + item.length > room) {
			lines.push(" ".repeat(LEGEND_INDENT) + painted);
			plain = "";
			painted = "";
		}
		const sep = plain === "" ? "" : "  ";
		plain += sep + item;
		painted += sep + paint(symbol, e.color, color) + ` ${e.label}`;
	}
	lines.push(" ".repeat(LEGEND_INDENT) + painted);
	return lines;
}

/**
 * Colour is the renderer's only per-series distinction — every line is the same braille glyph and
 * there are no dash patterns — so past eight series, or with colour off, the curves genuinely
 * cannot be told apart. Silence here is what leaves a model guessing whether its tenth series drew.
 */
function seriesNote(entries, color) {
	if (!entries || entries.length < 2) return "";
	const drew = `all ${entries.length} series drew, in legend order`;
	if (!color) {
		return `note: ${drew}, but this output carries no colour, and colour is the only thing that tells two curves apart here. Draw them one per show(), or compare final values with barh.`;
	}
	const repeats = entries.slice(PALETTE.length).map((e) => e.label);
	if (repeats.length > 0) {
		return `note: ${drew}; the palette holds ${PALETTE.length} colours, so ${repeats.join(", ")} reuse one already taken.`;
	}
	return "";
}

function limitPair(where, a, b) {
	const [lo, hi] = Array.isArray(a) ? a : [a, b];
	const nums = asNumbers(where, "limits", [lo, hi]);
	if (nums[0] >= nums[1])
		throw new TypeError(`${where} got ${nums[0]} and ${nums[1]}, but the low bound must be less`);
	return nums;
}

function renderSeries(fig, color) {
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
	for (const [i, s] of fig.series.entries()) {
		spec = spec[s.mark]({ key: s.key, color: seriesColor(s, i) });
	}
	return render(spec, color);
}

/** matplotlib's property cycle — an unclaimed series takes the next colour rather than the default one. */
const seriesColor = (s, i) => s.color ?? PALETTE[i % PALETTE.length];

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
	const color = shouldColor(fig.color);
	// A legend is drawn only once asked for, as in matplotlib — either by legend() or by naming a
	// series at plot time, which in a terminal would otherwise be a label that goes nowhere.
	const entries =
		fig.legend && !fig.bars
			? fig.series.map((s, i) => ({ label: s.label || `series ${i + 1}`, mark: s.mark, color: seriesColor(s, i) }))
			: [];
	return compose({
		title: fig.title,
		// matplotlib rotates the y label down the left edge; a terminal cannot, so it sits above the
		// axis where it still reads as belonging to the vertical scale.
		ylabel: fig.ylabel,
		body: fig.bars ? renderBars(fig) : renderSeries(fig, color),
		xlabel: fig.xlabel,
		entries,
		width: fig.width,
		color,
	});
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

	const push = (mark, points, style) => {
		if (fig.bars) throw new TypeError("barh cannot share a figure with plot/bar/scatter. Call show() between them.");
		const { color, label } = style ?? {};
		fig.series.push({ key: `s${fig.series.length}`, mark, points, ...(color ? { color } : {}), label: label ?? "" });
		// matplotlib needs legend() on top of a label=, but in a terminal there is no legend widget
		// to toggle, so naming a series and getting no legend is a loss with nothing to show for it.
		if (label) fig.legend = true;
	};

	const plot = (...args) => {
		const where = "plot(x, y?, fmt?, opts?)";
		const a = seriesArgs(where, args);
		push(a.mark ?? "line", toPoints(where, a.x, a.y), a);
	};

	const step = (...args) => {
		const where = "step(x, y?, opts?)";
		const a = seriesArgs(where, args);
		const points = toPoints(where, a.x, a.y);
		const staircase = [];
		for (const [i, point] of points.entries()) {
			// The renderer keys rows by x, so the riser is nudged just left of the next sample
			// rather than duplicating its x, which would overwrite the row.
			if (i > 0) staircase.push([point[0] - (point[0] - points[i - 1][0]) * 1e-6, points[i - 1][1]]);
			staircase.push(point);
		}
		push("line", staircase, a);
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
		scatter: (...args) => {
			const where = "scatter(x, y?, opts?)";
			const a = seriesArgs(where, args);
			push("scatter", toPoints(where, a.x, a.y), a);
		},
		bar: (...args) => {
			const where = "bar(x, height, opts?)";
			const a = seriesArgs(where, args);
			if (Array.isArray(a.x) && a.x.some((v) => typeof v === "string")) {
				throw new TypeError("bar(x, height) wants numeric x. For category labels use barh(labels, values).");
			}
			push("bar", toPoints(where, a.x, a.y), a);
		},
		title: label("title"),
		xlabel: label("xlabel"),
		ylabel: label("ylabel"),
		legend: (labels) => {
			fig.legend = true;
			if (labels === undefined) return;
			if (!Array.isArray(labels)) throw new TypeError('legend(labels?) wants an array, e.g. legend(["p50", "p99"])');
			// Positional override, as in matplotlib: a series past the end of the array keeps the
			// label it was plotted with, so the two ways of naming a series compose.
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
	function draw(data, opts, mark) {
		const options = opts ?? {};
		const color = shouldColor(options.color);
		const { spec, entries } = build(data, options, mark);
		// @crafter/charts has no title field, so passing one through the spec dropped it silently.
		// Compose it here, the same way the pyplot path does, rather than leaving the option a no-op.
		return compose({ title: options.title, body: render(spec, color), entries, width: options.width ?? 64, color });
	}

	/** Line chart. Accepts numbers, `[x, y]` pairs, `{x, y}` objects, or `[{name, data}, ...]`. */
	function line(data, opts) {
		return draw(data, opts, "line");
	}

	/** Bar chart; same inputs as `line`. */
	function bar(data, opts) {
		return draw(data, opts, "bar");
	}

	/** Scatter plot; same inputs as `line`. */
	function scatter(data, opts) {
		return draw(data, opts, "scatter");
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
		const color = shouldColor(options.color);
		return compose({
			title: options.title,
			body: render(spec, color),
			entries: [],
			width: options.width ?? 64,
			color,
		});
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
