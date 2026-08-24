import type { Api, Model } from "@earendil-works/pi-ai";
import {
	Container,
	dotJoin,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { installFocusForwarder } from "./focus-forwarder.js";
import { keyHint, keyText, selectionHints } from "./keybinding-hints.js";

type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

function toggle(enabledIds: EnabledIds, id: string): EnabledIds {
	if (enabledIds === null) return [id]; // First toggle: start with only this one
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return [...enabledIds, id];
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length ? null : result;
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

interface ModelItem {
	fullId: string;
	model: Model<Api>;
	enabled: boolean;
}

export interface ModelsConfig {
	allModels: Model<Api>[];
	enabledModelIds: string[] | null;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<Api>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private filteredItems: ModelItem[] = [];
	private selectedIndex = 0;
	private searchQuery = "";
	private searchInput: Input;

	declare focused: boolean;
	private selectList: SelectList;
	private detailText: Text;
	private footerText: Text;
	private callbacks: ModelsCallbacks;
	private maxVisible = 8;
	private isDirty = false;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		installFocusForwarder(this, () => [this.searchInput]);
		this.callbacks = callbacks;

		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.filteredItems = this.buildItems();

		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = new SelectList([], this.maxVisible, getSelectListTheme(), {
			multiSelect: true,
			noMatchText: "  No matching models",
			// The enabled tick and provider badge are the only per-row difference
			// from every other list; the window, wrap and readout are shared.
			renderRow: ({ index, isSelected }) => this.renderModelRow(index, isSelected),
		});
		this.selectList.onToggle = (item) => this.toggleModel(item.value);
		this.addChild(this.selectList);

		this.addChild(new Spacer(1));
		this.detailText = new Text("", 0, 0);
		this.addChild(this.detailText);

		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.updateList();
	}

	private buildItems(): ModelItem[] {
		// Filter out IDs that no longer have a corresponding model (e.g., after logout)
		return getSortedIds(this.enabledIds, this.allIds)
			.filter((id) => this.modelsById.has(id))
			.map((id) => ({
				fullId: id,
				model: this.modelsById.get(id)!,
				enabled: isEnabled(this.enabledIds, id),
			}));
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.length ?? this.allIds.length;
		const countText = this.enabledIds === null ? "all enabled" : `${enabledCount}/${this.allIds.length} enabled`;
		const hints = selectionHints([
			keyHint("app.models.enableAll", "all"),
			keyHint("app.models.clearAll", "clear"),
			keyHint("app.models.toggleProvider", "provider"),
			`${theme.fg("dim", `${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")}`)}${theme.fg("muted", " reorder")}`,
			keyHint("app.models.save", "save"),
		]);
		return `  ${dotJoin([hints, theme.fg("muted", countText), this.isDirty ? theme.fg("warning", "(unsaved)") : undefined], theme.fg("dim", " · "))}`;
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		const items = this.buildItems();
		this.filteredItems = query ? fuzzyFilter(items, query, (i) => `${i.model.id} ${i.model.provider}`) : items;
		this.selectedIndex = queryChanged ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private notifyChange(): void {
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private renderModelRow(index: number, isSelected: boolean): string {
		const item = this.filteredItems[index];
		if (!item) return "";
		const prefix = isSelected ? theme.fg("accent", "❯ ") : "  ";
		const modelText = isSelected ? theme.fg("accent", item.model.id) : item.model.id;
		const providerBadge = theme.fg("muted", ` [${item.model.provider}]`);
		// No tick when nothing is scoped: every model is enabled, so a column of
		// ticks would read as a selection the user did not make.
		const status = this.enabledIds === null ? "" : item.enabled ? theme.fg("success", " ✓") : theme.fg("dim", " ✗");
		return `${prefix}${modelText}${providerBadge}${status}`;
	}

	private updateList(): void {
		this.selectList.setItems(this.filteredItems.map((item) => ({ value: item.fullId, label: item.model.id })));
		this.selectList.setSelectedIndex(this.selectedIndex);
		const selected = this.filteredItems[this.selectedIndex];
		this.detailText.setText(selected ? theme.fg("muted", `  Model Name: ${selected.model.name}`) : "");
	}

	private toggleModel(fullId: string): void {
		this.enabledIds = toggle(this.enabledIds, fullId);
		this.isDirty = true;
		this.refresh();
		this.notifyChange();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown")
		) {
			this.selectList.handleInput(data);
			this.selectedIndex = this.selectList.getSelectedIndex();
			this.updateList();
			return;
		}

		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return;
			const item = this.filteredItems[this.selectedIndex];
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					this.isDirty = true;
					this.selectedIndex += delta;
					this.refresh();
					this.notifyChange();
				}
			}
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			this.selectList.handleInput(data);
			return;
		}

		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		if (kb.matches(data, "app.models.save")) {
			this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
