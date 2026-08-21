import { Container, Text } from "@earendil-works/pi-tui";
import type { SessionSlashCommandResultMessage } from "../../../core/messages.js";
import { userMessageBubble } from "./message-surfaces.js";

/** Renders a durable session-command outcome with user-message spacing. */
export class SlashCommandResultMessageComponent extends Container {
	constructor(message: SessionSlashCommandResultMessage) {
		super();
		const contentBox = userMessageBubble();
		contentBox.addChild(new Text(message.content, 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}
