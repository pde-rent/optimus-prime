import { describe, expect, it } from "bun:test";
import { type Component, type Focusable, type OverlayHandle, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { CenteredOverlayComponent, showFullPaneOverlay } from "../src/modes/interactive/components/centered-overlay.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import stripAnsi from "../src/utils/ansi.js";

class TestComponent implements Component, Focusable {
	focused = false;
	readonly inputs: string[] = [];

	invalidate(): void {}

	render(width: number): string[] {
		return [`content ${width}`, "second row"];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

describe("CenteredOverlayComponent", () => {
	it("centers content and fills the full pane width and height", () => {
		const component = new CenteredOverlayComponent(new TestComponent(), {
			getRows: () => 6,
			maxContentWidth: 12,
		});

		const lines = component.render(20);

		expect(lines).toHaveLength(6);
		expect(lines[0]?.trim()).toBe("");
		expect(lines[1]?.trim()).toBe("");
		expect(lines[2]).toContain("content 12");
		expect(lines[3]).toContain("second row");
		expect(lines[4]?.trim()).toBe("");
		expect(lines[5]?.trim()).toBe("");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(20);
		}
	});

	it("forwards focus and input to the wrapped component", () => {
		const inner = new TestComponent();
		const component = new CenteredOverlayComponent(inner, {
			getRows: () => 1,
		});

		component.focused = true;
		component.handleInput("x");

		expect(inner.focused).toBe(true);
		expect(inner.inputs).toEqual(["x"]);
	});

	it("uses the full terminal width when requested", () => {
		let overlay: Component | undefined;
		const ui = {
			terminal: { rows: 1 },
			showOverlay: (component: Component) => {
				overlay = component;
				return {} as OverlayHandle;
			},
		} as unknown as TUI;

		showFullPaneOverlay(ui, new TestComponent(), { fullWidth: true });

		expect(overlay?.render(120)[0]).toContain("content 120");
	});
});

describe("layered modal dimming", () => {
	initTheme("dark");

	function createTestTui(): { ui: TUI; components: Component[]; handles: OverlayHandle[] } {
		const components: Component[] = [];
		const handles: OverlayHandle[] = [];
		const ui = {
			terminal: { rows: 10 },
			showOverlay: (component: Component) => {
				components.push(component);
				handles.push({
					hide: () => {},
					setHidden: () => {},
					isHidden: () => false,
					focus: () => {},
					unfocus: () => {},
					isFocused: () => false,
				});
				return handles[handles.length - 1]!;
			},
		} as unknown as TUI;
		return { ui, components, handles };
	}

	it("shows sized dialogs as centered overlays with a dimmed backdrop", () => {
		let options: Record<string, unknown> | undefined;
		const ui = {
			terminal: { rows: 10 },
			showOverlay: (_component: Component, overlayOptions: Record<string, unknown>) => {
				options = overlayOptions;
				return {} as OverlayHandle;
			},
		} as unknown as TUI;

		showFullPaneOverlay(ui, new TestComponent(), 80);

		expect(options).toMatchObject({ width: 80, anchor: "center", dimBackdrop: true });
	});

	it("renders sized dialogs undimmed while they are the topmost layer", () => {
		const { ui, components } = createTestTui();

		showFullPaneOverlay(ui, new TestComponent(), 80);

		for (const line of components[0]!.render(80)) {
			expect(line.startsWith("\x1b[2m")).toBe(false);
		}
	});

	it("dims each dialog below a newer overlay without changing its text", () => {
		const { ui, components } = createTestTui();

		showFullPaneOverlay(ui, new TestComponent(), 80);
		showFullPaneOverlay(ui, new TestComponent(), 80);

		for (const line of components[0]!.render(80)) {
			expect(line.startsWith("\x1b[2m") && line.endsWith("\x1b[22m")).toBe(true);
		}
		expect(stripAnsi(components[0]!.render(80).join("\n"))).toBe(stripAnsi(components[1]!.render(80).join("\n")));
		// The topmost dialog itself stays undimmed.
		for (const line of components[1]!.render(80)) {
			expect(line.startsWith("\x1b[2m")).toBe(false);
		}
	});

	it("dims deeper layers more than shallower ones", () => {
		const { ui, components } = createTestTui();
		class ColoredComponent implements Component {
			invalidate(): void {}
			render(width: number): string[] {
				return [`\x1b[38;5;250mcolored ${width}\x1b[0m`];
			}
		}

		showFullPaneOverlay(ui, new ColoredComponent(), 80);
		showFullPaneOverlay(ui, new ColoredComponent(), 80);
		showFullPaneOverlay(ui, new ColoredComponent(), 80);

		const stripFaint = (line: string): string => line.replace(/^\x1b\[2m/, "").replace(/\x1b\[22m$/, "");
		const deepest = stripFaint(components[0]!.render(80)[0]!);
		const middle = stripFaint(components[1]!.render(80)[0]!);
		expect(deepest).not.toBe(middle);
	});

	it("stops dimming lower dialogs after the overlay above is hidden", () => {
		const { ui, components } = createTestTui();

		const bottom = showFullPaneOverlay(ui, new TestComponent(), 80);
		const top = showFullPaneOverlay(ui, new TestComponent(), 80);
		top.hide();

		for (const line of components[0]!.render(80)) {
			expect(line.startsWith("\x1b[2m")).toBe(false);
		}
		expect(bottom).toBeDefined();
	});
});
