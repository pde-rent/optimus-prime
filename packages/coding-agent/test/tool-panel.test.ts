import { beforeAll, describe, expect, it } from "bun:test";
import stripAnsi from "strip-ansi";
import { toolPanelLine } from "../src/modes/interactive/components/tool-panel.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const ANSI_RESET = "\x1b[0m";

/** Opening sequence theme.bg emits for the tool panel background. */
function panelBgOpen(): string {
	return theme.bg("toolPanelBg", "").replace("\x1b[49m", "");
}

describe("toolPanelLine", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("re-opens the panel background after a reset embedded in tool output", () => {
		const line = toolPanelLine(`before${ANSI_RESET}after`, 40);

		expect(stripAnsi(line)).toBe(`  beforeafter${" ".repeat(25)}  `);

		const spans = line.split(ANSI_RESET);
		expect(spans).toHaveLength(2);
		for (const span of spans) {
			expect(span.startsWith(panelBgOpen())).toBe(true);
		}
		// The padding that follows the reset is what would otherwise render on the
		// terminal default background and break the block.
		expect(spans[1]).toContain(" ".repeat(25));
	});

	it("leaves reset-free output on a single background span", () => {
		const line = toolPanelLine("plain", 20);

		expect(line).not.toContain(ANSI_RESET);
		expect(line.startsWith(panelBgOpen())).toBe(true);
		expect(stripAnsi(line)).toBe(`  plain${" ".repeat(11)}  `);
	});
});
