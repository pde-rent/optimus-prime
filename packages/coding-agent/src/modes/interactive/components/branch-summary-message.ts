import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";
import { LabeledMessageComponent } from "./message-surfaces.js";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 */
export class BranchSummaryMessageComponent extends LabeledMessageComponent {
	private message: BranchSummaryMessage;

	constructor(message: BranchSummaryMessage, markdownTheme?: MarkdownTheme) {
		super(markdownTheme);
		this.message = message;
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		this.addLabel("branch");

		if (this.isExpanded()) {
			this.addMarkdown(`**Branch Summary**\n\n${this.message.summary}`);
		} else {
			this.addChild(
				new Text(
					`${theme.fg("customMessageText", "Branch summary")} ${expandCollapseHint("app.tools.expand", false)}`,
					0,
					0,
				),
			);
		}
	}
}
