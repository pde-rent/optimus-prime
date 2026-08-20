import { collapseText } from "@earendil-works/pi-tui";
import { SelectModalComponent } from "./select-modal.js";

interface UserMessageItem {
	id: string;
	text: string;
}

const MAX_VISIBLE_MESSAGES = 12;

export class UserMessageSelectorComponent extends SelectModalComponent {
	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super({
			title: "Fork from Message",
			subtitle: "Copies the active path up to the selected message into a new session",
			items: messages.map((message) => ({ value: message.id, label: collapseText(message.text) })),
			// Session history is chronological; default to the latest fork point.
			selectedValue: initialSelectedId ?? messages[messages.length - 1]?.id,
			maxVisible: MAX_VISIBLE_MESSAGES,
			onSelect,
			onCancel,
		});

		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}
}
