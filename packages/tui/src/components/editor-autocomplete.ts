import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.js";
import { getSlashCommandContext, type SlashCommandContext } from "../slash-command-context.js";
import type { Component, OverlayHandle, TUI } from "../tui.js";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.js";

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	showItemMetadata: true,
	showDirectionalScrollInfo: true,
	showSelectedDescription: true,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;

let autocompleteAnchorId = 0;

/**
 * Buffer and rendering surface the autocomplete controller operates on.
 * Implemented by Editor; keeps the controller decoupled from editor internals.
 */
export interface EditorAutocompleteHost {
	/** Whether the editor currently has keyboard focus. */
	readonly focused: boolean;
	/** Current buffer lines (live reference). */
	getLiveLines(): string[];
	getCursorLine(): number;
	getCursorCol(): number;
	/**
	 * Apply a completion result to the buffer: replace lines, set cursor line,
	 * and clamp/set the cursor column.
	 */
	applyCompletionResult(lines: string[], cursorLine: number, cursorCol: number): void;
	getText(): string;
	pushUndoSnapshot(): void;
	clearLastAction(): void;
	/** Fire onChange with the current text, if a listener is registered. */
	fireOnChange(): void;
	/** Render the suggestion list overlay body for the given width. */
	renderAutocompleteOverlay(width: number): string[];
}

/**
 * Owns the editor's autocomplete integration: slash-command context detection,
 * request/debounce lifecycle, suggestion application, and SelectList creation.
 */
export class EditorAutocomplete {
	private provider?: AutocompleteProvider;
	private list?: SelectList;
	private state: "regular" | "force" | null = null;
	private prefix: string = "";
	private kind?: AutocompleteSuggestions["kind"];
	private maxVisible: number;
	private abort?: AbortController;
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private requestTask: Promise<void> = Promise.resolve();
	private startToken: number = 0;
	private requestId: number = 0;
	private overlay?: OverlayHandle;
	private readonly anchorMarker = `\x1b_pi:autocomplete:${++autocompleteAnchorId}\x07`;
	private readonly overlayComponent: Component;
	private readonly tui: TUI;
	private readonly host: EditorAutocompleteHost;
	private readonly selectListTheme: SelectListTheme;

	constructor(tui: TUI, host: EditorAutocompleteHost, selectListTheme: SelectListTheme, maxVisible: number) {
		this.tui = tui;
		this.host = host;
		this.selectListTheme = selectListTheme;
		this.maxVisible = normalizeMaxVisible(maxVisible);
		this.overlayComponent = {
			render: (width) => host.renderAutocompleteOverlay(width),
			invalidate: () => this.list?.invalidate(),
		};
	}

	getMaxVisible(): number {
		return this.maxVisible;
	}

	setMaxVisible(maxVisible: number): void {
		const newMaxVisible = normalizeMaxVisible(maxVisible);
		if (this.maxVisible !== newMaxVisible) {
			this.maxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	isActive(): boolean {
		return this.state !== null;
	}

	hasOverlay(): boolean {
		return this.overlay !== undefined;
	}

	getAnchorMarker(): string {
		return this.anchorMarker;
	}

	activeList(): SelectList | undefined {
		return this.state && this.list ? this.list : undefined;
	}

	currentPrefix(): string {
		return this.prefix;
	}

	getProvider(): AutocompleteProvider | undefined {
		return this.provider;
	}

	setProvider(provider: AutocompleteProvider): void {
		const wasActive = this.isActive();
		this.provider = provider;
		// An open popup holds suggestions from the previous provider. Re-query
		// instead of dismissing so background provider rebuilds (session resync,
		// extension or settings changes) do not flush the popup while the typed
		// trigger text is still in the buffer.
		if (wasActive) this.update();
	}

	cancel(): void {
		this.cancelRequest();
		this.clearUi();
	}

	isShowing(): boolean {
		return this.state !== null;
	}

	getSlashContext(): SlashCommandContext | null {
		return getSlashCommandContext(this.host.getLiveLines(), this.host.getCursorLine(), this.host.getCursorCol());
	}

	tryTrigger(explicitTab: boolean = false): void {
		this.request({ force: false, explicitTab });
	}

	handleTabCompletion(): void {
		if (!this.provider) return;

		if (this.getSlashContext()?.kind === "name") {
			this.request({ force: false, explicitTab: true });
		} else {
			this.request({ force: true, explicitTab: true });
		}
	}

	update(): void {
		if (!this.state || !this.provider) return;
		this.request({ force: this.state === "force", explicitTab: false });
	}

	refreshAfterEdit(retrigger = false): void {
		const currentLine = this.host.getLiveLines()[this.host.getCursorLine()] || "";
		const textBeforeCursor = currentLine.slice(0, this.host.getCursorCol());
		const hasCompletionContext = this.getSlashContext() !== null || /(?:^|[\s])[@#][^\s]*$/.test(textBeforeCursor);

		if (this.state) {
			if (this.host.getText().trim().length === 0 || (this.state === "regular" && !hasCompletionContext)) {
				this.cancel();
				return;
			}
			this.update();
			return;
		}

		if (retrigger && hasCompletionContext) {
			this.tryTrigger();
		}
	}

	/**
	 * Whether the currently highlighted item is a slash-command completion,
	 * used to decide submit behavior on confirm.
	 */
	isSlashCommandSelection(): boolean {
		return (
			this.kind === "slash-command" ||
			(this.kind === undefined && this.state === "regular" && this.prefix.startsWith("/"))
		);
	}

	private request(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.provider) return;

		if (options.force) {
			const shouldTrigger =
				!this.provider.shouldTriggerFileCompletion ||
				this.provider.shouldTriggerFileCompletion(
					this.host.getLiveLines(),
					this.host.getCursorLine(),
					this.host.getCursorCol(),
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelRequest();
		const startToken = ++this.startToken;

		const debounceMs = this.getDebounceMs(options);
		if (debounceMs > 0) {
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = undefined;
				void this.startRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startRequest(startToken, options);
	}

	private async startRequest(startToken: number, options: { force: boolean; explicitTab: boolean }): Promise<void> {
		const previousTask = this.requestTask;
		this.requestTask = (async () => {
			await previousTask;
			if (startToken !== this.startToken || !this.provider) {
				return;
			}

			const controller = new AbortController();
			this.abort = controller;
			const requestId = ++this.requestId;
			const snapshotText = this.host.getText();
			const snapshotLine = this.host.getCursorLine();
			const snapshotCol = this.host.getCursorCol();

			await this.runRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.requestTask;
	}

	private getDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.host.getLiveLines()[this.host.getCursorLine()] || "";
		const textBeforeCursor = currentLine.slice(0, this.host.getCursorCol());
		const isSymbolAutocompleteContext = /(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|#[^\s]*)$/.test(textBeforeCursor);
		return isSymbolAutocompleteContext ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.provider) return;

		const suggestions = await this.provider.getSuggestions(
			this.host.getLiveLines(),
			this.host.getCursorLine(),
			this.host.getCursorCol(),
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.abort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancel();
			this.tui.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.host.pushUndoSnapshot();
			this.host.clearLastAction();
			const result = this.provider.applyCompletion(
				this.host.getLiveLines(),
				this.host.getCursorLine(),
				this.host.getCursorCol(),
				item,
				suggestions.prefix,
			);
			this.host.applyCompletionResult(result.lines, result.cursorLine, result.cursorCol);
			this.host.fireOnChange();
			this.tui.requestRender();
			return;
		}

		this.applySuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private isRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.requestId &&
			this.host.getText() === snapshotText &&
			this.host.getCursorLine() === snapshotLine &&
			this.host.getCursorCol() === snapshotCol
		);
	}

	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createList(suggestions: AutocompleteSuggestions): SelectList {
		const layout =
			suggestions.kind === "slash-command" || (suggestions.kind === undefined && suggestions.prefix.startsWith("/"))
				? SLASH_COMMAND_SELECT_LIST_LAYOUT
				: undefined;
		return new SelectList(suggestions.items, this.maxVisible, this.selectListTheme, layout);
	}

	private applySuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.prefix = suggestions.prefix;
		this.kind = suggestions.kind;
		this.list = this.createList(suggestions);

		const matchingPrefix = suggestions.kind === "slash-command" ? suggestions.prefix.slice(1) : suggestions.prefix;
		const bestMatchIndex = this.getBestMatchIndex(suggestions.items, matchingPrefix);
		if (bestMatchIndex >= 0) {
			this.list.setSelectedIndex(bestMatchIndex);
		}

		this.state = state;
		if (!this.overlay) {
			this.overlay = this.tui.showOverlay(this.overlayComponent, {
				width: "100%",
				aboveMarker: this.anchorMarker,
				offsetY: -1,
				nonCapturing: true,
				visible: () => this.host.focused && this.state !== null,
			});
		}
	}

	private cancelRequest(): void {
		this.startToken += 1;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		this.abort?.abort();
		this.abort = undefined;
	}

	private clearUi(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		this.state = null;
		this.list = undefined;
		this.prefix = "";
		this.kind = undefined;
	}
}

function normalizeMaxVisible(maxVisible: number): number {
	return Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
}
