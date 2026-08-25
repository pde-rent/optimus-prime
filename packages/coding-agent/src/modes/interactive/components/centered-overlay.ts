import {
	blendColor,
	type Component,
	type Focusable,
	isFocusable,
	type OverlayHandle,
	type OverlayOptions,
	type Rgb,
	rgbTo256,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

interface CenteredOverlayOptions {
	getRows: () => number;
	maxContentWidth?: number;
	verticalOffset?: number;
}

interface InputHandler {
	handleInput(data: string): void;
}

export interface FullPaneOverlayOptions {
	maxContentWidth?: number;
	fullWidth?: boolean;
	suspendFullscreenMouse?: boolean;
}

function hasInputHandler(component: Component): component is Component & InputHandler {
	return typeof (component as { handleInput?: unknown }).handleInput === "function";
}

/**
 * One entry per active sized (modal-style) overlay, ordered bottom-to-top.
 * Each visible layer above an overlay dims it once more, so stacked dialogs
 * read as progressively deeper.
 */
interface ModalOverlayEntry {
	hidden: boolean;
}

const modalOverlayStack: ModalOverlayEntry[] = [];

function raiseModalOverlayEntry(entry: ModalOverlayEntry): void {
	const index = modalOverlayStack.indexOf(entry);
	if (index !== -1) modalOverlayStack.splice(index, 1);
	modalOverlayStack.push(entry);
}

function removeModalOverlayEntry(entry: ModalOverlayEntry): void {
	const index = modalOverlayStack.indexOf(entry);
	if (index !== -1) modalOverlayStack.splice(index, 1);
}

/** How many visible overlay layers sit on top of `entry`. */
function dimLevelsFor(entry: ModalOverlayEntry): number {
	let levels = 0;
	for (let i = modalOverlayStack.indexOf(entry) + 1; i < modalOverlayStack.length; i++) {
		if (!modalOverlayStack[i].hidden) levels++;
	}
	return levels;
}

/** Fraction of a color kept per dim layer below the topmost dialog. */
const DIM_COLOR_FACTOR = 0.55;
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function blendTowardBlack(rgb: Rgb, levels: number): Rgb {
	return blendColor(rgb, BLACK, DIM_COLOR_FACTOR ** levels);
}

const BASIC_COLORS: Rgb[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];

function ansi256ToRgb(index: number): Rgb | undefined {
	if (index < 0 || index > 255) return undefined;
	if (index < 16) return BASIC_COLORS[index];
	if (index >= 232) {
		const value = 8 + (index - 232) * 10;
		return { r: value, g: value, b: value };
	}
	const cubeValues = [0, 95, 135, 175, 215, 255];
	const cubeIndex = index - 16;
	return {
		r: cubeValues[Math.floor(cubeIndex / 36)]!,
		g: cubeValues[Math.floor((cubeIndex % 36) / 6)]!,
		b: cubeValues[cubeIndex % 6]!,
	};
}

function scaledColorSgr(code: 38 | 48, rgb: Rgb, levels: number): string {
	if (theme.colorMode === "truecolor") {
		const scaled = blendTowardBlack(rgb, levels);
		return `\x1b[${code};2;${scaled.r};${scaled.g};${scaled.b}m`;
	}
	return `\x1b[${code};5;${rgbTo256(blendTowardBlack(rgb, levels))}m`;
}

/** Rewrite one SGR sequence with its explicit colors darkened for `levels` layers. */
function dimSgrSequence(body: string, levels: number): string {
	const raw = body.split(";");
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const code = Number.parseInt(raw[i] ?? "", 10);
		const isColor = code === 38 || code === 48;
		const colorType = raw[i + 1];
		if (isColor && colorType === "2" && i + 4 < raw.length) {
			const rgb = {
				r: Number.parseInt(raw[i + 2] ?? "", 10),
				g: Number.parseInt(raw[i + 3] ?? "", 10),
				b: Number.parseInt(raw[i + 4] ?? "", 10),
			};
			out.push(scaledColorSgr(code, rgb, levels).slice(2, -1));
			i += 4;
			continue;
		}
		if (isColor && colorType === "5" && i + 2 < raw.length) {
			const rgb = ansi256ToRgb(Number.parseInt(raw[i + 2] ?? "", 10));
			if (rgb) {
				out.push(scaledColorSgr(code, rgb, levels).slice(2, -1));
				i += 2;
				continue;
			}
		}
		out.push(raw[i] ?? "");
	}
	return `\x1b[${out.join(";")}m`;
}

/**
 * Dim one rendered line as if `levels` overlays were opened on top of it:
 * explicit foreground/background colors are blended toward black once per
 * layer, plus the same faint attribute the backdrop uses.
 */
function dimLine(line: string, levels: number): string {
	const dimmed = line.replace(/\x1b\[([0-9;]*)m/g, (_seq, body: string) =>
		body.length === 0 ? _seq : dimSgrSequence(body, levels),
	);
	return `\x1b[2m${dimmed}\x1b[22m`;
}

/**
 * Wraps a dialog shown through `showFullPaneOverlay` and re-renders it dimmed
 * while any number of other dialogs sit above it in the overlay stack.
 */
class LayeredModalComponent implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly component: Component,
		private readonly entry: ModalOverlayEntry,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.component)) {
			this.component.focused = value;
		}
	}

	invalidate(): void {
		this.component.invalidate?.();
	}

	handleInput(data: string): void {
		if (hasInputHandler(this.component)) {
			this.component.handleInput(data);
		}
	}

	render(width: number): string[] {
		const lines = this.component.render(width);
		const levels = dimLevelsFor(this.entry);
		if (levels <= 0) return lines;
		return lines.map((line) => (line.length === 0 ? line : dimLine(line, levels)));
	}
}

/** Keep the module-level stack in sync with the TUI handle's lifecycle. */
function trackModalOverlay(handle: OverlayHandle, entry: ModalOverlayEntry): OverlayHandle {
	return {
		hide: () => {
			removeModalOverlayEntry(entry);
			handle.hide();
		},
		setHidden: (hidden: boolean) => {
			entry.hidden = hidden;
			handle.setHidden(hidden);
		},
		isHidden: () => handle.isHidden(),
		focus: () => {
			raiseModalOverlayEntry(entry);
			handle.focus();
		},
		unfocus: () => handle.unfocus(),
		isFocused: () => handle.isFocused(),
	};
}

/** Shows a component as a full-pane centered overlay on the given TUI. */
export function showFullPaneOverlay(
	ui: TUI,
	component: Component,
	options: number | FullPaneOverlayOptions = 80,
): OverlayHandle {
	const { maxContentWidth, suspendFullscreenMouse } =
		typeof options === "number"
			? { maxContentWidth: options, suspendFullscreenMouse: undefined }
			: {
					maxContentWidth: options.fullWidth ? undefined : (options.maxContentWidth ?? 80),
					suspendFullscreenMouse: options.suspendFullscreenMouse,
				};
	// Full-width panes keep the blank-padded wrapper; sized dialogs are centered by
	// the TUI itself with a dimmed backdrop so they read as a separate layer.
	if (maxContentWidth === undefined) {
		const fullOptions: OverlayOptions = { width: "100%", maxHeight: "100%", row: 0, col: 0 };
		if (suspendFullscreenMouse) {
			fullOptions.suspendFullscreenMouse = true;
		}
		return ui.showOverlay(new CenteredOverlayComponent(component, { getRows: () => ui.terminal.rows }), fullOptions);
	}

	const overlayOptions: OverlayOptions = {
		width: maxContentWidth,
		maxHeight: "100%",
		anchor: "center",
		dimBackdrop: true,
	};
	if (suspendFullscreenMouse) {
		overlayOptions.suspendFullscreenMouse = true;
	}

	const entry: ModalOverlayEntry = { hidden: false };
	raiseModalOverlayEntry(entry);
	const handle = ui.showOverlay(new LayeredModalComponent(component, entry), overlayOptions);
	return trackModalOverlay(handle, entry);
}

export class CenteredOverlayComponent implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly component: Component,
		private readonly options: CenteredOverlayOptions,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.component)) {
			this.component.focused = value;
		}
	}

	invalidate(): void {
		this.component.invalidate?.();
	}

	handleInput(data: string): void {
		if (hasInputHandler(this.component)) {
			this.component.handleInput(data);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth = Math.min(safeWidth, this.options.maxContentWidth ?? safeWidth);
		const left = Math.max(0, Math.floor((safeWidth - contentWidth) / 2));
		const contentLines = this.component.render(contentWidth).map((line) => this.place(line, safeWidth, left));
		const requestedRows = this.options.getRows();
		const targetRows =
			Number.isFinite(requestedRows) && requestedRows > 0
				? Math.max(contentLines.length, Math.floor(requestedRows))
				: contentLines.length;
		const centeredTop = Math.floor((targetRows - contentLines.length) / 2) + (this.options.verticalOffset ?? 0);
		const topPadding = Math.max(0, Math.min(centeredTop, targetRows - contentLines.length));
		const bottomPadding = Math.max(0, targetRows - contentLines.length - topPadding);

		return [
			...Array.from({ length: topPadding }, () => this.blank(safeWidth)),
			...contentLines,
			...Array.from({ length: bottomPadding }, () => this.blank(safeWidth)),
		];
	}

	private place(text: string, width: number, left: number): string {
		const safeLeft = Math.max(0, Math.min(left, width));
		const contentWidth = Math.max(0, width - safeLeft);
		const content = truncateToWidth(text, contentWidth, "");
		const right = Math.max(0, width - safeLeft - visibleWidth(content));
		return " ".repeat(safeLeft) + content + " ".repeat(right);
	}

	private blank(width: number): string {
		return " ".repeat(width);
	}
}
