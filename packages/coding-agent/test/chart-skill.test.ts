import { describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import createSkill from "../skills/chart/skill.js";

/** The pyplot facade surface these tests exercise; the bundled skill itself is plain JS. */
interface ChartPlt {
	show(): string;
	[method: string]: (...args: unknown[]) => unknown;
}

/** The callable chart function plus its pyplot facade. */
interface Chart {
	(data: number[], opts?: Record<string, unknown>): string;
	bar(data: number[], opts?: Record<string, unknown>): string;
	spark(data: number[]): string;
	line(
		data: number[] | readonly (number[] | { name: string; data: number[] })[],
		opts?: Record<string, unknown>,
	): string;
	plt: ChartPlt;
	pyplot: ChartPlt;
}

/** A fresh skill instance per test: the pyplot figure is per-instance state. */
function makeChart(): Chart {
	return createSkill({ cwd: process.cwd(), env: process.env, display: () => {}, hostRequest: async () => ({}) });
}

/** The pyplot surface, plus a `render` that always yields a plain string. */
function makePlt(): { plt: ChartPlt; render: () => string } {
	const plt = makeChart().plt;
	return { plt, render: () => String(plt.show()) };
}

describe("chart(data, opts) — the pre-existing surface", () => {
	// Pinned verbatim: this call is documented and other skills reach for it, so the pyplot
	// facade added beside it must not have moved a single cell of its output.
	it("renders a line chart byte-for-byte as before", () => {
		const chart = makeChart();
		expect(chart([3, 1, 4, 1, 5, 9, 2, 6], { width: 40, height: 8, color: false })).toBe(
			"       │                     ⢀⠞⡄\n" +
				"      8┤                    ⢠⠊ ⢱\n" +
				"       │                   ⡠⠃   ⢇\n" +
				"      6┤                  ⡰⠁    ⠘⡄    ⢀⠎\n" +
				"      4┤         ⡀       ⡜       ⢱   ⢠⠊\n" +
				"       │⡀      ⢀⠎⠘⢄    ⢀⠜         ⢇ ⡠⠃\n" +
				"      2┤⠈⠢⣀   ⡰⠁   ⠣⡀ ⢀⠎          ⠘⡴⠁\n" +
				"       │   ⠑⢄⠎      ⠘⢄⠎",
		);
	});

	it("renders bars and sparklines as before", () => {
		const chart = makeChart();
		expect(chart.bar([41, 118, 77], { width: 40, height: 6, color: false })).toBe(
			"       │           ██████████\n" +
				"    100┤           ██████████\n" +
				"     80┤           ██████████\n" +
				"       │           ██████████ ██████████\n" +
				"     60┤           ██████████ ██████████\n" +
				"       │██████████ ██████████ ██████████",
		);
		expect(chart.spark([1, 5, 2, 8, 3])).toBe("▁▅▁█▂");
	});

	it("still returns a primitive string, not the pyplot wrapper", () => {
		expect(typeof makeChart()([1, 2, 3], { color: false })).toBe("string");
	});

	it("exposes pyplot under both names, on the same figure", () => {
		const chart = makeChart();
		expect(chart.plt).toBe(chart.pyplot);
	});
});

describe("plt.plot", () => {
	it("takes plot(y) with x implied as the index", () => {
		const { plt, render } = makePlt();
		plt.plot([0, 5, 10]);
		// The x axis is labelled from the implied indices, so 0..2 rather than the values.
		expect(render()).toContain("0");
	});

	it("gives plot(y) and plot(x, y) the same chart when x is the index", () => {
		const a = makePlt();
		a.plt.plot([3, 1, 4, 1, 5]);
		const implied = a.render();

		const b = makePlt();
		b.plt.plot([0, 1, 2, 3, 4], [3, 1, 4, 1, 5]);
		expect(b.render()).toBe(implied);
	});

	it("shifts the chart when x is not the index", () => {
		const a = makePlt();
		a.plt.plot([3, 1, 4]);
		const b = makePlt();
		b.plt.plot([100, 200, 300], [3, 1, 4]);
		expect(b.render()).not.toBe(a.render());
	});

	it("draws every series accumulated before one show()", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3, 4]);
		plt.plot([4, 3, 2, 1]);
		plt.plot([2, 2, 2, 2]);
		plt.legend(["up", "down", "flat"]);
		const out = render();
		expect(out).toContain("up");
		expect(out).toContain("down");
		expect(out).toContain("flat");
	});

	it("reads a trailing format string as the format, not as data", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 4, 2, 8], "r-");
		expect(render()).toContain("┤");
	});

	it("draws a marker format with no line style as a scatter", () => {
		const line = makePlt();
		line.plt.plot([1, 4, 2, 8], [1, 4, 2, 8], "b-");
		const points = makePlt();
		points.plt.plot([1, 4, 2, 8], [1, 4, 2, 8], "bo");
		expect(points.render()).not.toBe(line.render());
	});

	it("rejects an unknown format character", () => {
		const { plt } = makePlt();
		expect(() => plt.plot([1, 2], "zz")).toThrow(TypeError);
	});
});

describe("plt labelling", () => {
	it("lands every labelling call in the output", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3], [4, 9, 2]);
		plt.title("TITLE_MARK");
		plt.xlabel("XLABEL_MARK");
		plt.ylabel("YLABEL_MARK");
		plt.legend(["SERIES_MARK"]);
		plt.grid(true);
		const out = render();
		expect(out).toContain("TITLE_MARK");
		expect(out).toContain("XLABEL_MARK");
		expect(out).toContain("YLABEL_MARK");
		expect(out).toContain("SERIES_MARK");
	});

	it("puts the title above the plot and the x label below it", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		plt.title("TOP");
		plt.xlabel("BOTTOM");
		const lines = render().split("\n");
		expect(lines[0]).toContain("TOP");
		expect(lines[lines.length - 1]).toContain("BOTTOM");
	});

	it("draws no legend until legend() asks for one", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		expect(render()).not.toContain("─ ");
	});

	it("clamps the y axis to ylim", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		plt.ylim(0, 100);
		expect(render()).toContain("100");
	});

	it("drops points outside xlim", () => {
		const { plt, render } = makePlt();
		plt.plot([0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 500]);
		plt.xlim([0, 4]);
		expect(render()).not.toContain("500");
	});

	it("rejects an inverted limit pair", () => {
		const { plt } = makePlt();
		expect(() => plt.xlim(5, 1)).toThrow(TypeError);
	});

	it("rejects a non-string label", () => {
		const { plt } = makePlt();
		expect(() => plt.title(42)).toThrow(TypeError);
	});
});

describe("plt state", () => {
	// The failure this guards: a figure that outlives its show() silently merges into the next
	// chart, and nothing in the output says so.
	it("does not carry a series into the next chart", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		plt.legend(["FIRST"]);
		expect(render()).toContain("FIRST");

		plt.plot([3, 2, 1]);
		plt.legend(["SECOND"]);
		const second = render();
		expect(second).toContain("SECOND");
		expect(second).not.toContain("FIRST");
	});

	it("does not carry a title, axis label or limit into the next chart", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		plt.title("STALE");
		plt.xlabel("STALE_X");
		plt.ylim(0, 1000);
		render();

		plt.plot([1, 2, 3]);
		const second = render();
		expect(second).not.toContain("STALE");
		expect(second).not.toContain("1000");
	});

	it("produces the same chart twice from the same calls", () => {
		const { plt, render } = makePlt();
		plt.plot([3, 1, 4, 1, 5]);
		plt.title("same");
		const first = render();
		plt.plot([3, 1, 4, 1, 5]);
		plt.title("same");
		expect(render()).toBe(first);
	});

	it("discards a figure on clf() without rendering it", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		plt.title("DROPPED");
		plt.clf();
		plt.plot([1, 2, 3]);
		expect(render()).not.toContain("DROPPED");
	});

	it("starts clean on figure(), recovering an abandoned figure", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		plt.title("ABANDONED");
		plt.figure({ width: 40, height: 6 });
		plt.plot([1, 2, 3]);
		const out = render();
		expect(out).not.toContain("ABANDONED");
		expect(out.split("\n")).toHaveLength(8);
	});

	it("refuses to show an empty figure rather than drawing a blank one", () => {
		const { plt } = makePlt();
		expect(() => plt.show()).toThrow(/nothing to draw/);
	});
});

describe("plt.show()", () => {
	it("renders as the chart itself when inspected, so a bare show() prints", async () => {
		const { inspect } = await import("node:util");
		const { plt } = makePlt();
		plt.plot([1, 2, 3]);
		plt.title("INSPECTED");
		const shown = plt.show();
		// The REPL echoes a cell's value through util.inspect; a primitive string would come
		// back JSON-escaped onto one line.
		expect(inspect(shown, { depth: 4, maxStringLength: 10_000, breakLength: 120, colors: false })).toContain(
			"INSPECTED",
		);
		expect(inspect(shown, { depth: 4 }).split("\n").length).toBeGreaterThan(3);
	});

	it("behaves as a string", () => {
		const { plt } = makePlt();
		plt.plot([1, 2, 3]);
		plt.title("STRINGY");
		const shown = plt.show();
		expect(typeof String(shown)).toBe("string");
		expect(shown.includes("STRINGY")).toBe(true);
		expect(`${shown}`.split("\n").length).toBeGreaterThan(3);
	});
});

describe("plt marks", () => {
	it("renders a histogram of the values", () => {
		const { plt, render } = makePlt();
		plt.hist([1, 2, 2, 3, 3, 3, 4, 4, 5], 5);
		const out = render();
		expect(out).toContain("█");
		expect(out.split("\n").length).toBeGreaterThan(5);
	});

	it("defaults hist to 10 bins", () => {
		const explicit = makePlt();
		explicit.plt.hist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
		const auto = makePlt();
		auto.plt.hist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(auto.render()).toBe(explicit.render());
	});

	it("renders bars", () => {
		const { plt, render } = makePlt();
		plt.bar([0, 1, 2], [41, 118, 77]);
		expect(render()).toContain("█");
	});

	it("points at barh when bar() is given category labels", () => {
		const { plt } = makePlt();
		expect(() => plt.bar(["a", "b"], [1, 2])).toThrow(/barh/);
	});

	it("prints the label beside each horizontal bar", () => {
		const { plt, render } = makePlt();
		plt.barh(["alpha", "beta"], [12, 47]);
		const out = render();
		expect(out).toContain("alpha");
		expect(out).toContain("beta");
		expect(out).toContain("47");
	});

	it("renders a scatter differently from a line", () => {
		const line = makePlt();
		line.plt.plot([1, 2, 3, 4, 5], [2, 5, 3, 8, 4]);
		const points = makePlt();
		points.plt.scatter([1, 2, 3, 4, 5], [2, 5, 3, 8, 4]);
		expect(points.render()).not.toBe(line.render());
	});

	it("renders a step as a staircase, not a straight line", () => {
		const line = makePlt();
		line.plt.plot([1, 2, 3, 4], [1, 3, 2, 6]);
		const stepped = makePlt();
		stepped.plt.step([1, 2, 3, 4], [1, 3, 2, 6]);
		expect(stepped.render()).not.toBe(line.render());
	});

	it("refuses to mix barh with a line series", () => {
		const { plt } = makePlt();
		plt.plot([1, 2, 3]);
		expect(() => plt.barh(["a"], [1])).toThrow(TypeError);
	});
});

describe("plt argument errors", () => {
	it("throws on mismatched x and y lengths rather than truncating", () => {
		const { plt } = makePlt();
		expect(() => plt.plot([1, 2, 3], [1, 2])).toThrow(TypeError);
		expect(() => plt.plot([1, 2, 3], [1, 2])).toThrow(/length 3.*length 2/);
	});

	it("throws on mismatched lengths for scatter, bar and barh too", () => {
		const { plt } = makePlt();
		expect(() => plt.scatter([1, 2, 3], [1, 2])).toThrow(TypeError);
		expect(() => plt.bar([1, 2, 3], [1, 2])).toThrow(TypeError);
		expect(() => plt.barh(["a", "b", "c"], [1, 2])).toThrow(TypeError);
	});

	it("throws when a value is not a finite number", () => {
		const { plt } = makePlt();
		expect(() => plt.plot([1, 2, 3], [1, "x", 3])).toThrow(TypeError);
		expect(() => plt.plot([1, Number.NaN])).toThrow(TypeError);
	});

	it("throws when the data is not an array", () => {
		const { plt } = makePlt();
		expect(() => plt.plot(5)).toThrow(TypeError);
		expect(() => plt.hist([])).toThrow(TypeError);
		expect(() => plt.hist([1, 2, 3], 0)).toThrow(TypeError);
	});

	it("names the replacement for the calls a terminal cannot serve", () => {
		const { plt } = makePlt();
		expect(() => plt.savefig("out.png")).toThrow(/write\(path/);
		expect(() => plt.subplot(2, 1)).toThrow(/one chart per show/);
		expect(() => plt.subplots(2, 1)).toThrow(/one chart per show/);
	});
});

// The transcript that prompted these: a model wrote plot(x, y, { label: name }) — the single most
// common way to name a series in matplotlib — and got a TypeError pointing it at legend([...]).
describe("plt.plot options", () => {
	it("names a series from { label }, the way label= does in matplotlib", () => {
		const { plt, render } = makePlt();
		plt.plot([0, 1, 2], [3, 1, 4], { label: "Ethereum" });
		expect(render()).toContain("─ Ethereum");
	});

	it("keeps the fmt string form, and takes both together", () => {
		const { plt, render } = makePlt();
		plt.plot([0, 1, 2], [3, 1, 4], "r-");
		expect(render()).toContain("┤");

		const both = makePlt();
		both.plt.plot([0, 1, 2], [3, 1, 4], "r-", { label: "Solana" });
		expect(both.render()).toContain("─ Solana");
	});

	it("takes the options object with x implied, and with no fmt", () => {
		const { plt, render } = makePlt();
		plt.plot([3, 1, 4], { label: "BSC" });
		expect(render()).toContain("─ BSC");
	});

	it("lets legend([...]) override a plot-time label positionally and leave the rest", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3], { label: "first" });
		plt.plot([3, 2, 1], { label: "second" });
		plt.legend(["OVERRIDDEN"]);
		const out = render();
		expect(out).toContain("OVERRIDDEN");
		expect(out).not.toContain("first");
		expect(out).toContain("second");
	});

	it("still draws no legend for a series nobody named", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3]);
		expect(render()).not.toContain("─ ");
	});

	it("names a series on scatter, step and bar too", () => {
		for (const call of ["scatter", "step", "bar"] as const) {
			const { plt, render } = makePlt();
			plt[call]([0, 1, 2], [3, 1, 4], { label: `${call}_MARK` });
			expect(render()).toContain(`${call}_MARK`);
		}
	});

	it("refuses an option it cannot honour instead of dropping it", () => {
		const { plt } = makePlt();
		expect(() => plt.plot([1, 2], { linewidth: 3 })).toThrow(/unknown option "linewidth"/);
		expect(() => plt.plot([1, 2], { linewidth: 3 })).toThrow(/label, color/);
	});
});

// "red-" was rejected for having an "e" in it. matplotlib takes named colours, and the renderer
// has eight of them, so refusing the name was the facade being narrower than what it wraps.
describe("plt colours", () => {
	it("takes a colour name in the fmt string", () => {
		const named = makePlt();
		named.plt.plot([1, 4, 2, 8], "red-");
		const lettered = makePlt();
		lettered.plt.plot([1, 4, 2, 8], "r-");
		expect(named.render()).toBe(lettered.render());
	});

	it("takes color as an option, by name or by letter", () => {
		const { plt } = makePlt();
		expect(() => plt.plot([1, 2, 3], { color: "green", label: "g" })).not.toThrow();
		expect(() => plt.plot([1, 2, 3], { color: "k", label: "k" })).not.toThrow();
		expect(() => plt.plot([1, 2, 3], { color: "GREY", label: "grey" })).not.toThrow();
		expect(String(plt.show())).toContain("─ grey");
	});

	it("puts the colour on the line, so ANSI output differs by colour", () => {
		const red = makePlt();
		red.plt.figure({ color: true });
		red.plt.plot([1, 4, 2, 8], { color: "red" });
		const blue = makePlt();
		blue.plt.figure({ color: true });
		blue.plt.plot([1, 4, 2, 8], { color: "blue" });
		const drawn = red.render();
		expect(drawn).not.toBe(blue.render());
		expect(drawn).toContain("\x1b[31m");
	});

	it("refuses a colour the renderer has no ink for, and names the ones it has", () => {
		const { plt } = makePlt();
		expect(() => plt.plot([1, 2], { color: "orange" })).toThrow(TypeError);
		expect(() => plt.plot([1, 2], { color: "orange" })).toThrow(
			/blue, green, red, cyan, magenta, yellow, white, gray/,
		);
		expect(() => plt.plot([1, 2], "#ff0000")).toThrow(TypeError);
		expect(() => plt.plot([1, 2], "zz")).toThrow(/unknown character/);
	});
});

// The transcript's chart: ten chains, a legend cut mid-word at "─ Solan", four series with no
// entry at all, and a model left writing "a couple chains share line styles" as a guess.
describe("legend with more series than the renderer can distinguish", () => {
	const CHAINS = [
		"Ethereum",
		"Solana",
		"BSC",
		"Bitcoin",
		"Tron",
		"Base",
		"Arbitrum",
		"Hyperliquid",
		"Sui",
		"Avalanche",
	];

	/** Ten series of eight points, as percent change from the first day — the transcript's shape. */
	function tenSeries(plt: ChartPlt, opts?: Record<string, unknown>) {
		if (opts) plt.figure(opts);
		for (const [i, name] of CHAINS.entries()) {
			const base = 100 + i * 30;
			const week = Array.from({ length: 8 }, (_, d) => base * (1 + Math.sin(d / 2 + i) / 12));
			plt.plot(
				week.map((_, d) => d),
				week.map((v) => ((v - week[0]!) / week[0]!) * 100),
				{ label: name },
			);
		}
	}

	it("gives every one of ten series a whole legend entry", () => {
		const { plt, render } = makePlt();
		tenSeries(plt);
		const out = render();
		for (const name of CHAINS) expect(out).toContain(`─ ${name}`);
		// The library's own legend stopped after six entries and cut the sixth; nothing may be
		// left as a prefix of the name it stands for.
		expect(out).not.toContain("─ Solan\n");
		expect(out).not.toContain("─ Avalanch\n");
	});

	it("wraps the legend instead of running past the figure width", () => {
		const { plt, render } = makePlt();
		tenSeries(plt, { width: 64, height: 14 });
		const legend = render()
			.split("\n")
			.filter((l) => l.includes("─ "));
		expect(legend.length).toBeGreaterThan(1);
		for (const l of legend) expect(l.length).toBeLessThanOrEqual(64);
	});

	it("says how many series drew, so nothing has to be guessed at", () => {
		const { plt, render } = makePlt();
		tenSeries(plt);
		expect(render()).toContain("all 10 series drew");
	});

	it("names the series that reuse a colour once the palette runs out", () => {
		const { plt, render } = makePlt();
		tenSeries(plt, { color: true });
		const out = render();
		expect(out).toContain("all 10 series drew");
		expect(out).toContain("8 colours");
		expect(out).toContain("Sui, Avalanche");
	});

	it("says plainly that colourless output cannot tell two curves apart", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3], { label: "p50" });
		plt.plot([2, 3, 4], { label: "p99" });
		expect(render()).toContain("no colour");
	});

	it("keeps quiet about a single series", () => {
		const { plt, render } = makePlt();
		plt.plot([1, 2, 3], { label: "only" });
		expect(render()).not.toContain("note:");
	});

	it("wraps the native named-series legend the same way", () => {
		const chart = makeChart();
		const out = chart.line(
			CHAINS.map((name, i) => ({ name, data: [i, i + 1, i + 2] })),
			{ width: 64, height: 10, color: false },
		);
		for (const name of CHAINS) expect(out).toContain(`─ ${name}`);
		expect(out).toContain("all 10 series drew");
	});
});

// @crafter/charts has no title field, so `chart(data, { title })` dropped it silently for as
// long as the option has been documented. A no-op option is worse than an absent one.
describe("native title option", () => {
	it("renders the title instead of ignoring it", () => {
		const chart = makeChart();
		const withTitle = chart.line([1, 5, 3], { title: "tvl $B", width: 40, height: 6 });
		const without = chart.line([1, 5, 3], { width: 40, height: 6 });
		expect(withTitle).toContain("tvl $B");
		expect(without).not.toContain("tvl $B");
		// Only a title line is added; the plot body is untouched.
		expect(withTitle.split("\n").slice(1).join("\n")).toBe(without);
	});
});
