import assert from "node:assert";
import { describe, it } from "node:test";
import { eastAsianWidth } from "../src/east-asian-width.js";

// Guards the vendored table that replaced `get-east-asian-width`. The table was
// diffed against that package for every code point before it was removed; these
// cases pin the categories and boundaries most likely to rot.
describe("eastAsianWidth", () => {
	it("treats ASCII and Latin as narrow", () => {
		for (const cp of [0x00, 0x20, 0x41, 0x7e, 0xe9, 0x2ff]) {
			assert.strictEqual(eastAsianWidth(cp), 1, `U+${cp.toString(16)}`);
		}
	});

	it("treats CJK ideographs, kana and Hangul as wide", () => {
		for (const cp of [0x4e00, 0x9fff, 0x3042, 0x30a2, 0xac00, 0xd7a3, 0x1100, 0x115f]) {
			assert.strictEqual(eastAsianWidth(cp), 2, `U+${cp.toString(16)}`);
		}
	});

	it("treats fullwidth forms as wide and halfwidth forms as narrow", () => {
		assert.strictEqual(eastAsianWidth(0x3000), 2); // ideographic space
		assert.strictEqual(eastAsianWidth(0xff21), 2); // fullwidth A
		assert.strictEqual(eastAsianWidth(0xff61), 1); // halfwidth ideographic full stop
		assert.strictEqual(eastAsianWidth(0xffe6), 2); // fullwidth won sign
		assert.strictEqual(eastAsianWidth(0xffe8), 1); // halfwidth forms light vertical
	});

	it("treats wide emoji and supplementary planes correctly", () => {
		assert.strictEqual(eastAsianWidth(0x1f600), 2); // grinning face
		// Regional indicators are EAW=Neutral; utils.ts widens them separately.
		assert.strictEqual(eastAsianWidth(0x1f1e6), 1);
		assert.strictEqual(eastAsianWidth(0x20000), 2); // CJK ext B
		assert.strictEqual(eastAsianWidth(0x1d400), 1); // math bold capital A
		assert.strictEqual(eastAsianWidth(0x10ffff), 1);
	});

	it("treats ambiguous width as narrow", () => {
		assert.strictEqual(eastAsianWidth(0x00a1), 1); // inverted exclamation
		assert.strictEqual(eastAsianWidth(0x2010), 1); // hyphen
		assert.strictEqual(eastAsianWidth(0x25a0), 1); // black square
	});

	it("keeps range boundaries exclusive", () => {
		assert.strictEqual(eastAsianWidth(0x10ff), 1);
		assert.strictEqual(eastAsianWidth(0x1100), 2);
		assert.strictEqual(eastAsianWidth(0x115f), 2);
		assert.strictEqual(eastAsianWidth(0x1160), 1);
		assert.strictEqual(eastAsianWidth(0x2329), 2);
		assert.strictEqual(eastAsianWidth(0x232b), 1);
	});
});
