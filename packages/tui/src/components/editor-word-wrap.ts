import { getSegmenter, isWhitespaceChar, visibleWidth } from "../utils.js";

const baseSegmenter = getSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/**
 * Regex matching image markers like `[image #1]`. Kept in sync with the marker
 * format produced by the coding agent's image-markers helper; the tui package
 * can't depend on the coding agent, so the pattern is duplicated here.
 */
const IMAGE_MARKER_REGEX = /\[image #(\d+)\]/g;

/** Non-global version for single-segment testing. */
const IMAGE_MARKER_SINGLE = /^\[image #(\d+)\]$/;

/** Check if a segment is an atomic marker (paste or image) merged by segmentWithMarkers. */
export function isAtomicMarker(segment: string): boolean {
	return segment.length >= 10 && (PASTE_MARKER_SINGLE.test(segment) || IMAGE_MARKER_SINGLE.test(segment));
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste or image markers into single atomic segments. This makes cursor
 * movement, deletion, word-wrap, etc. treat the markers as single units.
 *
 * Paste markers are only merged when their numeric ID exists in `validPasteIds`
 * (so a stale `[paste #N]` typed by the user isn't treated as atomic). Image
 * markers are self-contained and always merged.
 */
export function segmentWithMarkers(text: string, validPasteIds: Set<number>): Iterable<Intl.SegmentData> {
	const hasPaste = validPasteIds.size > 0 && text.includes("[paste #");
	const hasImage = text.includes("[image #");

	if (!hasPaste && !hasImage) {
		return baseSegmenter.segment(text);
	}

	const markers: Array<{ start: number; end: number }> = [];
	if (hasPaste) {
		for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
			const id = Number.parseInt(m[1]!, 10);
			if (!validPasteIds.has(id)) continue;
			markers.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	if (hasImage) {
		for (const m of text.matchAll(IMAGE_MARKER_REGEX)) {
			markers.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}
	markers.sort((a, b) => a.start - b.start);

	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...baseSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isAtomicMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		if (isWs && next && (isAtomicMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}
