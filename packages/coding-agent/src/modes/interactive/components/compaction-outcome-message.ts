import { Container, Text } from "@earendil-works/pi-tui";
import type { CompactionOutcomeMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { userMessageBubble } from "./message-surfaces.js";

/** Renders a durable unsuccessful automatic-compaction outcome. */
export class CompactionOutcomeMessageComponent extends Container {
	constructor(message: CompactionOutcomeMessage) {
		super();
		const color = message.details.outcome === "skipped" ? "warning" : "error";
		const contentBox = userMessageBubble();
		contentBox.addChild(new Text(theme.fg(color, message.content), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}

export class MalformedCompactionOutcomeMessageComponent extends Container {
	constructor() {
		super();
		const contentBox = userMessageBubble();
		contentBox.addChild(new Text(theme.fg("error", "[Malformed compaction outcome message]"), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}
