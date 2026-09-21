import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	ListNav,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { applyBackgroundAcrossResets } from "./ansi.js";

interface MenuPanelOptions {
	title: string;
	subtitle?: string;
}

export interface MenuViewportProvider {
	getRows?: () => number;
}

interface MenuListOptions {
	compact?: boolean | (() => boolean);
}

interface MenuListLayoutOptions extends MenuViewportProvider {
	preferredVisibleItems: number;
	minVisibleItems?: number;
	totalItems?: number;
	reservedRows: number;
	comfortableItemRows: number;
	compactItemRows?: number;
	scrollIndicatorRows?: number;
	comfortableListPaddingRows?: number;
	compactListPaddingRows?: number;
}

export interface MenuListLayout {
	compact: boolean;
	visibleItems: number;
}

/**
 * Shared modal density. Every dialog derives its padding and list rhythm from
 * this one table so panels read as siblings; tune here, never per component.
 */
export const MODAL_METRICS = {
	/** Blank surface rows above and below the panel content. */
	panelPaddingY: 1,
	/** Horizontal panel inset. */
	panelPaddingX: 2,
	/** Horizontal inset of the search field. */
	fieldPaddingX: 2,
	/** Horizontal inset of list rows. */
	rowPaddingX: 2,
	/** Terminal-row budget per single-line list entry. */
	singleLineItemRows: { comfortable: 2, compact: 1 },
	/** Terminal-row budget per list entry that carries a secondary line. */
	detailedItemRows: { comfortable: 3, compact: 2 },
} as const;

const PANEL_PADDING_X = MODAL_METRICS.panelPaddingX;
const PANEL_PADDING_Y = MODAL_METRICS.panelPaddingY;
const FIELD_PADDING_X = MODAL_METRICS.fieldPaddingX;
const ROW_PADDING_X = MODAL_METRICS.rowPaddingX;
const ROW_PADDING_Y = 1;

/** Shape of a list entry, mapping to the shared row-height budgets. */
export type MenuItemShape = "single" | "detailed";

export function getMenuItemRows(shape: MenuItemShape): { comfortableItemRows: number; compactItemRows: number } {
	const rows = shape === "single" ? MODAL_METRICS.singleLineItemRows : MODAL_METRICS.detailedItemRows;
	return { comfortableItemRows: rows.comfortable, compactItemRows: rows.compact };
}

export function getMenuPanelInnerWidth(width: number): number {
	const safeWidth = Math.max(PANEL_PADDING_X * 2 + 1, width);
	return Math.max(1, safeWidth - PANEL_PADDING_X * 2);
}

interface FullWidthMenuComponent {
	readonly fillsMenuPanel: true;
}

function fillsMenuPanel(component: Component): component is Component & FullWidthMenuComponent {
	return (component as { fillsMenuPanel?: unknown }).fillsMenuPanel === true;
}

function getViewportRows(getRows: (() => number) | undefined): number | undefined {
	const rows = getRows?.();
	if (rows === undefined || !Number.isFinite(rows) || rows <= 0) {
		return undefined;
	}
	return Math.floor(rows);
}

function visibleItemCount(
	rows: number,
	options: {
		preferredVisibleItems: number;
		minVisibleItems: number;
		reservedRows: number;
		itemRows: number;
		listPaddingRows: number;
		extraRows: number;
	},
): number {
	const capacityRows = Math.max(0, rows - options.reservedRows - options.listPaddingRows - options.extraRows);
	const itemCapacity = Math.floor(capacityRows / options.itemRows);
	return Math.max(options.minVisibleItems, Math.min(options.preferredVisibleItems, itemCapacity));
}

function listRowsUsed(options: {
	reservedRows: number;
	listPaddingRows: number;
	visibleItems: number;
	itemRows: number;
	extraRows: number;
}): number {
	return options.reservedRows + options.listPaddingRows + options.extraRows + options.visibleItems * options.itemRows;
}

function scrollIndicatorRows(options: {
	totalItems: number | undefined;
	visibleItems: number;
	scrollIndicatorRows: number;
}): number {
	if (options.totalItems === undefined || options.scrollIndicatorRows <= 0) {
		return 0;
	}
	return options.totalItems > options.visibleItems ? options.scrollIndicatorRows : 0;
}

function getLayoutCandidate(
	rows: number,
	options: MenuListLayoutOptions,
	itemRows: number,
	listPaddingRows: number,
	compact: boolean,
): MenuListLayout & { rowsUsed: number; fits: boolean } {
	const minVisibleItems = options.minVisibleItems ?? 1;
	const preferredVisibleItems = Math.max(minVisibleItems, options.preferredVisibleItems);
	const visibleItemsWithoutScroll = visibleItemCount(rows, {
		preferredVisibleItems,
		minVisibleItems,
		reservedRows: options.reservedRows,
		itemRows,
		listPaddingRows,
		extraRows: 0,
	});
	const extraRows = scrollIndicatorRows({
		totalItems: options.totalItems,
		visibleItems: visibleItemsWithoutScroll,
		scrollIndicatorRows: options.scrollIndicatorRows ?? 0,
	});
	const visibleItems =
		extraRows > 0
			? visibleItemCount(rows, {
					preferredVisibleItems,
					minVisibleItems,
					reservedRows: options.reservedRows,
					itemRows,
					listPaddingRows,
					extraRows,
				})
			: visibleItemsWithoutScroll;
	const rowsUsed = listRowsUsed({
		reservedRows: options.reservedRows,
		listPaddingRows,
		visibleItems,
		itemRows,
		extraRows,
	});
	return {
		compact,
		visibleItems,
		rowsUsed,
		fits: rowsUsed <= rows,
	};
}

export function getMenuListLayout(options: MenuListLayoutOptions): MenuListLayout {
	const minVisibleItems = options.minVisibleItems ?? 1;
	const preferredVisibleItems = Math.max(minVisibleItems, options.preferredVisibleItems);
	const rows = getViewportRows(options.getRows);
	if (rows === undefined) {
		return { compact: false, visibleItems: preferredVisibleItems };
	}

	const comfortableLayout = getLayoutCandidate(
		rows,
		options,
		Math.max(1, options.comfortableItemRows),
		options.comfortableListPaddingRows ?? 1,
		false,
	);
	if (options.compactItemRows === undefined) {
		return { compact: false, visibleItems: comfortableLayout.visibleItems };
	}

	const compactLayout = getLayoutCandidate(
		rows,
		options,
		Math.max(1, options.compactItemRows),
		options.compactListPaddingRows ?? 0,
		true,
	);
	if (compactLayout.fits && (!comfortableLayout.fits || compactLayout.visibleItems > comfortableLayout.visibleItems)) {
		return { compact: true, visibleItems: compactLayout.visibleItems };
	}
	if (comfortableLayout.fits) {
		return { compact: false, visibleItems: comfortableLayout.visibleItems };
	}
	return compactLayout.rowsUsed <= comfortableLayout.rowsUsed
		? { compact: true, visibleItems: compactLayout.visibleItems }
		: { compact: false, visibleItems: comfortableLayout.visibleItems };
}

function paddedBackgroundLine(
	text: string,
	width: number,
	paddingX: number,
	background: ((text: string) => string) | undefined,
): string {
	const innerWidth = Math.max(1, width - paddingX * 2);
	const content = truncateToWidth(text, innerWidth, "");
	const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	const contentSpan = " ".repeat(paddingX) + content;
	const trailingSpan = rightPadding + " ".repeat(paddingX);
	if (!background) {
		return contentSpan + trailingSpan;
	}
	return applyBackgroundAcrossResets(contentSpan, background) + background(trailingSpan);
}

function surfaceLine(text: string, width: number, paddingX = PANEL_PADDING_X): string {
	return paddedBackgroundLine(text, width, paddingX, theme.getEditorBackgroundColor());
}

function surfaceWrappedLines(text: string, width: number, paddingX = PANEL_PADDING_X): string[] {
	const innerWidth = Math.max(1, width - paddingX * 2);
	return wrapTextWithAnsi(text, innerWidth).map((content) => surfaceLine(content, width, paddingX));
}

/**
 * Shared selection + windowing controller for the menu-based selectors
 * (extension-selector, oauth-selector): owns the selected index, the reactive
 * list layout, keyboard navigation, and the windowed row rendering.
 */
export interface MenuSelectorConfig<T> extends MenuViewportProvider {
	preferredVisibleItems: number;
	/** Row shape of this list's entries; picks the shared height budgets. Defaults to "detailed". */
	rowShape?: MenuItemShape;
	scrollIndicatorRows?: number;
	/** Dynamic reserved-row count (headers, tab bars, descriptions). */
	reservedRows: () => number;
	/** Wrap single-step navigation at the ends; paging always clamps. */
	wrapSingleStep?: boolean;
	/**
	 * Predicate marking selectable rows (e.g. skip headers). Defaults to every
	 * row being selectable; navigation and paging never land on a filtered-out row.
	 */
	isSelectable?: (item: T, index: number) => boolean;
}

export class MenuSelector<T> {
	private readonly nav = new ListNav(1);
	private lastFilterQuery = "";
	private items?: readonly T[];
	private layout: MenuListLayout;

	constructor(
		private readonly listContainer: Container,
		private readonly config: MenuSelectorConfig<T>,
	) {
		this.layout = getMenuListLayout({
			preferredVisibleItems: config.preferredVisibleItems,
			reservedRows: config.reservedRows(),
			...getMenuItemRows(config.rowShape ?? "detailed"),
		});
		this.nav.setMaxVisible(Math.max(1, this.layout.visibleItems));
	}

	get visibleItems(): number {
		return this.layout.visibleItems;
	}

	isCompact(): boolean {
		return this.layout.compact;
	}

	getSelectedIndex(): number {
		return this.nav.getSelectedIndex();
	}

	setSelectedIndex(index: number): void {
		this.nav.setSelectedIndex(index, this.items?.length ?? index + 1);
	}

	clampSelectedIndex(totalItems: number): void {
		this.nav.clamp(totalItems);
	}

	/**
	 * Shared post-filter cursor rule: reset to the first row when the search query
	 * changed, otherwise clamp into the filtered result. Matchers stay in each
	 * selector; pass the already-filtered result for `query` here.
	 */
	filter(matches: readonly T[], query: string): void {
		const queryChanged = query !== this.lastFilterQuery;
		this.lastFilterQuery = query;
		this.items = matches;
		if (queryChanged) {
			this.nav.setSelectedIndex(this.firstSelectableIndex(matches.length), matches.length);
		} else {
			this.nav.clamp(matches.length);
			const nearest = this.nearestSelectableIndex(this.nav.getSelectedIndex());
			if (nearest >= 0) this.nav.setSelectedIndex(nearest, matches.length);
		}
	}

	private isSelectableAt(index: number): boolean {
		const predicate = this.config.isSelectable;
		if (!predicate) return true;
		const item = this.items?.[index];
		return item === undefined ? true : predicate(item, index);
	}

	private firstSelectableIndex(totalItems: number): number {
		for (let index = 0; index < totalItems; index++) {
			if (this.isSelectableAt(index)) return index;
		}
		return 0;
	}

	/** Closest selectable row to the given index (forward first), or -1 when there is none. */
	private nearestSelectableIndex(from: number): number {
		if (!this.config.isSelectable) return from;
		const totalItems = this.items?.length ?? 0;
		for (let offset = 0; offset < totalItems; offset++) {
			const forward = from + offset;
			if (forward >= 0 && forward < totalItems && this.isSelectableAt(forward)) return forward;
			const backward = from - offset;
			if (backward >= 0 && backward < totalItems && this.isSelectableAt(backward)) return backward;
		}
		return -1;
	}

	/** Re-run the layout for `totalItems`; true when compact/visibleItems changed. */
	relayout(totalItems: number): boolean {
		const previous = this.layout;
		this.layout = getMenuListLayout({
			getRows: this.config.getRows,
			preferredVisibleItems: this.config.preferredVisibleItems,
			totalItems,
			reservedRows: this.config.reservedRows(),
			...getMenuItemRows(this.config.rowShape ?? "detailed"),
			scrollIndicatorRows: this.config.scrollIndicatorRows,
		});
		this.nav.setMaxVisible(Math.max(1, this.layout.visibleItems));
		return previous.compact !== this.layout.compact || previous.visibleItems !== this.layout.visibleItems;
	}

	/** Move the selection by `delta`; true when the selection changed. */
	moveBy(delta: number, totalItems: number, wrap = false): boolean {
		return this.nav.moveBy(delta, totalItems, wrap);
	}

	/**
	 * Consume the shared navigation keys (up/down/pageUp/pageDown/confirm/cancel).
	 * Returns true when the key was handled.
	 */
	handleKey(
		keyData: string,
		options: {
			totalItems: number;
			rerender: () => void;
			onConfirm: (index: number) => void;
			onCancel: () => void;
		},
	): boolean {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) return this.applySingleStep(-1, options);
		if (kb.matches(keyData, "tui.select.down")) return this.applySingleStep(1, options);
		if (kb.matches(keyData, "tui.select.pageUp")) return this.applyPage(-1, options);
		if (kb.matches(keyData, "tui.select.pageDown")) return this.applyPage(1, options);
		if (kb.matches(keyData, "tui.select.confirm")) {
			options.onConfirm(this.nav.getSelectedIndex());
			return true;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			options.onCancel();
			return true;
		}
		return false;
	}

	private applyMove(delta: number, options: { totalItems: number; rerender: () => void }, wrap = false): boolean {
		if (!this.moveBy(delta, options.totalItems, wrap)) return true;
		options.rerender();
		return true;
	}

	/** Single-step move; with a predicate it skips non-selectable rows and stays put at a boundary. */
	private applySingleStep(direction: 1 | -1, options: { totalItems: number; rerender: () => void }): boolean {
		if (!this.config.isSelectable) {
			return this.applyMove(direction, options, this.config.wrapSingleStep === true);
		}
		const totalItems = options.totalItems;
		const wrap = this.config.wrapSingleStep === true;
		let target = -1;
		if (wrap && totalItems > 0) {
			let index = this.nav.getSelectedIndex();
			do {
				index = (((index + direction) % totalItems) + totalItems) % totalItems;
				if (this.isSelectableAt(index)) {
					target = index;
					break;
				}
			} while (index !== this.nav.getSelectedIndex());
		} else {
			let index = this.nav.getSelectedIndex() + direction;
			while (index >= 0 && index < totalItems) {
				if (this.isSelectableAt(index)) {
					target = index;
					break;
				}
				index += direction;
			}
		}
		if (target < 0 || target === this.nav.getSelectedIndex()) return true;
		this.nav.setSelectedIndex(target, totalItems);
		options.rerender();
		return true;
	}

	/** Page move; with a predicate it clamps by pageSize then walks to the nearest selectable row. */
	private applyPage(direction: 1 | -1, options: { totalItems: number; rerender: () => void }): boolean {
		if (!this.config.isSelectable) {
			return this.applyMove(direction * this.layout.visibleItems, options);
		}
		const totalItems = options.totalItems;
		const pageSize = Math.max(1, this.layout.visibleItems);
		let changed = false;
		if (totalItems > 0) {
			let target: number;
			if (direction === -1) {
				target = Math.max(0, this.nav.getSelectedIndex() - pageSize);
				while (target < totalItems && !this.isSelectableAt(target)) target++;
			} else {
				target = Math.min(totalItems - 1, this.nav.getSelectedIndex() + pageSize);
				while (target >= 0 && !this.isSelectableAt(target)) target--;
			}
			if (target >= 0 && target < totalItems && target !== this.nav.getSelectedIndex()) {
				this.nav.setSelectedIndex(target, totalItems);
				changed = true;
			}
		}
		if (changed) options.rerender();
		return true;
	}

	/** Clear and render the windowed rows plus the shared scroll-position indicator. */
	renderWindow(
		items: readonly T[],
		makeRow: (item: T | undefined, selected: boolean) => Component,
		makeScrollIndicator?: (text: string) => Component,
	): { start: number; end: number } {
		this.listContainer.clear();
		const { start, end } = this.nav.window(items.length);
		for (let i = start; i < end; i++) {
			this.listContainer.addChild(makeRow(items[i], i === this.nav.getSelectedIndex()));
		}
		if ((start > 0 || end < items.length) && makeScrollIndicator) {
			this.listContainer.addChild(makeScrollIndicator(theme.fg("muted", this.nav.position(items.length))));
		}
		return { start, end };
	}
}

export class MenuPanel extends Container {
	private title: string;

	constructor(private readonly options: MenuPanelOptions) {
		super();
		this.title = options.title;
	}

	setTitle(title: string): void {
		this.title = title;
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(PANEL_PADDING_X * 2 + 1, width);
		const innerWidth = getMenuPanelInnerWidth(width);
		const lines: string[] = [];

		for (let i = 0; i < PANEL_PADDING_Y; i++) {
			lines.push(surfaceLine("", safeWidth));
		}
		const hasTitle = this.title.trim().length > 0;
		const subtitle = this.options.subtitle?.trim();
		const hasSubtitle = subtitle !== undefined && subtitle.length > 0;
		const hasHeader = hasTitle || hasSubtitle;
		if (hasTitle) {
			lines.push(surfaceLine(theme.bold(theme.fg("text", this.title)), safeWidth));
		}
		if (hasSubtitle) {
			lines.push(...surfaceWrappedLines(theme.fg("muted", subtitle), safeWidth));
		}
		if (hasHeader) {
			lines.push(surfaceLine("", safeWidth));
		}

		for (const child of this.children) {
			const childLines = fillsMenuPanel(child) ? child.render(safeWidth) : child.render(innerWidth);
			for (const line of childLines) {
				lines.push(fillsMenuPanel(child) ? line : surfaceLine(line, safeWidth));
			}
		}

		for (let i = 0; i < PANEL_PADDING_Y; i++) {
			lines.push(surfaceLine("", safeWidth));
		}
		return lines;
	}
}

export class MenuSearchInput implements Component, Focusable, FullWidthMenuComponent {
	readonly fillsMenuPanel = true;
	private readonly input = new Input();

	constructor(private readonly placeholder: string) {}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	set onSubmit(handler: ((value: string) => void) | undefined) {
		this.input.onSubmit = handler;
	}

	getValue(): string {
		return this.input.getValue();
	}

	getCursor(): number {
		return this.input.getCursor();
	}

	setValue(value: string): void {
		this.input.setValue(value);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(FIELD_PADDING_X * 2 + 1, width);
		const innerWidth = Math.max(1, safeWidth - FIELD_PADDING_X * 2);
		const content =
			this.getValue() === "" && !this.focused
				? theme.fg("dim", this.placeholder)
				: this.stripInputPrompt(this.input.render(innerWidth + 2)[0] ?? "");
		return [paddedBackgroundLine(content, safeWidth, FIELD_PADDING_X, theme.getEditorBackgroundColor())];
	}

	private stripInputPrompt(line: string): string {
		return line.startsWith("> ") ? line.slice(2) : line;
	}
}

interface MenuRowOptions {
	primary: string;
	secondary?: string;
	meta?: string;
	selected: boolean;
}

export class MenuRow implements Component, FullWidthMenuComponent {
	readonly fillsMenuPanel = true;

	constructor(private readonly options: MenuRowOptions) {}

	get selected(): boolean {
		return this.options.selected;
	}

	invalidate(): void {
		// Row render is derived from constructor options.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
		return [
			...this.renderPadding(safeWidth, this.selected),
			...this.renderContent(safeWidth),
			...this.renderPadding(safeWidth, this.selected),
		];
	}

	renderContent(width: number): string[] {
		const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
		const meta = this.options.meta ? theme.fg("muted", this.options.meta) : "";
		const secondary = this.options.secondary ? theme.fg("muted", this.options.secondary) : "";
		const primary = this.options.selected
			? theme.bold(theme.fg("text", this.options.primary))
			: theme.fg("text", this.options.primary);
		const innerWidth = Math.max(1, safeWidth - ROW_PADDING_X * 2);
		const metaWidth = visibleWidth(meta);
		const gap = meta ? 2 : 0;
		const primaryWidth = Math.max(1, innerWidth - metaWidth - gap);
		const primaryText = truncateToWidth(primary, primaryWidth, "", true);
		const primaryLine = meta ? primaryText + " ".repeat(gap) + meta : primaryText;
		const lines: string[] = [];
		lines.push(this.rowLine(primaryLine, safeWidth, this.selected));
		if (secondary) {
			lines.push(this.rowLine(truncateToWidth(secondary, innerWidth, "", true), safeWidth, this.selected));
		}
		return lines;
	}

	renderPadding(width: number, selected: boolean): string[] {
		const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
		const lines: string[] = [];
		for (let i = 0; i < ROW_PADDING_Y; i++) {
			lines.push(this.rowLine("", safeWidth, selected));
		}
		return lines;
	}

	private rowLine(text: string, width: number, selected: boolean): string {
		const background = selected ? theme.getSelectionBackgroundColor() : theme.getEditorBackgroundColor();
		return paddedBackgroundLine(text, width, ROW_PADDING_X, background);
	}
}

export class MenuList extends Container implements FullWidthMenuComponent {
	readonly fillsMenuPanel = true;

	constructor(private readonly options: MenuListOptions = {}) {
		super();
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const compact = this.isCompact();
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			if (child instanceof MenuRow) {
				if (compact) {
					lines.push(...child.renderContent(width));
					continue;
				}
				// Shared density: rows sit flush and the breathing band renders only
				// around the selection bar, so tall lists stay compact.
				if (child.selected) {
					lines.push(...child.renderPadding(width, true));
				}
				lines.push(...child.renderContent(width));
				if (child.selected) {
					lines.push(...child.renderPadding(width, true));
				}
				continue;
			}
			const childLines = fillsMenuPanel(child)
				? child.render(width)
				: child.render(Math.max(1, width - PANEL_PADDING_X * 2));
			for (const line of childLines) {
				lines.push(fillsMenuPanel(child) ? line : surfaceLine(line, width));
			}
		}
		return lines;
	}

	private isCompact(): boolean {
		const compact = this.options.compact;
		return typeof compact === "function" ? compact() : compact === true;
	}
}

/** A text input whose cursor position can be inspected. */
export interface BackGuardInput {
	getCursor(): number;
}

/**
 * True when `data` should dismiss current dialog (acts like Esc).
 * Dialogs with text field pass input: left arrow acts as back only at column 0,
 * else available for cursor movement. Dialogs without field omit `input`.
 */
export function shouldTreatAsBack(data: string, input?: BackGuardInput): boolean {
	if (!getKeybindings().matches(data, "app.modal.back")) {
		return false;
	}
	return input === undefined || input.getCursor() === 0;
}
