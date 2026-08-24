import { AnsiCodeTracker, createAnsiCodeExtractor, updateTrackerFromText } from "./ansi-scan.js";
import { getSegmenter, graphemeWidth, visibleWidth } from "./text-width.js";

export { createAnsiCodeExtractor, extractAnsiCode, stripAnsi } from "./ansi-scan.js";
export {
	ELLIPSIS,
	extractSegments,
	getSegmenter,
	hyperlinkAtColumn,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	urlAtColumn,
	visibleWidth,
} from "./text-width.js";

const segmenter = getSegmenter();

/**
 * Pad `text` on the right so it occupies `width` terminal columns.
 *
 * Measured with `visibleWidth`, so ANSI escapes cost nothing and wide/CJK
 * graphemes cost two columns — `String.prototype.padEnd` gets both wrong.
 * Text already wider than `width` is returned untouched; truncate first if the
 * column must be a hard cap.
 */
export function padEndAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Right-align counterpart of {@link padEndAnsi}; same width rules apply. */
export function padStartAnsi(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/** Wrap text in reverse-video SGR (negative image), turned off after the text. */
export function reverseVideo(text: string): string {
	return `\x1b[7m${text}\x1b[27m`;
}

/**
 * Flatten every whitespace run — newlines included — to a single space.
 *
 * Single-row slots (status lines, summaries, hints) are laid out as one line, so
 * an embedded newline would render taller than the layout reserved and overlap
 * whatever sits below.
 */
export function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Separator between fragments of a composed status line. */
export const DOT_SEPARATOR = " · ";

/**
 * Join status-line fragments, dropping empty and nullish ones so callers can
 * pass conditional parts inline.
 *
 * Parts and separator arrive pre-styled: this package has no theme, colour is
 * injected by the caller, and that boundary is deliberate.
 */
export function dotJoin(parts: ReadonlyArray<string | null | undefined>, separator: string = DOT_SEPARATOR): string {
	return parts.filter((part): part is string => part != null && part.length > 0).join(separator);
}

/** Find the terminal-column span containing visible, non-whitespace content. */
export function visibleContentSpan(line: string, maxWidth: number): { from: number; to: number } | null {
	const limit = Math.floor(maxWidth);
	if (line.length === 0 || !Number.isFinite(limit) || limit <= 0) {
		return null;
	}

	let from = -1;
	let to = -1;
	let currentCol = 0;
	let i = 0;
	const extractAnsi = createAnsiCodeExtractor(line);

	while (i < line.length && currentCol < limit) {
		const ansi = extractAnsi(i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		if (line[i] === "\t") {
			currentCol += 3;
			i++;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && line[textEnd] !== "\t" && !extractAnsi(textEnd)) {
			textEnd++;
		}

		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const width = graphemeWidth(segment);
			const segmentStart = currentCol;
			const segmentEnd = currentCol + width;
			if (width > 0 && segment.trim().length > 0 && segmentStart < limit) {
				if (from === -1) from = segmentStart;
				to = Math.min(segmentEnd, limit);
			}
			currentCol = segmentEnd;
			if (currentCol >= limit) break;
		}
		i = textEnd;
	}

	return from === -1 ? null : { from, to };
}

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers.
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;
const TAB_REGEX = /\t/;
const TAB_GLOBAL_REGEX = /\t/g;

export function normalizeTerminalOutput(str: string): string {
	const hasThaiLaoAm = THAI_LAO_AM_REGEX.test(str);
	const hasTab = TAB_REGEX.test(str);
	if (!hasThaiLaoAm && !hasTab) return str;

	let normalized = str;
	if (hasThaiLaoAm) {
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	if (hasTab) {
		normalized = normalized.replace(TAB_GLOBAL_REGEX, "   ");
	}
	return normalized;
}

/**
 * Split text into words while keeping ANSI codes attached.
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let pendingAnsi = ""; // ANSI codes waiting to be attached to next visible content
	let inWhitespace = false;
	let i = 0;
	const extractAnsi = createAnsiCodeExtractor(text);

	while (i < text.length) {
		const ansiResult = extractAnsi(i);
		if (ansiResult) {
			// Hold ANSI codes separately - they'll be attached to the next visible char
			pendingAnsi += ansiResult.code;
			i += ansiResult.length;
			continue;
		}

		const char = text[i];
		const charIsSpace = char === " ";

		if (charIsSpace !== inWhitespace && current) {
			// Switching between whitespace and non-whitespace, push current token
			tokens.push(current);
			current = "";
		}

		// Attach any pending ANSI codes to this visible character
		if (pendingAnsi) {
			current += pendingAnsi;
			pendingAnsi = "";
		}

		inWhitespace = charIsSpace;
		current += char;
		i++;
	}

	// Handle any remaining pending ANSI codes (attach to last token)
	if (pendingAnsi) {
		current += pendingAnsi;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// Handle newlines by processing each line separately
	// Track ANSI state across lines so styles carry over after literal newlines
	const inputLines = text.split("\n");
	const result: string[] = [];
	const tracker = new AnsiCodeTracker();

	for (const inputLine of inputLines) {
		// Prepend active ANSI codes from previous lines (except for first line)
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		result.push(...wrapSingleLine(prefix + inputLine, width));
		// Update tracker with codes from this line for next iteration
		updateTrackerFromText(inputLine, tracker);
	}

	return result.length > 0 ? result : [""];
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) {
		return [""];
	}

	const visibleLength = visibleWidth(line);
	if (visibleLength <= width) {
		return [line];
	}

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const tokens = splitIntoTokensWithAnsi(line);

	let currentLine = "";
	let currentVisibleLength = 0;

	for (const token of tokens) {
		const tokenVisibleLength = visibleWidth(token);
		const isWhitespace = token.trim() === "";

		// Token itself is too long - break it character by character
		if (tokenVisibleLength > width && !isWhitespace) {
			if (currentLine) {
				// Add specific reset for underline only (preserves background)
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) {
					currentLine += lineEndReset;
				}
				wrapped.push(currentLine);
				currentLine = "";
				currentVisibleLength = 0;
			}

			// Break long token - breakLongWord handles its own resets
			const broken = breakLongWord(token, width, tracker);
			wrapped.push(...broken.slice(0, -1));
			currentLine = broken[broken.length - 1];
			currentVisibleLength = visibleWidth(currentLine);
			continue;
		}

		// Check if adding this token would exceed width
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		if (totalNeeded > width && currentVisibleLength > 0) {
			// Trim trailing whitespace, then add underline reset (not full reset, to preserve background)
			let lineToWrap = currentLine.trimEnd();
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				lineToWrap += lineEndReset;
			}
			wrapped.push(lineToWrap);
			if (isWhitespace) {
				// Don't start new line with whitespace
				currentLine = tracker.getActiveCodes();
				currentVisibleLength = 0;
			} else {
				currentLine = tracker.getActiveCodes() + token;
				currentVisibleLength = tokenVisibleLength;
			}
		} else {
			// Add to current line
			currentLine += token;
			currentVisibleLength += tokenVisibleLength;
		}

		updateTrackerFromText(token, tracker);
	}

	if (currentLine) {
		// No reset at end of final line - let caller handle it
		wrapped.push(currentLine);
	}

	// Trailing whitespace can cause lines to exceed the requested width
	return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : [""];
}

const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	return PUNCTUATION_REGEX.test(char);
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	const lines: string[] = [];
	let currentLine = tracker.getActiveCodes();
	let currentWidth = 0;

	// First, separate ANSI codes from visible content
	// We need to handle ANSI codes specially since they're not graphemes
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];
	const extractAnsi = createAnsiCodeExtractor(word);

	while (i < word.length) {
		const ansiResult = extractAnsi(i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// Find the next ANSI code or end of string
			let end = i;
			while (end < word.length) {
				const nextAnsi = extractAnsi(end);
				if (nextAnsi) break;
				end++;
			}
			// Segment this non-ANSI portion into graphemes
			const textPortion = word.slice(i, end);
			for (const seg of segmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// Now process segments
	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		// Skip empty graphemes to avoid issues with string-width calculation
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > width) {
			// Add specific reset for underline only (preserves background)
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				currentLine += lineEndReset;
			}
			lines.push(currentLine);
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		// No reset at end of final segment - caller handles continuation
		lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	return bgFn(padEndAnsi(line, width));
}

/**
 * Surround content lines with `paddingY` blank rows above and below, each
 * `width` columns wide. Background styling is applied to the blank rows when
 * provided (content lines are expected to be padded/styled by the caller).
 */
export function withVerticalPadding(
	contentLines: string[],
	width: number,
	paddingY: number,
	bgFn?: (text: string) => string,
): string[] {
	const blank = " ".repeat(width);
	const padding: string[] = [];
	for (let i = 0; i < paddingY; i++) {
		padding.push(bgFn ? applyBackgroundToLine(blank, width, bgFn) : blank);
	}
	return [...padding, ...contentLines, ...padding];
}
