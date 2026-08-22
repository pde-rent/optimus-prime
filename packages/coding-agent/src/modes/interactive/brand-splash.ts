import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { OPTIMUS_LOGO, OPTIMUS_LOGO_META_MAX_ROWS } from "../../themes/optimus-logo.js";
import { fgAnsiFor, theme } from "./theme/theme.js";
import { ignitionCellColor } from "./ignition.js";
import { formatSplashCwd } from "./path-formatting.js";



export function truncatePathMiddle(value: string, width: number): string {
if (visibleWidth(value) <= width) {
	return value;
}
if (width <= 1) {
	return truncateToWidth(value, width, "");
}

const ellipsis = "…";
const normalized = value.replace(/\\/g, "/");
const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
const body = prefix ? normalized.slice(prefix.length) : normalized;
const parts = body.split("/").filter((part) => part.length > 0);
const last = parts.pop() ?? "";
const previous = parts.pop();
const suffix = previous ? `${previous}/${last}` : last;
const candidate = `${prefix}${ellipsis}/${suffix}`;
if (visibleWidth(candidate) <= width) {
	return candidate;
}

return truncateToWidth(candidate, width);
}

export interface BrandSplashMetadataLine {
label: string;
value: string;
}

export interface BrandSplashHeaderOptions {
logo?: string;
topPadding?: boolean;
getExtraMetadata?: () => readonly BrandSplashMetadataLine[];
getHideStartHint?: () => boolean;
getStartHint?: () => string;
/** Milliseconds since ignition began, or undefined once it is over. */
getIgnitionElapsedMs?: () => number | undefined;
}

/** Blank columns between the art's ink and the metadata text. */
const META_BLOCK_GUTTER = 1;

export class BrandSplashHeader implements Component {
private readonly logoRaw: string[];
private readonly logoCanvasWidth: number;
private readonly gutter = 4;
private readonly labelWidth = 9;
/** Overlay geometry is measured against OPTIMUS_LOGO; custom marks keep the right-hand meta column. */
private readonly overlayMeta: boolean;

constructor(
	private readonly version: string,
	private readonly getModelId: () => string | undefined,
	private readonly getCwd: () => string,
	private readonly verboseInstructions?: string,
	private readonly options: BrandSplashHeaderOptions = {},
) {
	const logo = options.logo ?? OPTIMUS_LOGO;
	this.overlayMeta = logo === OPTIMUS_LOGO;
	this.logoRaw = logo.split("\n");
	this.logoCanvasWidth = this.logoRaw.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

invalidate(): void {
	// Render output is derived from current theme/session state.
}

/**
 * Meta block painted over the bottom-right of OPTIMUS_LOGO. Lines are padded
 * to a shared `width` so the overlay clears one aligned rectangle instead of
 * leaving art fragments beside the shorter rows.
 */
private overlayMetaBlock(extraMetadata: readonly BrandSplashMetadataLine[]): { lines: string[]; width: number } {
	const brand = "Optimus Prime";
	const entries = [
		{ label: "version", value: `v${this.version}` },
		{ label: "model", value: this.getModelId() ?? "—" },
		{ label: "cwd", value: formatSplashCwd(this.getCwd()) },
		...extraMetadata,
	].slice(0, OPTIMUS_LOGO_META_MAX_ROWS - 1);
	const labelWidth = entries.reduce((max, entry) => Math.max(max, visibleWidth(entry.label)), 0) + 1;
	// One column stays blank between the art ink and the block.
	const valueWidth = Math.max(1, this.logoCanvasWidth - 1 - labelWidth);
	const rows = entries.map((entry) => ({
		label: entry.label.padEnd(labelWidth),
		value:
			entry.label === "cwd"
				? truncatePathMiddle(entry.value, valueWidth)
				: truncateToWidth(entry.value, valueWidth),
	}));
	const textWidth = rows.reduce(
		(max, row) => Math.max(max, labelWidth + visibleWidth(row.value)),
		visibleWidth(brand),
	);
	// One column of the block is blank so the text does not sit flush against the art's ink, and
	// the block is one row taller than its text so the brand line has clear space above it.
	const width = textWidth + META_BLOCK_GUTTER;
	const gutter = " ".repeat(META_BLOCK_GUTTER);
	const pad = (text: string) => " ".repeat(Math.max(0, width - META_BLOCK_GUTTER - visibleWidth(text)));
	return {
		width,
		lines: [
			" ".repeat(width),
			gutter + theme.fg("text", brand) + pad(brand),
			...rows.map(
				(row) => gutter + theme.fg("dim", row.label) + theme.fg("muted", row.value) + pad(row.label + row.value),
			),
		],
	};
}

/**
 * Theme colour normally; the ignition colour on the handful of cells the eyes and their beams
 * cover. Painted per cell rather than per row, so the rest of the mark is untouched.
 */
private paintArt(line: string, row: number): string {
	const elapsed = this.options.getIgnitionElapsedMs?.();
	if (elapsed === undefined) return theme.fg("text", line);
	const cells = [...line];
	let painted = "";
	let lit = false;
	for (let col = 0; col < cells.length; col++) {
		const color = ignitionCellColor(row, col, elapsed);
		if (!color) {
			painted += cells[col];
			continue;
		}
		lit = true;
		painted += `${fgAnsiFor(color, theme.colorMode)}${cells[col]}\x1b[39m`;
	}
	// Wrapping an already-coloured string in the theme colour would reset the eyes back to it at
	// the first escape, so a lit row is emitted as-is and only unlit rows take the theme colour.
	return lit ? painted : theme.fg("text", line);
}

render(width: number): string[] {
	const safeWidth = Math.max(1, width);
	const paddingX = safeWidth > 1 ? 1 : 0;
	const contentWidth = Math.max(1, safeWidth - paddingX * 2);
	const frame = (content: string) => {
		const clamped = truncateToWidth(content, contentWidth, "");
		return " ".repeat(paddingX) + clamped + " ".repeat(Math.max(0, safeWidth - paddingX - visibleWidth(clamped)));
	};
	if (this.overlayMeta) {
		const block = this.overlayMetaBlock(this.options.getExtraMetadata?.() ?? []);
		const blockStart = Math.max(0, this.logoCanvasWidth - block.width);
		const firstBlockRow = Math.max(0, this.logoRaw.length - block.lines.length);
		// Art keeps everything left of the block minus one blank gutter column.
		const artEnd = Math.max(0, blockStart - 1);
		const lines = this.options.topPadding ? ["", ""] : [];
		lines.push(
			...this.logoRaw.map((line, index) => {
				const meta = block.lines[index - firstBlockRow];
				if (meta === undefined) {
					return frame(this.paintArt(line, index));
				}
				// Trailing blanks are trimmed from the art, so pad before slicing.
				const padded = line + " ".repeat(Math.max(0, this.logoCanvasWidth - visibleWidth(line)));
				const art = truncateToWidth(padded, artEnd, "");
				return frame(theme.fg("text", art) + " ".repeat(blockStart - artEnd) + meta);
			}),
		);
		if (!(this.options.getHideStartHint?.() ?? false)) {
			lines.push(frame(""));
			lines.push(frame(theme.fg("dim", this.options.getStartHint?.() ?? "type to search sessions")));
		}
		this.appendVerboseInstructions(lines, frame, safeWidth, contentWidth);
		return lines;
	}
	const metaWidth = contentWidth - this.logoCanvasWidth - this.gutter;
	const showMeta = metaWidth >= this.labelWidth + 8;
	const valueWidth = Math.max(1, metaWidth - this.labelWidth);
	const labelled = (label: string, value: string) => {
		const displayValue =
			label === "cwd" ? truncatePathMiddle(value, valueWidth) : truncateToWidth(value, valueWidth);
		return theme.fg("dim", label.padEnd(this.labelWidth)) + theme.fg("muted", displayValue);
	};
	const extraMetadata = this.options.getExtraMetadata?.() ?? [];
	const hideStartHint = this.options.getHideStartHint?.() ?? false;
	const startHint = this.options.getStartHint?.() ?? "type to search sessions";
	const metaLines = showMeta
		? [
				labelled("version", `v${this.version}`),
				labelled("model", this.getModelId() ?? "—"),
				labelled("cwd", formatSplashCwd(this.getCwd())),
				...extraMetadata.map((line) => labelled(line.label, line.value)),
				...(hideStartHint ? [] : ["", theme.fg("dim", startHint)]),
			]
		: [];
	const metaStart = Math.max(0, Math.floor((this.logoRaw.length - metaLines.length) / 2));
	const lines = this.options.topPadding ? ["", ""] : [];
	lines.push(
		...this.logoRaw.map((line, index) => {
			const colored = theme.fg("text", line);
			const meta = index >= metaStart && index < metaStart + metaLines.length ? metaLines[index - metaStart] : "";
			const padding = showMeta
				? " ".repeat(Math.max(0, this.logoCanvasWidth - visibleWidth(line) + this.gutter))
				: "";
			return frame(colored + padding + meta);
		}),
	);

	this.appendVerboseInstructions(lines, frame, safeWidth, contentWidth);

	return lines;
}

private appendVerboseInstructions(
	lines: string[],
	frame: (content: string) => string,
	safeWidth: number,
	contentWidth: number,
): void {
	if (!this.verboseInstructions) {
		return;
	}
	lines.push(" ".repeat(safeWidth));
	for (const instruction of this.verboseInstructions.split("\n")) {
		lines.push(frame(truncateToWidth(instruction, contentWidth)));
	}
}
}
