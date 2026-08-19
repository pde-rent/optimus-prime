import { existsSync } from "fs";
import { describe, expect, it } from "vitest";
import { IGNITION_DURATION_MS, ignitionRowColor, ignitionSoundPath } from "../src/modes/interactive/ignition.js";

const ROWS = 18;

describe("ignition", () => {
	it("ships the sound with the package", () => {
		const path = ignitionSoundPath();
		expect(path).toBeDefined();
		expect(existsSync(path!)).toBe(true);
	});

	it("leaves the art alone before and after the animation", () => {
		// undefined is the signal to keep the ordinary theme colour, so the mark can never be left
		// stranded in laser red if the effect is skipped or finishes.
		expect(ignitionRowColor(0, ROWS, -1)).toBeUndefined();
		expect(ignitionRowColor(0, ROWS, IGNITION_DURATION_MS)).toBeUndefined();
		expect(ignitionRowColor(0, ROWS, IGNITION_DURATION_MS + 1000)).toBeUndefined();
	});

	it("paints every row while running, so the silhouette never breaks up", () => {
		for (let row = 0; row < ROWS; row++) {
			expect(ignitionRowColor(row, ROWS, 1000)).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it("moves the beam down the mark over time", () => {
		const brightest = (t: number) => {
			let best = 0;
			let bestRow = 0;
			for (let row = 0; row < ROWS; row++) {
				const value = Number.parseInt(ignitionRowColor(row, ROWS, t)!.slice(1, 3), 16);
				if (value > best) {
					best = value;
					bestRow = row;
				}
			}
			return bestRow;
		};
		expect(brightest(1200)).toBeGreaterThan(brightest(300));
	});

	it("survives a degenerate mark rather than dividing by zero", () => {
		expect(ignitionRowColor(0, 0, 100)).toBeUndefined();
	});
});
