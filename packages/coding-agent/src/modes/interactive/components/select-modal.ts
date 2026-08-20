import {
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { selectionHints } from "./keybinding-hints.js";

const SELECT_MODAL_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const DEFAULT_MAX_VISIBLE = 12;

export interface SelectModalOptions {
	title: string;
	subtitle?: string;
	items: SelectItem[];
	/** Value to start on; falls back to the first item. */
	selectedValue?: string;
	maxVisible?: number;
	onSelect: (value: string) => void;
	onCancel: () => void;
	/** Fires as the cursor moves, for surfaces that live-preview (themes). */
	onPreview?: (value: string) => void;
}

/**
 * The one "pick one of these" surface. Every simple selector is this component
 * shown through `showFullPaneOverlay`, so they all share chrome, hints and
 * keybindings; only the item source differs.
 */
export class SelectModalComponent extends Container {
	private readonly selectList: SelectList;

	constructor(options: SelectModalOptions) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
		if (options.subtitle) {
			this.addChild(new Text(theme.fg("muted", options.subtitle), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options.items,
			Math.min(options.items.length, options.maxVisible ?? DEFAULT_MAX_VISIBLE),
			getSelectListTheme(),
			SELECT_MODAL_LAYOUT,
		);

		const currentIndex = options.items.findIndex((item) => item.value === options.selectedValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => options.onSelect(item.value);
		this.selectList.onCancel = options.onCancel;
		if (options.onPreview) {
			this.selectList.onSelectionChange = (item) => options.onPreview?.(item.value);
		}

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(selectionHints(), 0, 0));
	}

	getSelectList(): SelectList {
		return this.selectList;
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
