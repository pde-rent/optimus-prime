import {
	type Box,
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { parseSlashCommand } from "../../../core/slash-commands.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { wrapOsc133Zones } from "./ansi.js";
import { userMessageBubble } from "./message-surfaces.js";
import { isLeadingSlashCommand } from "./slash-command-message.js";

const COMMAND_MASK_BASE = "\uE000";
const COMMAND_MASK_EXTRA_WIDTH = "\uFF9E";
const COMMAND_MASK_ZERO_WIDTH = "\u2060";
const COMMAND_MASK_PATTERN = /\u2060|\uE000\uFF9E*/gu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class SlashCommandMarkdown implements Component {
	private readonly markdown: Markdown;
	private readonly commandGraphemes: string[];

	constructor(text: string, markdownTheme: MarkdownTheme) {
		const parsed = parseSlashCommand(text);
		const commandEnd = parsed ? parsed.name.length + 1 : text.length;
		this.commandGraphemes = [...graphemeSegmenter.segment(text.slice(0, commandEnd))].map(({ segment }) => segment);
		const placeholder = this.commandGraphemes
			.map((grapheme) => {
				const width = visibleWidth(grapheme);
				return width === 0
					? COMMAND_MASK_ZERO_WIDTH
					: COMMAND_MASK_BASE + COMMAND_MASK_EXTRA_WIDTH.repeat(width - 1);
			})
			.join("");
		this.markdown = new Markdown(`${placeholder}${text.slice(commandEnd)}`, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
	}

	render(width: number): string[] {
		let commandOffset = 0;
		return this.markdown.render(width).map((line) => {
			const chunks: string[] = [];
			const replaced = line.replace(COMMAND_MASK_PATTERN, (placeholder) => {
				const grapheme = this.commandGraphemes[commandOffset];
				if (grapheme === undefined) return placeholder;
				commandOffset++;
				chunks.push(grapheme);
				return "";
			});
			return chunks.length === 0 ? replaced : `${theme.fg("accent", chunks.join(""))}${replaced}`;
		});
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

export class UserMessageComponent extends Container {
	private contentBox: Box;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		isRecognizedSlashCommand: (name: string) => boolean = () => false,
	) {
		super();
		this.contentBox = userMessageBubble();
		this.contentBox.addChild(
			isLeadingSlashCommand(text, isRecognizedSlashCommand)
				? new SlashCommandMarkdown(text, markdownTheme)
				: new Markdown(text, 0, 0, markdownTheme, {
						color: (content: string) => theme.fg("userMessageText", content),
					}),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		return wrapOsc133Zones(lines);
	}
}
