import { Container, Text } from "@earendil-works/pi-tui";
import type { CompactionOutcomeMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { userMessageBubble } from "./message-surfaces.js";

/** Shared one-shot text-in-a-bubble message: compaction outcomes, slash results. */
export class SimpleMessageComponent extends Container {
	constructor(content: string, color: "warning" | "error" | "default" = "default") {
		super();
		const contentBox = userMessageBubble();
		contentBox.addChild(new Text(color === "default" ? content : theme.fg(color, content), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}

export class CompactionOutcomeMessageComponent extends SimpleMessageComponent {
	constructor(message: CompactionOutcomeMessage) {
		super(message.content, message.details.outcome === "skipped" ? "warning" : "error");
	}
}

export class MalformedCompactionOutcomeMessageComponent extends SimpleMessageComponent {
	constructor() {
		super("[Malformed compaction outcome message]", "error");
	}
}
