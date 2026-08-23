import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class StaticComponent implements Component {
	constructor(private readonly lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** compositeOverlays is private; tests reach it through a structural cast. */
function composite(tui: TUI, lines: string[], width: number, height: number): string[] {
	return (
		tui as unknown as {
			compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[];
		}
	).compositeOverlays(lines, width, height);
}

const DIM = "\x1b[2m";

describe("overlay backdrop dimming", () => {
	it("dims base content behind a dimBackdrop overlay but not the overlay itself", () => {
		const tui = new TUI(new VirtualTerminal(40, 10));
		tui.showOverlay(new StaticComponent(["[POPUP]"]), {
			width: 10,
			maxHeight: "100%",
			anchor: "top-left",
			row: 0,
			col: 0,
			dimBackdrop: true,
		});

		const result = composite(tui, ["base one", "base two", "base three"], 40, 10);

		assert.ok(result[0]?.includes("[POPUP]"), "overlay composited on top");
		assert.ok(!result[0]?.startsWith(DIM), "the overlay line itself is not dimmed");
		assert.strictEqual(result[2], `${DIM}base three\x1b[22m`);
	});

	it("leaves the backdrop untouched without dimBackdrop", () => {
		const tui = new TUI(new VirtualTerminal(40, 10));
		tui.showOverlay(new StaticComponent(["[POPUP]"]), {
			width: 10,
			maxHeight: "100%",
			anchor: "top-left",
			row: 0,
			col: 0,
		});

		const result = composite(tui, ["base one", "", "base three"], 40, 10);
		const anyDim = result.some((line) => line.includes(DIM));

		assert.ok(!anyDim, `no faint codes expected: ${JSON.stringify(result)}`);
	});
});
