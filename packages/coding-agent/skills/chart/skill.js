/**
 * Terminal charts: line, scatter, bar, column, candlestick, sparkline, histogram.
 *
 * Plots are drawn with braille (U+2800), which packs a 2x4 dot grid into every character cell
 * and is what makes a terminal line chart read as a curve rather than a staircase. Bars use the
 * eighth-block elements, so a length is exact to an eighth of a cell instead of rounding to one.
 *
 * Zero dependencies by design: the harness carries none, and the drawing itself is the small
 * part of any library that does this.
 */

const BRAILLE_BASE = 0x2800;
/** Bit for each dot position within a 2-wide, 4-tall cell, indexed [x][y]. */
const BRAILLE_DOTS = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const VERTICAL_EIGHTHS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];
const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const FULL_BLOCK = "█";

const ESC = "\u001b[";
const COLORS = {
	reset: `${ESC}0m`,
	dim: `${ESC}2m`,
	red: `${ESC}31m`,
	green: `${ESC}32m`,
	yellow: `${ESC}33m`,
	blue: `${ESC}34m`,
	magenta: `${ESC}35m`,
	cyan: `${ESC}36m`,
	white: `${ESC}37m`,
};
const SERIES_COLORS = ["cyan", "yellow", "magenta", "green", "blue", "red"];

/** Colour `text`, unless colour is off or the name is unknown. */
function paint(text, colorName, enabled) {
	if (!enabled || !colorName || !COLORS[colorName]) return text;
	return `${COLORS[colorName]}${text}${COLORS.reset}`;
}

/**
 * Colour is on for a TTY unless NO_COLOR is set; callers can force it either way.
 *
 * REPL cell output is captured rather than written to a terminal, so this is usually false and
 * charts come back as plain text. Pass `{ color: true }` to keep the escapes.
 */
function colorEnabled(option) {
	if (option === true || option === false) return option;
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return true;
	return Boolean(process.stdout?.isTTY);
}

/** Axis label: short, and without float noise like 0.30000000000000004. */
function formatNumber(value, decimals) {
	if (!Number.isFinite(value)) return "-";
	if (decimals !== undefined) return value.toFixed(decimals);
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
	if (Number.isInteger(value)) return String(value);
	if (abs >= 100) return value.toFixed(0);
	if (abs >= 1) return value.toFixed(2);
	if (abs === 0) return "0";
	return value.toPrecision(2);
}

/**
 * A braille drawing surface, addressed in dots.
 *
 * A 64x14 chart is really a 128x56 dot grid, which is where the resolution comes from.
 */
class BrailleCanvas {
	constructor(cols, rows) {
		this.cols = cols;
		this.rows = rows;
		this.width = cols * 2;
		this.height = rows * 4;
		this.cells = new Uint8Array(cols * rows);
		/** Per-cell colour, so series stay distinguishable wherever they do not overlap. */
		this.colors = new Array(cols * rows).fill(null);
	}

	set(x, y, colorName) {
		const px = Math.round(x);
		const py = Math.round(y);
		if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
		const col = Math.floor(px / 2);
		const row = Math.floor(py / 4);
		const index = row * this.cols + col;
		this.cells[index] |= BRAILLE_DOTS[px % 2][py % 4];
		if (colorName) this.colors[index] = colorName;
	}

	/** Straight line between two dot coordinates (Bresenham). */
	line(x0, y0, x1, y1, colorName) {
		let ax = Math.round(x0);
		let ay = Math.round(y0);
		const bx = Math.round(x1);
		const by = Math.round(y1);
		const dx = Math.abs(bx - ax);
		const dy = -Math.abs(by - ay);
		const sx = ax < bx ? 1 : -1;
		const sy = ay < by ? 1 : -1;
		let err = dx + dy;
		for (;;) {
			this.set(ax, ay, colorName);
			if (ax === bx && ay === by) break;
			const e2 = 2 * err;
			if (e2 >= dy) {
				err += dy;
				ax += sx;
			}
			if (e2 <= dx) {
				err += dx;
				ay += sy;
			}
		}
	}

	toLines(useColor) {
		const out = [];
		for (let row = 0; row < this.rows; row++) {
			let text = "";
			for (let col = 0; col < this.cols; col++) {
				const index = row * this.cols + col;
				const bits = this.cells[index];
				if (bits === 0) {
					text += " ";
					continue;
				}
				text += paint(String.fromCharCode(BRAILLE_BASE + bits), this.colors[index], useColor);
			}
			out.push(text.replace(/\s+$/, ""));
		}
		return out;
	}
}

/** True when the input is a list of `{ data }` series rather than a single series of points. */
function isSeriesList(input) {
	if (!Array.isArray(input) || input.length === 0) return false;
	const first = input[0];
	return !Array.isArray(first) && typeof first === "object" && first !== null && "data" in first;
}

/** Normalise every accepted shape into `{ name, color, points: [[x, y], ...] }`. */
function normalizeSeries(input) {
	const list = isSeriesList(input) ? input : [{ data: input }];
	return list.map((entry, i) => {
		const raw = Array.isArray(entry) ? entry : entry.data;
		const points = (raw ?? []).map((point, index) => {
			if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
			if (point && typeof point === "object") return [Number(point.x), Number(point.y)];
			return [index, Number(point)];
		});
		return {
			name: entry.name ?? entry.label ?? null,
			color: entry.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
			points: points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
		};
	});
}

/** Extent of the data, honouring any bounds the caller pinned. */
function computeBounds(series, opts) {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const s of series) {
		for (const [x, y] of s.points) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (!Number.isFinite(minX)) {
		minX = 0;
		maxX = 1;
		minY = 0;
		maxY = 1;
	}
	if (opts.minY !== undefined) minY = opts.minY;
	if (opts.maxY !== undefined) maxY = opts.maxY;
	if (opts.minX !== undefined) minX = opts.minX;
	if (opts.maxX !== undefined) maxX = opts.maxX;
	// A flat series would divide by zero; give it room so the line lands mid-plot.
	if (maxY === minY) {
		maxY += 1;
		minY -= 1;
	}
	if (maxX === minX) maxX += 1;
	return { minX, maxX, minY, maxY };
}

/**
 * Precision that suits a whole axis.
 *
 * Formatting each tick independently mixes styles down one column — `20.00` above `8.89` above
 * `0.000098` — so the precision is chosen once from the range and applied to every tick.
 */
function axisDecimals(span) {
	if (!Number.isFinite(span) || span === 0) return 2;
	const magnitude = Math.abs(span);
	if (magnitude >= 1e4) return undefined; // formatNumber's k/M/B suffixes read better here
	if (magnitude >= 100) return 0;
	if (magnitude >= 10) return 1;
	if (magnitude >= 1) return 2;
	// Enough places to separate adjacent ticks rather than showing them all as 0.00.
	return Math.min(8, Math.ceil(-Math.log10(magnitude)) + 2);
}

/** Y-axis gutter: tick labels right-aligned to a common width. */
function yAxisLabels(rows, bounds, decimals) {
	const places = decimals ?? axisDecimals(bounds.maxY - bounds.minY);
	const labels = [];
	for (let row = 0; row < rows; row++) {
		const t = rows === 1 ? 1 : 1 - row / (rows - 1);
		labels.push(formatNumber(bounds.minY + t * (bounds.maxY - bounds.minY), places));
	}
	const width = Math.max(...labels.map((l) => l.length));
	return { labels: labels.map((l) => l.padStart(width)), width };
}

function renderLegend(series, useColor) {
	const named = series.filter((s) => s.name);
	if (named.length === 0) return null;
	return named.map((s) => `${paint("──", s.color, useColor)} ${s.name}`).join("  ");
}

/** Assemble a plot: title, y-axis gutter, canvas, x-axis, legend. */
function frame(canvas, series, bounds, opts, useColor) {
	const { labels, width } = yAxisLabels(canvas.rows, bounds, opts.decimals);
	const body = canvas.toLines(useColor);
	const out = [];
	if (opts.title) out.push(paint(opts.title, "white", useColor));
	for (let row = 0; row < canvas.rows; row++) {
		out.push(`${paint(labels[row], "dim", useColor)} ${paint("│", "dim", useColor)}${body[row]}`);
	}
	out.push(`${" ".repeat(width)} ${paint(`└${"─".repeat(canvas.cols)}`, "dim", useColor)}`);
	if (opts.xLabels !== false) {
		const left = formatNumber(bounds.minX, opts.xDecimals);
		const right = formatNumber(bounds.maxX, opts.xDecimals);
		const gap = Math.max(1, canvas.cols - left.length - right.length);
		out.push(`${" ".repeat(width + 2)}${paint(left + " ".repeat(gap) + right, "dim", useColor)}`);
	}
	const legend = renderLegend(series, useColor);
	if (legend) out.push(`${" ".repeat(width + 2)}${legend}`);
	if (opts.xLabel) out.push(`${" ".repeat(width + 2)}${paint(opts.xLabel, "dim", useColor)}`);
	return out.join("\n");
}

/** Map data coordinates onto dot coordinates, y inverted so larger values sit higher. */
function projector(canvas, bounds) {
	return (x, y) => [
		((x - bounds.minX) / (bounds.maxX - bounds.minX)) * (canvas.width - 1),
		(1 - (y - bounds.minY) / (bounds.maxY - bounds.minY)) * (canvas.height - 1),
	];
}

function plot(input, opts, connect) {
	const options = opts ?? {};
	const useColor = colorEnabled(options.color);
	const cols = Math.max(8, options.width ?? 64);
	const rows = Math.max(2, options.height ?? 14);
	const series = normalizeSeries(input);
	const bounds = computeBounds(series, options);
	const canvas = new BrailleCanvas(cols, rows);
	const project = projector(canvas, bounds);
	for (const s of series) {
		// Connecting unsorted points would draw the line doubling back on itself.
		const ordered = connect ? [...s.points].sort((a, b) => a[0] - b[0]) : s.points;
		let previous = null;
		for (const [x, y] of ordered) {
			const [px, py] = project(x, y);
			if (connect && previous) canvas.line(previous[0], previous[1], px, py, s.color);
			else canvas.set(px, py, s.color);
			previous = [px, py];
		}
	}
	return frame(canvas, series, bounds, options, useColor);
}

/** Coerce the accepted label/value shapes into `{ label, value, color }`. */
function normalizeLabelled(data) {
	if (!Array.isArray(data)) {
		return Object.entries(data ?? {}).map(([label, value]) => ({ label, value: Number(value) }));
	}
	return data.map((entry, index) => {
		if (Array.isArray(entry)) return { label: String(entry[0]), value: Number(entry[1]) };
		if (entry && typeof entry === "object") {
			return { label: String(entry.label ?? entry.name ?? index), value: Number(entry.value), color: entry.color };
		}
		return { label: String(index), value: Number(entry) };
	});
}

export default function createSkill() {
	/** Line chart. Accepts numbers, `[x, y]` pairs, `{x, y}` objects, or named series. */
	function line(data, opts) {
		return plot(data, opts, true);
	}

	/** Scatter plot: the same inputs as `line`, with points left unconnected. */
	function scatter(data, opts) {
		return plot(data, opts, false);
	}

	/**
	 * Horizontal bar chart, one row per item.
	 *
	 * Accepts `{label: value}`, `[[label, value], ...]` or `[{label, value, color}, ...]`.
	 * The axis sits at zero unless some value is negative, in which case it sits at the minimum
	 * so the negative bars still have length.
	 */
	function bar(data, opts) {
		const options = opts ?? {};
		const useColor = colorEnabled(options.color);
		const items = normalizeLabelled(data);
		if (items.length === 0) return "";
		const labelWidth = Math.max(...items.map((i) => i.label.length));
		const values = items.map((i) => i.value).filter(Number.isFinite);
		const max = options.max ?? Math.max(...values, 0);
		const min = options.min ?? Math.min(...values, 0);
		const span = max - min || 1;
		const width = Math.max(8, options.width ?? 40);
		const valueWidth = Math.max(...items.map((i) => formatNumber(i.value, options.decimals).length));
		const out = [];
		if (options.title) out.push(paint(options.title, "white", useColor));
		for (const [index, item] of items.entries()) {
			const ratio = Number.isFinite(item.value) ? (item.value - min) / span : 0;
			const eighths = Math.max(0, Math.round(ratio * width * 8));
			const glyphs = FULL_BLOCK.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
			const barColor = item.color ?? options.barColor ?? SERIES_COLORS[index % SERIES_COLORS.length];
			const label = paint(item.label.padStart(labelWidth), "dim", useColor);
			const value = paint(formatNumber(item.value, options.decimals).padStart(valueWidth), "dim", useColor);
			// An empty bar still gets a sliver, so a zero row is visibly a row.
			out.push(`${label} ${paint(glyphs || EIGHTHS[1], barColor, useColor)} ${value}`);
		}
		return out.join("\n");
	}

	/** Column chart: vertical bars, one column per value, on the eighth-block ramp. */
	function column(data, opts) {
		const options = opts ?? {};
		const useColor = colorEnabled(options.color);
		const entries = normalizeLabelled(data);
		if (entries.length === 0) return "";
		const rows = Math.max(2, options.height ?? 10);
		const values = entries.map((e) => e.value).filter(Number.isFinite);
		const max = options.max ?? Math.max(...values, 0);
		const min = options.min ?? Math.min(...values, 0);
		const span = max - min || 1;
		const barColor = options.barColor ?? "cyan";
		const filled = entries.map((e) => Math.round(((e.value - min) / span) * rows * 8));
		const { labels, width } = yAxisLabels(rows, { minY: min, maxY: max }, options.decimals);
		const out = [];
		if (options.title) out.push(paint(options.title, "white", useColor));
		for (let row = 0; row < rows; row++) {
			// Row 0 is the top of the chart, but a column fills from the bottom up.
			const rowFloor = (rows - 1 - row) * 8;
			let text = "";
			for (const eighths of filled) {
				const inRow = eighths - rowFloor;
				if (inRow >= 8) text += paint(FULL_BLOCK, barColor, useColor);
				else if (inRow <= 0) text += " ";
				else text += paint(VERTICAL_EIGHTHS[inRow], barColor, useColor);
			}
			out.push(`${paint(labels[row], "dim", useColor)} ${paint("│", "dim", useColor)}${text}`);
		}
		out.push(`${" ".repeat(width)} ${paint(`└${"─".repeat(entries.length)}`, "dim", useColor)}`);
		// Only single-character labels fit under one-column bars; wider ones are dropped rather
		// than silently misaligning against the columns they name.
		if (options.labels !== false && entries.every((e) => e.label.length <= 1)) {
			out.push(`${" ".repeat(width + 2)}${paint(entries.map((e) => e.label).join(""), "dim", useColor)}`);
		}
		return out.join("\n");
	}

	/**
	 * Candlestick chart, one column per candle: thin wick, solid body, green up / red down.
	 *
	 * Accepts `[{open, high, low, close}, ...]` or `[[o, h, l, c], ...]`.
	 */
	function candle(data, opts) {
		const options = opts ?? {};
		const useColor = colorEnabled(options.color);
		const candles = (data ?? [])
			.map((c) =>
				Array.isArray(c)
					? { open: Number(c[0]), high: Number(c[1]), low: Number(c[2]), close: Number(c[3]) }
					: { open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) },
			)
			.filter(
				(c) =>
					Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close),
			);
		if (candles.length === 0) return "";
		const rows = Math.max(3, options.height ?? 14);
		const max = options.maxY ?? Math.max(...candles.map((c) => c.high));
		const min = options.minY ?? Math.min(...candles.map((c) => c.low));
		const span = max - min || 1;
		const toRow = (value) => (1 - (value - min) / span) * (rows - 1);
		const { labels, width } = yAxisLabels(rows, { minY: min, maxY: max }, options.decimals);
		const out = [];
		if (options.title) out.push(paint(options.title, "white", useColor));
		for (let row = 0; row < rows; row++) {
			let text = "";
			for (const c of candles) {
				const tone = c.close >= c.open ? "green" : "red";
				const bodyTop = toRow(Math.max(c.open, c.close));
				const bodyBottom = toRow(Math.min(c.open, c.close));
				if (row >= Math.floor(bodyTop) && row <= Math.ceil(bodyBottom)) {
					text += paint(FULL_BLOCK, tone, useColor);
					continue;
				}
				if (row >= Math.floor(toRow(c.high)) && row <= Math.ceil(toRow(c.low))) {
					text += paint("│", tone, useColor);
					continue;
				}
				text += " ";
			}
			out.push(`${paint(labels[row], "dim", useColor)} ${paint("│", "dim", useColor)}${text}`);
		}
		out.push(`${" ".repeat(width)} ${paint(`└${"─".repeat(candles.length)}`, "dim", useColor)}`);
		return out.join("\n");
	}

	/** One-line sparkline. Returns a bare string, safe to embed in other output. */
	function spark(values, opts) {
		const options = opts ?? {};
		const useColor = colorEnabled(options.color);
		const nums = (values ?? []).map(Number).filter(Number.isFinite);
		if (nums.length === 0) return "";
		const max = options.max ?? Math.max(...nums);
		const min = options.min ?? Math.min(...nums);
		const span = max - min || 1;
		const top = SPARK_LEVELS.length - 1;
		const text = nums
			.map((v) => SPARK_LEVELS[Math.min(top, Math.max(0, Math.round(((v - min) / span) * top)))])
			.join("");
		return options.barColor ? paint(text, options.barColor, useColor) : text;
	}

	/** Histogram: bucket the values, then draw the bucket counts as columns. */
	function histogram(values, opts) {
		const options = opts ?? {};
		const nums = (values ?? []).map(Number).filter(Number.isFinite);
		if (nums.length === 0) return "";
		const bins = Math.max(1, options.bins ?? 20);
		const max = Math.max(...nums);
		const min = Math.min(...nums);
		const span = max - min || 1;
		const counts = new Array(bins).fill(0);
		for (const v of nums) {
			// The maximum value would land one bucket past the end without the clamp.
			counts[Math.min(bins - 1, Math.floor(((v - min) / span) * bins))] += 1;
		}
		return column(counts, { ...options, labels: false });
	}

	// `chart(...)` is the common case (a line chart); the rest hang off it as named methods.
	return Object.assign(line, { line, scatter, bar, column, candle, spark, histogram, run: line });
}
