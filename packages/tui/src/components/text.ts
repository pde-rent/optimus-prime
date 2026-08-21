import { KeyedRenderCache } from "../render-cache.js";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, padEndAnsi, withVerticalPadding, wrapTextWithAnsi } from "../utils.js";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;

	private renderCache = new KeyedRenderCache();

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
		this.renderCache.invalidate();
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.renderCache.invalidate();
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const cached = this.renderCache.get(this.text, width);
		if (cached) return cached;

		if (!this.text || this.text.trim() === "") {
			return this.renderCache.set([this.text, width], []);
		}

		const normalizedText = this.text.replace(/\t/g, "   ");

		const contentWidth = Math.max(1, width - this.paddingX * 2);

		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		const margin = " ".repeat(this.paddingX);
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			const lineWithMargins = margin + line + margin;
			contentLines.push(
				this.customBgFn
					? applyBackgroundToLine(lineWithMargins, width, this.customBgFn)
					: padEndAnsi(lineWithMargins, width),
			);
		}

		const result = withVerticalPadding(contentLines, width, this.paddingY, this.customBgFn);
		this.renderCache.set([this.text, width], result);

		return result.length > 0 ? result : [""];
	}
}
