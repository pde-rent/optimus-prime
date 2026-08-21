import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";
import { LabeledMessageComponent } from "./message-surfaces.js";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 */
export class CompactionSummaryMessageComponent extends LabeledMessageComponent {
	private message: CompactionSummaryMessage;

	constructor(message: CompactionSummaryMessage, markdownTheme?: MarkdownTheme) {
		super(markdownTheme);
		this.message = message;
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		this.addLabel("compaction");

		const instructions = this.message.customInstructions;
		if (this.isExpanded()) {
			let header = `**Compacted from ${tokenStr} tokens**\n\n`;
			if (instructions) {
				header += `**Focus:** ${instructions}\n\n`;
			}
			this.addMarkdown(header + this.message.summary);
		} else {
			const focus = instructions ? ` · focus: ${instructions}` : "";
			this.addChild(
				new Text(
					`${theme.fg("customMessageText", `Compacted from ${tokenStr} tokens${focus}`)} ${expandCollapseHint("app.tools.expand", false)}`,
					0,
					0,
				),
			);
		}
	}
}
