import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/skill-blocks.js";
import { CollapsibleLabeledMessage } from "./labeled-message.js";

export class SkillInvocationMessageComponent extends CollapsibleLabeledMessage {
	constructor(skillBlock: ParsedSkillBlock, markdownTheme?: MarkdownTheme) {
		super(
			{
				label: "skill",
				collapsedInlineLabel: true,
				collapsedSummary: skillBlock.name,
				expandedBody: `**${skillBlock.name}**\n\n${skillBlock.content}`,
			},
			markdownTheme,
		);
	}
}
