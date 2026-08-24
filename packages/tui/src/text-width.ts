import { AnsiCodeTracker, createAnsiCodeExtractor, parseOsc8Hyperlink, stripAnsi } from "./ansi-scan.js";
import { eastAsianWidth } from "./east-asian-width.js";

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * This is a fast heuristic to avoid the expensive rgiEmojiRegex test.
 * The tested Unicode blocks are deliberately broad to account for future
 * Unicode additions.
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
		(cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
		segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
		segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
	);
}

// Regexes for character classification (same as string-width library)
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

function isPrintableAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	if (maxWidth <= 0 || text.length === 0) {
		return { text: "", width: 0 };
	}

	if (isPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}

	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");
	if (!hasAnsi && !hasTabs) {
		let result = "";
		let width = 0;
		for (const { segment } of segmenter.segment(text)) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				break;
			}
			result += segment;
			width += w;
		}
		return { text: result, width };
	}

	let result = "";
	let width = 0;
	let i = 0;
	let pendingAnsi = "";
	const extractAnsi = createAnsiCodeExtractor(text);

	while (i < text.length) {
		const ansi = extractAnsi(i);
		if (ansi) {
			pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		if (text[i] === "\t") {
			if (width + 3 > maxWidth) {
				break;
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += "\t";
			width += 3;
			i++;
			continue;
		}

		let end = i;
		while (end < text.length && text[end] !== "\t") {
			const nextAnsi = extractAnsi(end);
			if (nextAnsi) {
				break;
			}
			end++;
		}

		for (const { segment } of segmenter.segment(text.slice(i, end))) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				return { text: result, width };
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += segment;
			width += w;
		}
		i = end;
	}

	return { text: result, width };
}

function finalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const visibleWidth = prefixWidth + ellipsisWidth;
	const prefixHasAnsi = prefix.includes("\x1b");
	const ellipsisHasAnsi = ellipsis.includes("\x1b");
	const beforeEllipsis = prefixHasAnsi ? reset : "";
	const afterEllipsis = prefixHasAnsi || ellipsisHasAnsi ? reset : "";
	const result =
		ellipsis.length > 0 ? `${prefix}${beforeEllipsis}${ellipsis}${afterEllipsis}` : `${prefix}${beforeEllipsis}`;

	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
export function graphemeWidth(segment: string): number {
	// Zero-width clusters
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// Emoji check with pre-filter
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		return 2;
	}

	// Get base visible codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	// Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
	// full-width emoji in terminals, even when isolated during streaming.
	// Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}

	let width = eastAsianWidth(cp);

	// Trailing halfwidth/fullwidth forms and AM vowels that segment with a base.
	if (segment.length > 1) {
		for (const char of segment.slice(1)) {
			const c = char.codePointAt(0)!;
			if (c >= 0xff00 && c <= 0xffef) {
				width += eastAsianWidth(c);
			} else if (c === 0x0e33 || c === 0x0eb3) {
				width += 1;
			}
		}
	}

	return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	// Fast path: pure ASCII printable
	if (isPrintableAscii(str)) {
		return str.length;
	}

	// Check cache
	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	if (clean.includes("\x1b")) {
		// Strip supported ANSI/OSC/APC escape sequences in one pass.
		// This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
		// and APC sequences like CURSOR_MARKER.
		let stripped = "";
		let i = 0;
		const extractAnsi = createAnsiCodeExtractor(clean);
		while (i < clean.length) {
			const ansi = extractAnsi(i);
			if (ansi) {
				i += ansi.length;
				continue;
			}
			stripped += clean[i];
			i++;
		}
		clean = stripped;
	}

	// Calculate width
	let width = 0;
	for (const { segment } of segmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	// Cache result
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) {
			widthCache.delete(firstKey);
		}
	}
	widthCache.set(str, width);

	return width;
}

/**
 * Ellipsis appended when text is truncated.
 *
 * ASCII rather than U+2026 because it is `truncateToWidth`'s long-standing
 * default and callers assert on it; switching the glyph is an observable change
 * to every default-ellipsis caller, not a cosmetic one.
 */
export const ELLIPSIS = "...";

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: {@link ELLIPSIS})
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = ELLIPSIS,
	pad: boolean = false,
): string {
	if (maxWidth <= 0) {
		return "";
	}

	if (text.length === 0) {
		return pad ? " ".repeat(maxWidth) : "";
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const textWidth = visibleWidth(text);
		if (textWidth <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}

		const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
		if (clippedEllipsis.width === 0) {
			return pad ? " ".repeat(maxWidth) : "";
		}
		return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	if (isPrintableAscii(text)) {
		if (text.length <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		const targetWidth = maxWidth - ellipsisWidth;
		return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let pendingAnsi = "";
	let visibleSoFar = 0;
	let keptWidth = 0;
	let keepContiguousPrefix = true;
	let overflowed = false;
	let exhaustedInput = false;
	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");

	if (!hasAnsi && !hasTabs) {
		for (const { segment } of segmenter.segment(text)) {
			const width = graphemeWidth(segment);
			if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
				result += segment;
				keptWidth += width;
			} else {
				keepContiguousPrefix = false;
			}
			visibleSoFar += width;
			if (visibleSoFar > maxWidth) {
				overflowed = true;
				break;
			}
		}
		exhaustedInput = !overflowed;
	} else {
		let i = 0;
		const extractAnsi = createAnsiCodeExtractor(text);
		while (i < text.length) {
			const ansi = extractAnsi(i);
			if (ansi) {
				pendingAnsi += ansi.code;
				i += ansi.length;
				continue;
			}

			if (text[i] === "\t") {
				if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += "\t";
					keptWidth += 3;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}
				visibleSoFar += 3;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
				i++;
				continue;
			}

			let end = i;
			while (end < text.length && text[end] !== "\t") {
				const nextAnsi = extractAnsi(end);
				if (nextAnsi) {
					break;
				}
				end++;
			}

			for (const { segment } of segmenter.segment(text.slice(i, end))) {
				const width = graphemeWidth(segment);
				if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += segment;
					keptWidth += width;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}

				visibleSoFar += width;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
			}
			if (overflowed) {
				break;
			}
			i = end;
		}
		exhaustedInput = i >= text.length;
	}

	if (!overflowed && exhaustedInput) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
export function sliceWithWidth(
	line: string,
	startCol: number,
	length: number,
	strict = false,
): { text: string; width: number } {
	if (length <= 0) return { text: "", width: 0 };
	const endCol = startCol + length;
	let result = "",
		resultWidth = 0,
		currentCol = 0,
		i = 0,
		pendingAnsi = "";
	const extractAnsi = createAnsiCodeExtractor(line);

	while (i < line.length) {
		const ansi = extractAnsi(i);
		if (ansi) {
			if (currentCol >= startCol && currentCol < endCol) result += ansi.code;
			else if (currentCol < startCol) pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsi(textEnd)) textEnd++;

		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + w <= endCol;
			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
				resultWidth += w;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}
	return { text: result, width: resultWidth };
}

/**
 * Return the OSC 8 hyperlink URL covering the given visible column, or null
 * when the column is not inside a hyperlink (or is past the end of the line).
 */
export function hyperlinkAtColumn(line: string, column: number): string | null {
	if (column < 0) return null;
	const extractAnsi = createAnsiCodeExtractor(line);
	let currentCol = 0;
	let activeUrl: string | null = null;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsi(i);
		if (ansi) {
			const hyperlink = parseOsc8Hyperlink(ansi.code);
			if (hyperlink !== undefined) activeUrl = hyperlink?.url ?? null;
			i += ansi.length;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !extractAnsi(textEnd)) textEnd++;
		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);
			if (column < currentCol + w) return activeUrl;
			currentCol += w;
		}
		i = textEnd;
	}
	return null;
}

/**
 * Return an explicit OSC 8 URL or terminal-style bare HTTP(S) URL covering a
 * visible column. OSC 8 remains authoritative when its label resembles a URL.
 */
export function urlAtColumn(line: string, column: number): string | null {
	const explicitUrl = hyperlinkAtColumn(line, column);
	if (explicitUrl || column < 0) return explicitUrl;

	// Fullscreen normalizes tabs before painting, and strips ANSI without
	// changing visible columns. Mirror that representation for bare URL spans.
	const plainText = stripAnsi(line).replace(/\t/g, "   ");
	const urlPattern = /https?:\/\/[^\s<>"'`]+/giu;
	for (const match of plainText.matchAll(urlPattern)) {
		let url = match[0].replace(/[.,;:!?]+$/u, "");
		for (const [open, close] of [
			["(", ")"],
			["[", "]"],
			["{", "}"],
		] as const) {
			while (url.endsWith(close) && url.split(close).length > url.split(open).length) {
				url = url.slice(0, -1);
			}
		}
		const start = visibleWidth(plainText.slice(0, match.index));
		const end = start + visibleWidth(url);
		if (column >= start && column < end) return url;
	}
	return null;
}

// Pooled tracker instance for extractSegments (avoids allocation per call)
const pooledStyleTracker = new AnsiCodeTracker();

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the overlay region.
 * Preserves styling from before the overlay that should affect content after it.
 */
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	let before = "",
		beforeWidth = 0,
		after = "",
		afterWidth = 0;
	let currentCol = 0,
		i = 0;
	let pendingAnsiBefore = "";
	let afterStarted = false;
	const afterEnd = afterStart + afterLen;
	const extractAnsi = createAnsiCodeExtractor(line);

	// Track styling state so "after" inherits styling from before the overlay
	pooledStyleTracker.clear();

	while (i < line.length) {
		const ansi = extractAnsi(i);
		if (ansi) {
			// Track all SGR codes to know styling state at afterStart
			pooledStyleTracker.process(ansi.code);
			// Include ANSI codes in their respective segments
			if (currentCol < beforeEnd) {
				pendingAnsiBefore += ansi.code;
			} else if (currentCol >= afterStart && currentCol < afterEnd && afterStarted) {
				// Only include after we've started "after" (styling already prepended)
				after += ansi.code;
			}
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsi(textEnd)) textEnd++;

		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);

			if (currentCol < beforeEnd) {
				if (pendingAnsiBefore) {
					before += pendingAnsiBefore;
					pendingAnsiBefore = "";
				}
				before += segment;
				beforeWidth += w;
			} else if (currentCol >= afterStart && currentCol < afterEnd) {
				const fits = !strictAfter || currentCol + w <= afterEnd;
				if (fits) {
					// On first "after" grapheme, prepend inherited styling from before overlay
					if (!afterStarted) {
						after += pooledStyleTracker.getActiveCodes();
						afterStarted = true;
					}
					after += segment;
					afterWidth += w;
				}
			}

			currentCol += w;
			// Early exit: done with "before" only, or done with both segments
			if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
		}
		i = textEnd;
		if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
	}

	return { before, beforeWidth, after, afterWidth };
}
