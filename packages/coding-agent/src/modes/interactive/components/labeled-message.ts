import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";
import { customMessageLabel, LabeledMessageComponent } from "./message-surfaces.js";

interface LabeledMessageConfig {
	/** Bracket label shown expanded, e.g. "branch", "skill", "compaction". */
	label: string;
	/** Collapsed one-line summary text (without the expand hint). */
	collapsedSummary: string;
	/** Full markdown body rendered when expanded. */
	expandedBody: string;
	/** When true, the label is inlined on the collapsed line (skill style). */
	collapsedInlineLabel?: boolean;
}

/**
 * Shared collapsible labeled message used by branch summaries, skill
 * invocations, and compaction summaries. All three follow the same contract:
 * bold bracketed label + collapsed one-liner or full markdown when expanded.
 */
export class CollapsibleLabeledMessage extends LabeledMessageComponent {
	constructor(
		private readonly config: LabeledMessageConfig,
		markdownTheme?: MarkdownTheme,
	) {
		super(markdownTheme);
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		if (this.isExpanded()) {
			if (this.config.collapsedInlineLabel) {
				this.addChild(new Text(customMessageLabel(this.config.label), 0, 0));
			} else {
				this.addLabel(this.config.label);
			}
			this.addMarkdown(this.config.expandedBody);
		} else {
			const prefix = this.config.collapsedInlineLabel
				? customMessageLabel(this.config.label, true) + theme.fg("customMessageText", this.config.collapsedSummary)
				: `${customMessageLabel(this.config.label)} ${theme.fg("customMessageText", this.config.collapsedSummary)}`;
			this.addChild(new Text(`${prefix} ${expandCollapseHint("app.tools.expand", false)}`, 0, 0));
		}
	}
}
