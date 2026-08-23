import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderRichDiff, SPLIT_MIN_WIDTH } from "../src/modes/interactive/components/diff.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "./helpers/render.js";

const HALF = SPLIT_MIN_WIDTH / 2;

function textAt(row: string): string {
	return stripAnsi(row);
}

describe("renderRichDiff split view", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		initTheme("dark");
	});

	const diff = ["-3 old line", "+3 new line", " 4 context"].join("\n");

	it("defaults to unified layout", () => {
		const rows = renderRichDiff(diff, 80);
		expect(rows).toHaveLength(3);
		expect(textAt(rows[0]).trim()).toBe("3 - old line");
	});

	it("view auto stays unified below the threshold", () => {
		const rows = renderRichDiff(diff, 100, { view: "auto" });
		expect(rows).toHaveLength(3);
	});

	it("view auto splits at or above the threshold, pairing -/+ rows side by side", () => {
		const rows = renderRichDiff(diff, SPLIT_MIN_WIDTH, { view: "auto" });
		// One paired -/+ row plus one duplicated context row.
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(visibleWidth(row)).toBe(SPLIT_MIN_WIDTH);
		}
		const first = textAt(rows[0]);
		expect(first.slice(0, HALF)).toContain("old line");
		expect(first.slice(HALF)).toContain("new line");
		expect(first.slice(0, HALF)).toContain("3 - ");
		expect(first.slice(HALF)).toContain("3 + ");
	});

	it("unpaired lines get a blank opposite half", () => {
		const unpaired = ["-1 aaaa", "-2 bbbb", "+1 cccc"].join("\n");
		const rows = renderRichDiff(unpaired, SPLIT_MIN_WIDTH, { view: "split" });
		expect(rows).toHaveLength(2);
		const second = textAt(rows[1]);
		expect(second.slice(0, HALF)).toContain("bbbb");
		expect(second.slice(HALF).trim()).toBe("");
	});
});
