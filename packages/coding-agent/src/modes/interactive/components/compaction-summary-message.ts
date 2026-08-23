import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { CollapsibleLabeledMessage } from "./labeled-message.js";

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
