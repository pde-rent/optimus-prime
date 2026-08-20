import { describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import createSkill from "../skills/chart/skill.js";

/** A fresh skill instance per test: the pyplot figure is per-instance state. */
function makeChart(): any {
	return createSkill({ cwd: process.cwd(), env: process.env, display: () => {}, hostRequest: async () => ({}) });
}

/** The pyplot surface, plus a `render` that always yields a plain string. */
function makePlt(): { plt: any; render: () => string } {
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
