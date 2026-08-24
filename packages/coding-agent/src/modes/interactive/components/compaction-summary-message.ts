import { type Component, type MarkdownTheme, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { thinkingRecap } from "./assistant-message.js";
import { clickBlockLines, collapseChevron } from "./click-target.js";
import { ExpandableComponent } from "./expandable-component.js";
import { expandCollapseHint } from "./keybinding-hints.js";
import { CollapsibleLabeledMessage } from "./labeled-message.js";
import { customMessageLabel, customMessageMarkdown } from "./message-surfaces.js";

export class CompactionSummaryMessageComponent extends CollapsibleLabeledMessage {
	constructor(message: CompactionSummaryMessage, markdownTheme?: MarkdownTheme) {
		const tokenStr = message.tokensBefore.toLocaleString();
		const instructions = message.customInstructions;
		let expandedBody = `**Compacted from ${tokenStr} tokens**\n\n`;
		if (instructions) {
			expandedBody += `**Focus:** ${instructions}\n\n`;
		}
		expandedBody += message.summary;

		super(
			{
				label: "compaction",
				collapsedSummary: `Compacted from ${tokenStr} tokens${instructions ? ` · focus: ${instructions}` : ""}`,
				expandedBody,
			},
			markdownTheme,
		);
	}
}

/** Collapsed one-line progress row that truncates to the render width. */
class StreamingCollapsedRow implements Component {
	constructor(
		private readonly label: string,
		private readonly recap: string,
		private readonly hint: string,
	) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const separator = theme.fg("dim", " · ");
		const fixedWidth = visibleWidth(` ${this.label}${separator} ${this.hint}`);
		const recapWidth = Math.max(8, safeWidth - fixedWidth);
		const recap = theme.fg("thinkingText", truncateToWidth(this.recap, recapWidth));
		return [truncateToWidth(` ${this.label}${separator}${recap} ${this.hint}`, safeWidth, "")];
	}

	invalidate(): void {}
}

let nextCompactionStreamId = 0;

/**
 * Live block shown while a compaction summary is being generated. Streams the
 * partial summary like a thinking step; on compaction_end it is removed and the
 * durable CompactionSummaryMessageComponent takes over after the transcript
 * rebuild. Expansion follows the global tool-output toggle and per-block clicks.
 */
export class StreamingCompactionComponent extends ExpandableComponent {
	readonly toggleTargetId = `compaction-stream:${nextCompactionStreamId++}`;
	private partial = "";
	private dirty = true;
	private markdownTheme: MarkdownTheme | undefined;

	setMarkdownTheme(markdownTheme: MarkdownTheme): void {
		this.markdownTheme = markdownTheme;
		this.dirty = true;
	}

	/** Replace the streamed text with the cumulative partial summary. */
	setPartial(partial: string): void {
		if (partial === this.partial) return;
		this.partial = partial;
		this.dirty = true;
	}

	override invalidate(): void {
		super.invalidate();
		this.dirty = true;
	}

	override render(width: number): string[] {
		if (this.dirty) {
			this.rebuild();
			this.dirty = false;
		}
		return clickBlockLines(super.render(width), "toolcall", this.toggleTargetId);
	}

	protected updateDisplay(): void {
		this.dirty = true;
	}

	private rebuild(): void {
		this.clear();
		const chevron = theme.fg("dim", collapseChevron(!this.expanded));
		const label = customMessageLabel("compacting");
		if (!this.expanded) {
			const recap = thinkingRecap(this.partial, "Summarizing context...");
			this.addChild(new StreamingCollapsedRow(label, recap, expandCollapseHint("app.tools.expand", false)));
			return;
		}
		this.addChild(new Text(`${chevron} ${label} ${expandCollapseHint("app.tools.expand", true)}`, 1, 0));
		if (this.partial.trim()) {
			this.addChild(customMessageMarkdown(this.partial, this.markdownTheme));
		} else {
			this.addChild(new Text(theme.fg("thinkingText", "Summarizing context..."), 1, 0));
		}
	}
}
