import { type Box, Container, Text } from "@earendil-works/pi-tui";
import { parseSlashCommand } from "../../../core/slash-commands.js";
import { theme } from "../theme/theme.js";
import { wrapOsc133Zones } from "./ansi.js";
import { userMessageBubble } from "./message-surfaces.js";

export function isLeadingSlashCommand(text: string, isRecognized: (name: string) => boolean): boolean {
	const command = parseSlashCommand(text);
	return command !== undefined && isRecognized(command.name);
}

export function styleSlashCommandText(text: string, styleRest: (rest: string) => string = (rest) => rest): string {
	const parsed = parseSlashCommand(text);
	const commandEnd = parsed ? parsed.name.length + 1 : text.length;
	return `${theme.fg("accent", text.slice(0, commandEnd))}${styleRest(text.slice(commandEnd))}`;
}

/** Renders a durable session command with the same layout as a user message. */
export class SlashCommandMessageComponent extends Container {
	private readonly contentBox: Box;

	constructor(text: string) {
		super();
		this.contentBox = userMessageBubble();
		this.contentBox.addChild(new Text(styleSlashCommandText(text), 0, 0));
		this.addChild(this.contentBox);
	}

	setExpanded(_expanded: boolean): void {}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		return wrapOsc133Zones(lines);
	}
}
