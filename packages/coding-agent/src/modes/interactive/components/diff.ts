import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { replaceTabs } from "../../../core/tools/render-utils.js";
import * as Diff from "../../../utils/diff.js";
import { highlightCode, theme } from "../theme/theme.js";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}

type ThemeBg = Parameters<typeof theme.bg>[0];
type ThemeColor = Parameters<typeof theme.fg>[0];

// Rewrite full/background resets to foreground-only so a row's background block
// survives the syntax-highlighted content.
const BG_CLEARING_RESET = /\x1b\[(?:0|49)m/g;

function keepBackground(highlighted: string): string {
	return highlighted.replace(BG_CLEARING_RESET, "\x1b[39m");
}

function highlightContent(content: string, language: string | undefined): string {
	if (!content) {
		return "";
	}
	if (language) {
		return keepBackground(highlightCode(content, language)[0] ?? content);
	}
	return theme.fg("mdCodeBlock", content);
}

interface DiffLineSpec {
	bg: ThemeBg;
	gutter: string;
	gutterFg: ThemeColor;
	content: string;
	language: string | undefined;
	width: number;
	/** Flat content color instead of syntax highlighting (256-color fallback). */
	contentFg?: ThemeColor;
}

function padToWidth(inner: string, width: number): string {
	if (visibleWidth(inner) > width) {
		inner = truncateToWidth(inner, width, "");
	}
	// Pad after truncating too: a 2-cell character straddling the cutoff leaves
	// the result a cell short.
	const pad = width - visibleWidth(inner);
	return pad > 0 ? inner + " ".repeat(pad) : inner;
}

// One diff line as one-or-more full-width background rows. Content wider than the
// row wraps onto continuation rows with a blank gutter, so nothing is truncated.
function buildRichDiffLine(spec: DiffLineSpec): string[] {
	const renderedContent = spec.contentFg
		? theme.fg(spec.contentFg, spec.content)
		: highlightContent(spec.content, spec.language);

	const gutterWidth = visibleWidth(spec.gutter);
	const contentWidth = Math.max(1, spec.width - gutterWidth);
	const contentRows = wrapTextWithAnsi(renderedContent, contentWidth);
	if (contentRows.length === 0) {
		contentRows.push("");
	}

	const styledGutter = theme.fg(spec.gutterFg, spec.gutter);
	const styledCont = " ".repeat(gutterWidth);
	return contentRows.map((row, index) => {
		const gutter = index === 0 ? styledGutter : styledCont;
		return theme.bg(spec.bg, padToWidth(`${gutter}${row}\x1b[39m`, spec.width));
	});
}

export interface RichDiffOptions {
	/** Language id for syntax highlighting the diff content (e.g. "typescript"). */
	language?: string;
	/**
	 * Layout: "unified" (default) stacks -/+ rows; "split" shows them side by side;
	 * "auto" picks split once the available width reaches SPLIT_MIN_WIDTH.
	 */
	view?: "auto" | "split" | "unified";
}

/** Minimum total width at which "auto" selects the side-by-side layout. */
export const SPLIT_MIN_WIDTH = 120;

interface ParsedLine {
	prefix: "+" | "-" | " ";
	lineNum: string;
	content: string;
}

/** A dim `⋮` row separating non-adjacent hunks of one file's diff. */
export function renderDiffSeparator(contentWidth: number): string {
	const width = Math.max(1, contentWidth);
	const marker = theme.fg("toolDiffContext", " ⋮");
	const pad = Math.max(0, width - visibleWidth(marker));
	return theme.bg("toolPanelBg", marker + " ".repeat(pad));
}

function plainSpec(content: string, width: number, language: string | undefined): DiffLineSpec {
	return {
		bg: "toolPanelBg",
		gutterFg: "toolDiffContext",
		// Leading space keeps the text off the edge while the bg still reaches it.
		gutter: " ",
		content,
		language,
		width,
	};
}

/** Parse every line; unparsable lines (headers, separators) come back as null. */
function parseAllLines(diffText: string): (ParsedLine | null)[] {
	return diffText.split("\n").map((line) => {
		const parsed = parseDiffLine(line);
		if (!parsed || (parsed.prefix !== "+" && parsed.prefix !== "-" && parsed.prefix !== " ")) return null;
		return { prefix: parsed.prefix, lineNum: parsed.lineNum, content: parsed.content };
	});
}

function specForParsedLine(
	line: ParsedLine,
	width: number,
	language: string | undefined,
	useBlocks: boolean,
): DiffLineSpec {
	const gutter = ` ${line.lineNum} ${line.prefix === " " ? " " : line.prefix} `;
	if (line.prefix === "+") {
		return {
			bg: useBlocks ? "toolDiffAddedBg" : "toolPanelBg",
			gutterFg: "toolDiffAdded",
			gutter,
			content: replaceTabs(line.content),
			language,
			width,
			contentFg: useBlocks ? undefined : "toolDiffAdded",
		};
	}
	if (line.prefix === "-") {
		return {
			bg: useBlocks ? "toolDiffRemovedBg" : "toolPanelBg",
			gutterFg: "toolDiffRemoved",
			gutter,
			content: replaceTabs(line.content),
			language,
			width,
			contentFg: useBlocks ? undefined : "toolDiffRemoved",
		};
	}
	return {
		bg: "toolPanelBg",
		gutterFg: "toolDiffContext",
		gutter,
		content: replaceTabs(line.content),
		language,
		width,
	};
}

function blankHalfCell(width: number): string {
	return theme.bg("toolPanelBg", " ".repeat(width));
}

/** One paired side-by-side row (left removed/context, right added/context), padded to equal height. */
function pushSplitPair(
	rows: string[],
	left: ParsedLine | undefined,
	right: ParsedLine | undefined,
	halfWidth: number,
	language: string | undefined,
	useBlocks: boolean,
): void {
	const leftRows = left
		? buildRichDiffLine(specForParsedLine(left, halfWidth, language, useBlocks))
		: [blankHalfCell(halfWidth)];
	const rightRows = right
		? buildRichDiffLine(specForParsedLine(right, halfWidth, language, useBlocks))
		: [blankHalfCell(halfWidth)];
	const height = Math.max(leftRows.length, rightRows.length);
	for (let i = 0; i < height; i++) {
		rows.push((leftRows[i] ?? blankHalfCell(halfWidth)) + (rightRows[i] ?? blankHalfCell(halfWidth)));
	}
}

/** Side-by-side layout: -/+ groups pair row-wise; context lines repeat on both halves. */
function buildSplitDiff(
	diffText: string,
	width: number,
	halfWidth: number,
	language: string | undefined,
	useBlocks: boolean,
): string[] {
	const rawLines = diffText.split("\n");
	const parsed = parseAllLines(diffText);
	const rows: string[] = [];
	let i = 0;
	while (i < parsed.length) {
		const line = parsed[i];
		if (!line) {
			rows.push(...buildRichDiffLine(plainSpec(replaceTabs(rawLines[i] ?? ""), width, language)));
			i++;
			continue;
		}
		if (line.prefix === "-") {
			const removed: ParsedLine[] = [];
			while (parsed[i]?.prefix === "-") removed.push(parsed[i++] as ParsedLine);
			const added: ParsedLine[] = [];
			while (parsed[i]?.prefix === "+") added.push(parsed[i++] as ParsedLine);
			const count = Math.max(removed.length, added.length);
			for (let k = 0; k < count; k++) {
				pushSplitPair(rows, removed[k], added[k], halfWidth, language, useBlocks);
			}
			continue;
		}
		if (line.prefix === "+") {
			pushSplitPair(rows, undefined, line, halfWidth, language, useBlocks);
			i++;
			continue;
		}
		pushSplitPair(rows, line, line, halfWidth, language, useBlocks);
		i++;
	}
	return rows;
}

/**
 * Render a unified diff as full-width rows: green/red blocks, syntax-highlighted.
 * With `view: "split"` (or `"auto"` at SPLIT_MIN_WIDTH+), removed and added lines
 * render side by side like OpenCode's diff view.
 */
export function renderRichDiff(diffText: string, contentWidth: number, options: RichDiffOptions = {}): string[] {
	const width = Math.max(1, contentWidth);
	const language = options.language;
	// 256-color can't render subtle tints (a dark block quantizes to black), so
	// color the text instead of the background there.
	const useBlocks = theme.colorMode === "truecolor";
	const split = options.view === "split" || (options.view === "auto" && width >= SPLIT_MIN_WIDTH);
	if (split) {
		return buildSplitDiff(diffText, width, Math.floor(width / 2), language, useBlocks);
	}
	const rows: string[] = [];

	for (const rawLine of diffText.split("\n")) {
		const parsed = parseDiffLine(rawLine);
		if (!parsed) {
			rows.push(...buildRichDiffLine(plainSpec(replaceTabs(rawLine), width, language)));
			continue;
		}
		rows.push(...buildRichDiffLine(specForParsedLine(parsed as ParsedLine, width, language, useBlocks)));
	}

	return rows;
}
