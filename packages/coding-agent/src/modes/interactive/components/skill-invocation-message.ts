import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/skill-blocks.js";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";
import { customMessageLabel, LabeledMessageComponent } from "./message-surfaces.js";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Only renders the skill block itself - user message is rendered separately.
 */
export class SkillInvocationMessageComponent extends LabeledMessageComponent {
	private skillBlock: ParsedSkillBlock;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme?: MarkdownTheme) {
		super(markdownTheme);
		this.skillBlock = skillBlock;
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		if (this.isExpanded()) {
			// Expanded: label + skill name header + full content
			this.addChild(new Text(customMessageLabel("skill"), 0, 0));
			this.addMarkdown(`**${this.skillBlock.name}**\n\n${this.skillBlock.content}`);
		} else {
			// Collapsed: single line - [skill] name (hint to expand)
			const line =
				customMessageLabel("skill", true) +
				theme.fg("customMessageText", this.skillBlock.name) +
				` ${expandCollapseHint("app.tools.expand", false)}`;
			this.addChild(new Text(line, 0, 0));
		}
	}
}
