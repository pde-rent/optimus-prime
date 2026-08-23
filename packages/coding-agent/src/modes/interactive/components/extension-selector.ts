/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { CountdownTimer } from "./countdown-timer.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import { MenuList, MenuPanel, MenuRow, MenuSelector, type MenuViewportProvider } from "./menu-panel.js";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	getRows?: () => number;
}

const PREFERRED_VISIBLE_OPTIONS = 8;
const OPTION_LIST_RESERVED_BASE_ROWS = 5;
const OPTION_SCROLL_INDICATOR_ROWS = 1;

function splitTitleAndDescription(value: string): { title: string; description?: string; descriptionRows: number } {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const [title = "", ...descriptionLines] = lines;
	return {
		title,
		description: descriptionLines.length > 0 ? descriptionLines.join("\n") : undefined,
		descriptionRows: descriptionLines.length,
	};
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selector: MenuSelector<string>;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private panel: MenuPanel;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		const header = splitTitleAndDescription(title);
		this.baseTitle = header.title;
		const tui = opts?.tui;
		const viewport: MenuViewportProvider = { getRows: opts?.getRows ?? (tui ? () => tui.terminal.rows : undefined) };
		const reservedRows = OPTION_LIST_RESERVED_BASE_ROWS + header.descriptionRows;

		this.panel = new MenuPanel({
			title: header.title,
			subtitle: header.description,
		});
		this.addChild(this.panel);

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.panel.setTitle(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new MenuList({ compact: true });
		this.panel.addChild(this.listContainer);
		this.selector = new MenuSelector<string>(this.listContainer, {
			...viewport,
			preferredVisibleItems: PREFERRED_VISIBLE_OPTIONS,
			reservedRows: () => reservedRows,
			comfortableItemRows: 1,
			compactItemRows: 1,
			scrollIndicatorRows: OPTION_SCROLL_INDICATOR_ROWS,
		});
		this.panel.addChild(new Spacer(1));
		this.panel.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);

		this.updateList();
	}

	override render(width: number): string[] {
		if (this.selector.relayout(this.options.length)) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.selector.renderWindow(
			this.options,
			(option, selected) =>
				new MenuRow({
					primary: option ?? "",
					selected,
				}),
			(text) => new Text(text, 0, 0),
		);
	}

	handleInput(keyData: string): void {
		if (keyData === "k" || keyData === "j") {
			if (this.selector.moveBy(keyData === "k" ? -1 : 1, this.options.length)) this.updateList();
			return;
		}
		if (keyData === "\n") {
			const selected = this.options[this.selector.getSelectedIndex()];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		this.selector.handleKey(keyData, {
			totalItems: this.options.length,
			rerender: () => this.updateList(),
			onConfirm: (index) => {
				const selected = this.options[index];
				if (selected) this.onSelectCallback(selected);
			},
			onCancel: () => this.onCancelCallback(),
		});
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
