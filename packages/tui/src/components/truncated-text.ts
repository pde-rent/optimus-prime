import { KeyedRenderCache } from "../render-cache.js";
import type { Component } from "../tui.js";
import { padEndAnsi, truncateToWidth, withVerticalPadding } from "../utils.js";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;
	private renderCache = new KeyedRenderCache();

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const cached = this.renderCache.get(this.text, width);
		if (cached) return cached;

		const availableWidth = Math.max(1, width - this.paddingX * 2);

		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		const displayText = truncateToWidth(singleLineText, availableWidth);

		const padding = " ".repeat(this.paddingX);
		const finalLine = padEndAnsi(padding + displayText + padding, width);

		const result = withVerticalPadding([finalLine], width, this.paddingY);
		this.renderCache.set([this.text, width], result);

		return result;
	}
}
