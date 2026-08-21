import { getKeybindings } from "../keybindings.js";
import { listWindow, moveSelection, scrollPositionText } from "../list-window.js";
import type { Component } from "../tui.js";
import { padEndAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;
/** Heavier than "› " so the selected row is legible without relying on color alone. */
const SELECTED_MARKER = "❯ ";

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	argumentHint?: string;
	sourceTag?: string;
	takesArgument?: boolean;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	/**
	 * Wraps the selected row after it is padded to the full list width, so a
	 * background reads as one continuous bar. Without it the row is only
	 * recolored, which is easy to miss on a busy popup.
	 */
	selectedRow?: (text: string) => string;
	description: (text: string) => string;
	argumentHint?: (text: string) => string;
	sourceTag?: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListRowContext {
	item: SelectItem;
	index: number;
	isSelected: boolean;
	width: number;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	showItemMetadata?: boolean;
	showDirectionalScrollInfo?: boolean;
	showSelectedDescription?: boolean;
	/**
	 * Replaces the default row body. Row decoration (tree glyphs, badges,
	 * per-item metadata lines) is the only thing list surfaces legitimately
	 * differ on; everything else must stay in this component.
	 */
	renderRow?: (context: SelectListRowContext) => string | string[];
	/** Text appended to the scroll readout, e.g. active filter labels. */
	scrollInfoSuffix?: () => string;
	/** Keeps the readout visible even when every item fits. */
	alwaysShowScrollInfo?: boolean;
	/** Enter toggles the row through `onToggle` instead of confirming and closing. */
	multiSelect?: boolean;
	/** Empty-list message; defaults to the slash-command wording. */
	noMatchText?: string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;
	public onToggle?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		this.selectedIndex = 0;
	}

	/** Replaces the backing items, keeping the selection in range. */
	setItems(items: SelectItem[]): void {
		this.items = items;
		this.filteredItems = items;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	setMaxVisible(maxVisible: number): void {
		this.maxVisible = Math.max(1, maxVisible);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const total = this.filteredItems.length;

		if (total === 0) {
			lines.push(this.theme.noMatch(this.layout.noMatchText ?? "  No matching commands"));
			if (this.layout.alwaysShowScrollInfo) {
				lines.push(this.theme.scrollInfo(truncateToWidth(`  (0/0)${this.scrollInfoSuffix()}`, width - 2, "")));
			}
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();
		const { start, end } = listWindow(this.selectedIndex, total, this.maxVisible);

		for (let i = start; i < end; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			if (this.layout.renderRow) {
				const rendered = this.layout.renderRow({ item, index: i, isSelected, width });
				lines.push(...(Array.isArray(rendered) ? rendered : [rendered]));
				continue;
			}
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		if (this.layout.alwaysShowScrollInfo || start > 0 || end < total) {
			const scrollText = this.layout.showDirectionalScrollInfo
				? this.formatDirectionalScrollInfo(start, total - end)
				: scrollPositionText(this.selectedIndex, total);
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText + this.scrollInfoSuffix(), width - 2, "")));
		}

		if (this.layout.showSelectedDescription) {
			this.renderSelectedDescription(lines, width);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.step(-1, true);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.step(1, true);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.step(-this.maxVisible, false);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.step(this.maxVisible, false);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (!selectedItem) return;
			if (this.layout.multiSelect) {
				this.onToggle?.(selectedItem);
			} else {
				this.onSelect?.(selectedItem);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	private step(delta: number, wrap: boolean): void {
		this.selectedIndex = moveSelection(this.selectedIndex, this.filteredItems.length, delta, wrap);
		this.notifySelectionChange();
	}

	private scrollInfoSuffix(): string {
		return this.layout.scrollInfoSuffix?.() ?? "";
	}

	/** Pad a selected row to the full width so `selectedRow` can paint a solid bar. */
	private fillSelected(content: string, width: number): string {
		const clamped = truncateToWidth(content, width, "");
		const padded = padEndAnsi(clamped, width);
		return this.theme.selectedRow ? this.theme.selectedRow(padded) : padded;
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? SELECTED_MARKER : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (this.layout.showItemMetadata) {
			return this.renderMetadataItem(item, isSelected, width, primaryColumnWidth, prefix, prefixWidth);
		}

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "…");
				if (isSelected) {
					return this.fillSelected(
						this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`),
						width,
					);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.fillSelected(this.theme.selectedText(`${prefix}${truncatedValue}`), width);
		}

		return prefix + truncatedValue;
	}

	private formatDirectionalScrollInfo(hiddenAbove: number, hiddenBelow: number): string {
		const indicators = [
			hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : undefined,
			hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : undefined,
		].filter((indicator): indicator is string => indicator !== undefined);
		return `  ${indicators.join("  ")}`;
	}

	private renderMetadataItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		primaryColumnWidth: number,
		prefix: string,
		prefixWidth: number,
	): string {
		const argumentHint = item.argumentHint ? normalizeToSingleLine(item.argumentHint) : undefined;
		const sourceTag = item.sourceTag ? normalizeToSingleLine(item.sourceTag) : undefined;
		const hasMetadata = Boolean(argumentHint || sourceTag);
		const contentWidth = Math.max(1, width - prefixWidth - 2);
		const showMetadata = hasMetadata && contentWidth > primaryColumnWidth;
		const effectivePrimaryColumnWidth = showMetadata ? primaryColumnWidth : contentWidth;
		const maxPrimaryWidth = showMetadata
			? Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP)
			: effectivePrimaryColumnWidth;
		const primary = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
		const styledPrefix = isSelected ? this.theme.selectedPrefix(prefix) : prefix;
		const styledPrimary = isSelected ? this.theme.selectedText(primary) : primary;
		if (!showMetadata) {
			const row = truncateToWidth(`${styledPrefix}${styledPrimary}`, width, "");
			return isSelected ? this.fillSelected(row, width) : row;
		}

		const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - visibleWidth(primary)));
		let remainingWidth = Math.max(0, width - prefixWidth - visibleWidth(primary) - spacing.length - 2);
		const metadata: string[] = [];
		if (argumentHint && remainingWidth > 0) {
			const truncatedArgumentHint = truncateToWidth(argumentHint, remainingWidth, "…");
			metadata.push((this.theme.argumentHint ?? this.theme.description)(truncatedArgumentHint));
			remainingWidth -= visibleWidth(truncatedArgumentHint);
		}
		if (sourceTag && remainingWidth > (metadata.length > 0 ? PRIMARY_COLUMN_GAP : 0)) {
			if (metadata.length > 0) {
				metadata.push(" ".repeat(PRIMARY_COLUMN_GAP));
				remainingWidth -= PRIMARY_COLUMN_GAP;
			}
			metadata.push(
				(this.theme.sourceTag ?? this.theme.description)(truncateToWidth(sourceTag, remainingWidth, "…")),
			);
		}
		const row = truncateToWidth(`${styledPrefix}${styledPrimary}${spacing}${metadata.join("")}`, width, "");
		return isSelected ? this.fillSelected(row, width) : row;
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private renderSelectedDescription(lines: string[], width: number): void {
		const description = this.filteredItems[this.selectedIndex]?.description?.trim();
		if (!description) return;

		const indent = width >= 4 ? "  " : "";
		const contentWidth = Math.max(1, width - visibleWidth(indent) - 2);
		lines.push("");
		for (const line of wrapTextWithAnsi(description, contentWidth)) {
			lines.push(this.theme.description(indent + line));
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
