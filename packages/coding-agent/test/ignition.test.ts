import { describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import {
	IGNITION_DURATION_MS,
	IGNITION_EYES,
	ignitionCellColor,
	ignitionSoundPath,
} from "../src/modes/interactive/ignition.js";
import { OPTIMUS_LOGO } from "../src/themes/optimus-logo.js";

const [EYE] = IGNITION_EYES;
const MID = IGNITION_DURATION_MS / 2;

describe("ignition", () => {
	it("ships the sound with the package", () => {
		const path = ignitionSoundPath();
		expect(path).toBeDefined();
		expect(existsSync(path!)).toBe(true);
	});

	it("puts both eyes on ink rather than on blank cells", () => {
		const rows = OPTIMUS_LOGO.split("\n");
		for (const [row, col] of IGNITION_EYES) {
			const cell = [...(rows[row] ?? "")][col];
			expect(cell).toBeDefined();
			// U+2800 is blank braille: an eye there would glow in empty space beside the mark.
			expect(cell).not.toBe("⠀");
			expect(cell).not.toBe(" ");
		}
	});

	it("lights the eyes", () => {
		expect(ignitionCellColor(EYE![0], EYE![1], MID)).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("lights the eye cells and nothing else", () => {
		// The whole point: two lit cells. Any beam at this scale reads as a red band drawn across
		// the face rather than as eyes lighting up.
		const rows = OPTIMUS_LOGO.split("\n");
		let lit = 0;
		for (let row = 0; row < rows.length; row++) {
			for (let col = 0; col < [...rows[row]!].length; col++) {
				if (ignitionCellColor(row, col, MID)) lit++;
			}
		}
		expect(lit).toBe(IGNITION_EYES.length);
	});

	it("stays lit for the whole run, breathing between two reds", () => {
		const [row, col] = EYE!;
		const seen = new Set<string>();
		for (let t = 0; t < IGNITION_DURATION_MS; t += 50) {
			const color = ignitionCellColor(row, col, t);
			// Never dark mid-run: a gap would read as a flicker, not a glow.
			expect(color).toBeDefined();
			seen.add(color!);
		}
		expect(seen.size).toBe(2);
	});

	it("leaves the art alone before and after the animation", () => {
		const [row, col] = EYE!;
		expect(ignitionCellColor(row, col, -1)).toBeUndefined();
		expect(ignitionCellColor(row, col, IGNITION_DURATION_MS)).toBeUndefined();
		expect(ignitionCellColor(row, col, IGNITION_DURATION_MS + 1000)).toBeUndefined();
	});
});
