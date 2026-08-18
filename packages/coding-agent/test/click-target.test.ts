import { beforeAll, describe, expect, it } from "bun:test";
import { setKeybindings, urlAtColumn, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	clickToToggle,
	collapseChevron,
	isCollapsible,
	parseToggleTarget,
	setClickTargetsEnabled,
} from "../src/modes/interactive/components/click-target.js";
import { toolPanelLine } from "../src/modes/interactive/components/tool-panel.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	// Links are only emitted in fullscreen mouse mode.
	setClickTargetsEnabled(true);
});

describe("click targets", () => {
	it("round-trips a toggle id through an OSC 8 link", () => {
		const url = parseToggleTarget("pi-toggle://tool%3Acall_42");
		expect(url).toBe("tool:call_42");
	});

	it("ignores foreign URLs so real hyperlinks still open", () => {
		expect(parseToggleTarget("https://example.com")).toBeNull();
	});

	it("adds no visible width beyond the chevron", () => {
		const plain = `${collapseChevron(false)} bash`;
		expect(visibleWidth(clickToToggle(plain, "tool:x"))).toBe(visibleWidth(plain));
	});

	it("resolves the target from a click column inside a rendered tool panel header", () => {
		const header = `${clickToToggle(`${collapseChevron(false)} bash`, "tool:call_42")} · done`;
		const line = toolPanelLine(header, 60);
		// The two leading columns are panel padding, the chevron and label follow.
		expect(urlAtColumn(line, 1)).toBeNull();
		expect(parseToggleTarget(urlAtColumn(line, 2) ?? "")).toBe("tool:call_42");
		expect(parseToggleTarget(urlAtColumn(line, 7) ?? "")).toBe("tool:call_42");
		// The status suffix is outside the clickable region.
		expect(urlAtColumn(line, 9)).toBeNull();
	});

	it("survives truncation to a narrow panel", () => {
		const header = clickToToggle(`${collapseChevron(true)} a-very-long-tool-name`, "tool:call_7");
		expect(parseToggleTarget(urlAtColumn(toolPanelLine(header, 10), 2) ?? "")).toBe("tool:call_7");
	});

	it("duck-types collapsible blocks", () => {
		expect(isCollapsible({ toggleTargetId: "x", toggleExpandedSelf: () => {} })).toBe(true);
		expect(isCollapsible({ toggleTargetId: "x" })).toBe(false);
	});
});

describe("click targets outside fullscreen mouse mode", () => {
	it("emits a plain glyph so the terminal never sees the private scheme", () => {
		setClickTargetsEnabled(false);
		try {
			expect(clickToToggle("▸ bash", "tool:x")).toBe("▸ bash");
			expect(collapseChevron(false, "tool:x")).toBe("▸");
		} finally {
			setClickTargetsEnabled(true);
		}
	});
});
