import { isImageLine } from "./terminal-image.js";
import type { Component, OverlayAnchor, OverlayOptions, SizeValue } from "./tui.js";
import {
	extractSegments,
	sliceByColumn,
	sliceWithWidth,
	stripAnsi,
	visibleContentSpan,
	visibleWidth,
} from "./utils.js";

export interface FrameSelectionRegion {
	line: number;
	col: number;
	width: number;
}

/** An entry in the TUI's overlay stack. */
export interface OverlayStackEntry {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
}

/** SGR/hyperlink reset appended after independently-composited line fragments. */
export const SEGMENT_RESET = "[0m]8;;";

/** Parse a percentage string like "50%" into its numeric percent value. */
export function parsePercentage(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	return match ? parseFloat(match[1]) : null;
}

/** Parse a SizeValue into absolute value given a reference size */
export function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const percent = parsePercentage(value);
	if (percent === null) return undefined;
	return Math.floor((referenceSize * percent) / 100);
}

/**
 * Resolve overlay layout from options.
 * Returns { width, row, col, maxHeight } for rendering.
 */
export function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): { width: number; row: number; col: number; maxHeight: number | undefined } {
	const opt = options ?? {};

	// Parse margin (clamp to non-negative)
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	// Available space after margins
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	// === Resolve width ===
	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	// Apply minWidth
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	// Clamp to available space
	width = Math.max(1, Math.min(width, availWidth));

	// === Resolve maxHeight ===
	let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
	// Clamp to available space
	if (maxHeight !== undefined) {
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	}

	// Effective overlay height (may be clamped by maxHeight)
	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

	// === Resolve position ===
	let row: number;
	let col: number;

	if (opt.row !== undefined) {
		if (typeof opt.row === "string") {
			// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
			const percent = parsePercentage(opt.row);
			if (percent !== null) {
				const maxRow = Math.max(0, availHeight - effectiveHeight);
				row = marginTop + Math.floor(maxRow * (percent / 100));
			} else {
				// Invalid format, fall back to center
				row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
			}
		} else {
			// Absolute row position
			row = opt.row;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
	}

	if (opt.col !== undefined) {
		if (typeof opt.col === "string") {
			// Percentage: 0% = left, 100% = right (overlay stays within bounds)
			const percent = parsePercentage(opt.col);
			if (percent !== null) {
				const maxCol = Math.max(0, availWidth - width);
				col = marginLeft + Math.floor(maxCol * (percent / 100));
			} else {
				// Invalid format, fall back to center
				col = resolveAnchorCol("center", width, availWidth, marginLeft);
			}
		} else {
			// Absolute column position
			col = opt.col;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}

	// Apply offsets
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	// Clamp to terminal bounds (respecting margins)
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

function resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

function resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

/** Explicit dependencies of the overlay compositing pass. */
export interface OverlayCompositing {
	overlayStack: OverlayStackEntry[];
	isOverlayVisible(entry: OverlayStackEntry): boolean;
	focusedComponent: Component | null;
	overlaySelectionRegions: FrameSelectionRegion[];
}

/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
export function compositeOverlays(
	deps: OverlayCompositing,
	lines: string[],
	termWidth: number,
	termHeight: number,
): { lines: string[]; selectionRegions: FrameSelectionRegion[] } {
	if (deps.overlayStack.length === 0) {
		return { lines, selectionRegions: deps.overlaySelectionRegions };
	}
	const result = [...lines];
	const overlaySelectionRegions: FrameSelectionRegion[] = [...deps.overlaySelectionRegions];

	// Pre-render all visible overlays and calculate positions
	const rendered: {
		component: Component;
		overlayLines: string[];
		row: number;
		col: number;
		w: number;
		scrollback: boolean;
		aboveMarker?: { line: number; col: number; offsetY: number };
	}[] = [];
	let minLinesNeeded = result.length;

	const visibleEntries = deps.overlayStack.filter((e) => deps.isOverlayVisible(e));
	visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
	for (const entry of visibleEntries) {
		const { component, options } = entry;
		const scrollback = options?.scrollback === true;
		let aboveMarker: { line: number; col: number; offsetY: number } | undefined;
		if (options?.aboveMarker) {
			for (let line = result.length - 1; line >= 0; line--) {
				const markerIndex = result[line].indexOf(options.aboveMarker);
				if (markerIndex === -1) continue;
				aboveMarker = {
					line,
					col: visibleWidth(result[line].slice(0, markerIndex)),
					offsetY: options.offsetY ?? 0,
				};
				result[line] =
					result[line].slice(0, markerIndex) + result[line].slice(markerIndex + options.aboveMarker.length);
				break;
			}
			if (!aboveMarker) continue;
		}

		// Get layout with height=0 first to determine width and maxHeight
		// (width and maxHeight don't depend on overlay height)
		const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);

		// Render component at calculated width
		let overlayLines = component.render(width);

		// Apply maxHeight if specified
		if (maxHeight !== undefined && overlayLines.length > maxHeight) {
			overlayLines = overlayLines.slice(0, maxHeight);
		}

		// Get final row/col with actual overlay height
		const { row, col } = resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

		rendered.push({ component, overlayLines, row, col, w: width, scrollback, aboveMarker });
		if (!aboveMarker) {
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
	}

	// Pad to at least terminal height so overlays have screen-relative positions.
	// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
	// inflation that pushed content into scrollback on terminal widen.
	const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

	// Extend result with empty lines if content is too short for overlay placement or working area
	while (result.length < workingHeight) {
		result.push("");
	}

	if (visibleEntries.some((e) => e.options?.dimBackdrop === true)) {
		for (let i = 0; i < result.length; i++) {
			const line = result[i];
			if (line.length === 0 || stripAnsi(line).trim().length === 0) continue;
			result[i] = `\x1b[2m${line}\x1b[22m`;
		}
	}

	const viewportStart = Math.max(0, workingHeight - termHeight);

	// Composite each overlay
	for (const renderedOverlay of rendered) {
		const { component, w, scrollback, aboveMarker } = renderedOverlay;
		let { overlayLines, row, col } = renderedOverlay;
		if (aboveMarker) {
			const markerRow = Math.max(1, aboveMarker.line - viewportStart + aboveMarker.offsetY);
			if (markerRow >= termHeight) continue;
			while (overlayLines.length > markerRow && stripAnsi(overlayLines[0] ?? "").trim().length === 0) {
				overlayLines = overlayLines.slice(1);
			}
			while (overlayLines.length > markerRow && stripAnsi(overlayLines.at(-1) ?? "").trim().length === 0) {
				overlayLines = overlayLines.slice(0, -1);
			}
			if (overlayLines.length > markerRow) {
				overlayLines = overlayLines.slice(overlayLines.length - markerRow);
			}
			row = markerRow - overlayLines.length;
			col = Math.max(0, Math.min(aboveMarker.col, termWidth - w));
		}

		const overlayStart =
			scrollback && !aboveMarker ? Math.max(0, workingHeight - (row + overlayLines.length)) : viewportStart;
		for (let i = 0; i < overlayLines.length; i++) {
			const idx = overlayStart + row + i;
			if (idx >= 0 && idx < result.length) {
				// Defensive: truncate overlay line to declared width before compositing
				// (components should already respect width, but this ensures it)
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
				result[idx] = compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				subtractSelectionCoverage(overlaySelectionRegions, idx, col, col + w);
				const span = component === deps.focusedComponent ? visibleContentSpan(truncatedOverlayLine, w) : null;
				if (span) {
					overlaySelectionRegions.push({ line: idx, col: col + span.from, width: span.to - span.from });
				}
			}
		}
	}

	return { lines: result, selectionRegions: overlaySelectionRegions };
}

export function createDockSelectionRegions(
	frame: string[],
	transcriptWindowHeight: number,
	width: number,
): FrameSelectionRegion[] {
	const regions: FrameSelectionRegion[] = [];
	for (let row = Math.max(0, transcriptWindowHeight); row < frame.length; row++) {
		const span = visibleContentSpan(frame[row] ?? "", width);
		if (span) {
			regions.push({ line: row, col: span.from, width: span.to - span.from });
		}
	}
	return regions;
}

export function subtractSelectionCoverage(
	regions: FrameSelectionRegion[],
	line: number,
	coverStart: number,
	coverEnd: number,
): void {
	for (let i = regions.length - 1; i >= 0; i--) {
		const region = regions[i];
		if (region.line !== line) continue;
		const regionStart = region.col;
		const regionEnd = region.col + region.width;
		if (coverEnd <= regionStart || coverStart >= regionEnd) continue;

		const replacements: FrameSelectionRegion[] = [];
		if (regionStart < coverStart) {
			replacements.push({ line, col: regionStart, width: coverStart - regionStart });
		}
		if (coverEnd < regionEnd) {
			replacements.push({ line, col: coverEnd, width: regionEnd - coverEnd });
		}
		regions.splice(i, 1, ...replacements);
	}
}

/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
export function compositeLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	// Single pass through baseLine extracts both before and after segments
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

	// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

	// Pad segments to target widths
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);

	// Compose result
	const r = SEGMENT_RESET;
	const result =
		base.before +
		" ".repeat(beforePad) +
		r +
		overlay.text +
		" ".repeat(overlayPad) +
		r +
		base.after +
		" ".repeat(afterPad);

	// CRITICAL: Always verify and truncate to terminal width.
	// This is the final safeguard against width overflow which would crash the TUI.
	// Width tracking can drift from actual visible width due to:
	// - Complex ANSI/OSC sequences (hyperlinks, colors)
	// - Wide characters at segment boundaries
	// - Edge cases in segment extraction
	const resultWidth = visibleWidth(result);
	if (resultWidth <= totalWidth) {
		return result;
	}
	// Truncate with strict=true to ensure we don't exceed totalWidth
	return sliceByColumn(result, 0, totalWidth, true);
}
