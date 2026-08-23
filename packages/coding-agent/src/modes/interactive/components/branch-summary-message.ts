import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.js";
import { CollapsibleLabeledMessage } from "./labeled-message.js";

export class BranchSummaryMessageComponent extends CollapsibleLabeledMessage {
	constructor(message: BranchSummaryMessage, markdownTheme?: MarkdownTheme) {
		super(
			{
				label: "branch",
				collapsedSummary: "Branch summary",
				expandedBody: `**Branch Summary**\n\n${message.summary}`,
			},
			markdownTheme,
		);
	}
}
