import type { SessionSlashCommandResultMessage } from "../../../core/messages.js";
import { SimpleMessageComponent } from "./simple-message.js";

/** Renders a durable session-command outcome with user-message spacing. */
export class SlashCommandResultMessageComponent extends SimpleMessageComponent {
	constructor(message: SessionSlashCommandResultMessage) {
		super(message.content);
	}
}
