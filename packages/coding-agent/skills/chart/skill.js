/**
 * Terminal charts, backed by `@crafter/charts`.
 *
 * The library does the drawing — braille sub-cell rendering, axes, labels, colour — and this
 * skill is the ergonomic layer over it: one `chart()` global that accepts the shapes an agent
 * actually has to hand (a bare array of numbers, `[x, y]` pairs, `{x, y}` objects, or named
 * series) and returns a string, plus the library's own builder for anything more involved.
 *
 * Everything returns a string, so it can be printed, embedded in a report, or written to a file.
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

const render = (spec, opts) => (shouldColor(opts?.color) ? renderToAnsi(spec) : renderToString(spec));

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
		...(options.title ? { title: options.title } : {}),
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
		/** The underlying `@crafter/charts` builder, for full control. */
		builder: crafterChart,
		render: renderToAnsi,
		renderToString,
		renderToHtml,
		run: line,
	});
}
