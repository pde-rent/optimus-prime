import { describe, expect, it } from "bun:test";
import { reverseVideo, withVerticalPadding } from "../src/utils.js";

describe("reverseVideo", () => {
	it("wraps content in reverse-video SGR with the standard reset", () => {
		expect(reverseVideo("ab")).toBe("\x1b[7mab\x1b[27m");
	});
});

describe("withVerticalPadding", () => {
	it("pads top and bottom with blank rows of the given width", () => {
		expect(withVerticalPadding(["x"], 3, 1)).toEqual([" ".repeat(3), "x", " ".repeat(3)]);
	});
	it("applies the background function to padding rows", () => {
		const bg = (t: string) => `B(${t})`;
		expect(withVerticalPadding(["x"], 2, 1, bg)).toEqual(["B(  )", "x", "B(  )"]);
	});
});
