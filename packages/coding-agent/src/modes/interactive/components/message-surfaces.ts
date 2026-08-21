/**
 * Shared message chrome: the user-message bubble, the quiet custom-message
 * surface, and the labeled expandable blocks drawn on it.
 */

import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/** The user-message bubble: side padding on the user-message background. */
export function userMessageBubble(paddingX = 2): Box {
	return new Box(paddingX, 1, (content: string) => theme.getUserMessageBackgroundColor()(content));
}

/** The quiet custom-message surface: one column of padding on the custom background. */
export function customMessageBubble(): Box {
	return new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
}

/**
 * Bold bracketed label such as `[compaction]`, in the custom-message label color.
 * `trailingSpace` keeps the separator inside the colored span, matching the
 * pre-consolidation byte output for collapsed single-line renders.
 */
export function customMessageLabel(name: string, trailingSpace = false): string {
	const space = trailingSpace ? " " : "";
	return theme.fg("customMessageLabel", `\x1b[1m[${name}]\x1b[22m${space}`);
}

/** Markdown on the custom-message surface, body text in the custom-message color. */
export function customMessageMarkdown(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()): Markdown {
	return new Markdown(text, 0, 0, markdownTheme, {
		color: (line: string) => theme.fg("customMessageText", line),
	});
}

/**
 * Base for durable custom-message blocks that render a bold bracketed label
 * plus collapsed/expanded content on the custom-message background.
 */
export abstract class LabeledMessageComponent extends Box {
	private expanded = false;
	private readonly markdownTheme: MarkdownTheme;

	constructor(markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t: string) => theme.bg("customMessageBg", t));
		this.markdownTheme = markdownTheme;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	protected isExpanded(): boolean {
		return this.expanded;
	}

	protected addLabel(name: string): void {
		this.addChild(new Text(customMessageLabel(name), 0, 0));
		this.addChild(new Spacer(1));
	}

	protected addMarkdown(text: string): void {
		this.addChild(customMessageMarkdown(text, this.markdownTheme));
	}

	protected abstract updateDisplay(): void;
}
