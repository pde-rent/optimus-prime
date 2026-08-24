import { beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentRow } from "../src/modes/interactive/components/subagent-row.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import stripAnsi from "../src/utils/ansi.js";

describe("subagent row status glyphs", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a force-stopped child with the halt marker in warning tone, never as success", () => {
		const line = renderSubagentRow({ name: "worker", task: "", status: "cancelled" }, 60);
		expect(line).toContain(theme.fg("warning", "\u25a0"));
		expect(stripAnsi(line)).toContain("\u25a0");
		expect(stripAnsi(line)).not.toContain("\u2713");
	});

	it("keeps the shared checkmark for completed children", () => {
		const line = renderSubagentRow({ name: "worker", task: "", status: "completed" }, 60);
		expect(stripAnsi(line)).toContain("\u2713");
	});
});
