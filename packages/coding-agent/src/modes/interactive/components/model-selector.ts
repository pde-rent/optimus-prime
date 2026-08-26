import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyMatch,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { errorMessage } from "../../../utils/shared.js";
import { theme } from "../theme/theme.js";
import { installFocusForwarder } from "./focus-forwarder.js";
import { keyHint } from "./keybinding-hints.js";
import { MenuList, MenuPanel, MenuRow, MenuSearchInput, MenuSelector } from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<Api>;
}

interface ScopedModelItem {
	model: Model<Api>;
	thinkingLevel?: string;
}

enum ModelSearchMatchQuality {
	ExactShortId,
	ExactFullId,
	PrefixOrToken,
	Fuzzy,
}

interface ModelSearchMatch {
	quality: ModelSearchMatchQuality;
	score: number;
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[\s\-_.:/]+/g, "");
}

function getModelSearchFields(item: ModelItem): { shortId: string; fullIds: string[]; all: string[] } {
	const shortId = item.id.slice(item.id.lastIndexOf("/") + 1);
	const fullIds = [item.id, `${item.provider}/${item.id}`];
	return {
		shortId,
		fullIds,
		all: [shortId, ...fullIds, item.model.name, item.provider],
	};
}

function getBestFuzzyScore(queryTokens: string[], fields: string[]): number | null {
	let total = 0;
	for (const token of queryTokens) {
		let best = Number.POSITIVE_INFINITY;
		for (const field of fields) {
			const match = fuzzyMatch(token, field);
			if (match.matches) best = Math.min(best, match.score);
		}
		if (!Number.isFinite(best)) return null;
		total += best;
	}
	return total;
}

function scoreModelSearch(item: ModelItem, query: string): ModelSearchMatch | null {
	const queryTokens = query.trim().split(/\s+/);
	const normalizedQuery = normalizeModelSearchText(query);
	const normalizedTokens = queryTokens.map(normalizeModelSearchText).filter(Boolean);
	if (!normalizedQuery || normalizedTokens.length === 0) return null;

	const fields = getModelSearchFields(item);
	if (normalizeModelSearchText(fields.shortId) === normalizedQuery) {
		return { quality: ModelSearchMatchQuality.ExactShortId, score: 0 };
	}
	if (fields.fullIds.some((field) => normalizeModelSearchText(field) === normalizedQuery)) {
		return { quality: ModelSearchMatchQuality.ExactFullId, score: 0 };
	}

	const normalizedFields = fields.all.map(normalizeModelSearchText);
	const fieldTokens = fields.all
		.flatMap((field) => field.split(/[\s/_-]+/))
		.map(normalizeModelSearchText)
		.filter(Boolean);
	const fuzzyScore = getBestFuzzyScore(normalizedTokens, normalizedFields);
	const isPrefixOrToken = normalizedTokens.every(
		(token) =>
			normalizedFields.some((field) => field.startsWith(token)) ||
			fieldTokens.some((field) => field.startsWith(token)),
	);
	if (isPrefixOrToken && fuzzyScore !== null) {
		return { quality: ModelSearchMatchQuality.PrefixOrToken, score: fuzzyScore };
	}
	return fuzzyScore === null ? null : { quality: ModelSearchMatchQuality.Fuzzy, score: fuzzyScore };
}

export interface ModelSelectorOptions {
	availableModels?: ReadonlyArray<Model<Api>>;
	configuredProviders?: ReadonlySet<string>;
	header?: Component;
	getHeaderRows?: () => number;
	subtitle?: string;
	getRows?: () => number;
	recentModels?: ReadonlyArray<string>;
}

type ModelScope = "all" | "scoped";

const PREFERRED_VISIBLE_MODELS = 10;
const MODEL_LIST_RESERVED_ROWS = {
	base: 7,
	detail: 2,
};
const MODEL_SCROLL_INDICATOR_ROWS = 1;
const MODEL_HELP_MIN_ROWS = 12;
const MODEL_DETAIL_MIN_ROWS = 14;
const PROVIDER_FILTER_PREFIX = "provider:";

/** Split a `provider:<name>` search prefix from the rest of the query. */
function splitProviderFilter(query: string): { text: string; provider?: string } {
	if (!query.startsWith(PROVIDER_FILTER_PREFIX)) return { text: query };
	const provider = query.slice(PROVIDER_FILTER_PREFIX.length).trim().toLowerCase();
	return provider ? { text: "", provider } : { text: "" };
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: MenuSearchInput;

	declare focused: boolean;
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private currentModel?: Model<Api>;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<Api>) => void;
	private onCancelCallback: () => void;
	private availableModels?: ReadonlyArray<Model<Api>>;
	private configuredProviders?: ReadonlySet<string>;
	private recentRank: Map<string, number>;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private panel: MenuPanel;
	private headerHelpContainer: Container;
	private warningText?: Text;
	private selector: MenuSelector<ModelItem>;
	private headerHelpRows = 0;
	private readonly getRows: (() => number) | undefined;
	private readonly getHeaderRows: () => number;

	constructor(
		tui: TUI,
		currentModel: Model<Api> | undefined,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<Api>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		options: ModelSelectorOptions = {},
	) {
		super();
		installFocusForwarder(this, () => [this.searchInput]);

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.availableModels = options.availableModels;
		this.configuredProviders = options.configuredProviders;
		this.recentRank = new Map((options.recentModels ?? []).map((key, i) => [key, i]));
		this.getRows = options.getRows;
		this.getHeaderRows = options.header ? (options.getHeaderRows ?? (() => 2)) : () => 0;

		this.panel = new MenuPanel({
			title: "Models",
			subtitle: options.subtitle ?? "All models across supported providers.",
		});
		this.addChild(this.panel);
		if (options.header) {
			this.panel.addChild(options.header);
			this.panel.addChild(new Spacer(1));
		}

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		} else {
			const hintText =
				"Signed-in providers first. Other models prompt sign-in. Type provider:<name> to filter by provider.";
			this.warningText = new Text(theme.fg("muted", hintText), 0, 0);
		}
		this.headerHelpContainer = new Container();
		this.panel.addChild(this.headerHelpContainer);

		// Create search input
		this.searchInput = new MenuSearchInput("Search models");
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			this.handleConfirm();
		};
		this.panel.addChild(this.searchInput);

		this.panel.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new MenuList({ compact: () => this.selector.isCompact() });
		this.panel.addChild(this.listContainer);
		this.selector = new MenuSelector<ModelItem>(this.listContainer, {
			getRows: options.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_MODELS,
			reservedRows: () => this.reservedRows,
			scrollIndicatorRows: MODEL_SCROLL_INDICATOR_ROWS,
			wrapSingleStep: true,
		});

		this.loadModels();
		if (initialSearchInput) {
			this.filterModels(initialSearchInput);
		} else {
			this.updateList();
		}
		this.tui.requestRender();
	}

	updateAvailableModels(availableModels: ReadonlyArray<Model<Api>>): void {
		this.updateState(this.currentModel, availableModels);
	}

	updateState(
		currentModel: Model<Api> | undefined,
		availableModels = this.availableModels,
		configuredProviders = this.configuredProviders,
	): void {
		this.currentModel = currentModel;
		this.availableModels = availableModels;
		this.configuredProviders = configuredProviders;
		const query = this.searchInput.getValue();
		const selectedKey = this.getSelectedModelKey();

		this.loadModels();
		this.filterModels(query);

		if (selectedKey) {
			const selectedIndex = this.filteredModels.findIndex((item) => this.getModelKey(item) === selectedKey);
			if (selectedIndex >= 0) {
				this.selector.setSelectedIndex(selectedIndex);
				this.updateList();
			}
		}

		this.tui.requestRender();
	}

	private loadModels(): void {
		let models: ModelItem[];
		this.errorMessage = undefined;

		if (this.availableModels === undefined) {
			this.modelRegistry.refresh();
			const loadError = this.modelRegistry.getError();
			if (loadError) {
				this.errorMessage = loadError;
			}
		}

		// Load available models (built-in models still work even if models.json failed)
		let availableModels: ReadonlyArray<Model<Api>>;
		try {
			availableModels =
				this.availableModels !== undefined ? this.availableModels : this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<Api>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = errorMessage(error);
			return;
		}

		this.allModels = this.sortModels(models);
		const availableModelsById = new Map(availableModels.map((model) => [`${model.provider}/${model.id}`, model]));
		this.scopedModels = this.scopedModels.map((scoped) => {
			const scopedModelId = `${scoped.model.provider}/${scoped.model.id}`;
			const refreshed =
				availableModelsById.get(scopedModelId) ??
				(this.availableModels !== undefined
					? undefined
					: this.modelRegistry.find(scoped.model.provider, scoped.model.id));
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		if (currentIndex >= 0) {
			this.selector.setSelectedIndex(currentIndex);
		} else {
			this.selector.clampSelectedIndex(this.filteredModels.length);
		}
	}

	private getModelKey(item: ModelItem): string {
		return `${item.provider}/${item.id}`;
	}

	private getSelectedModelKey(): string | undefined {
		const selected = this.filteredModels[this.selector.getSelectedIndex()];
		return selected ? this.getModelKey(selected) : undefined;
	}

	private recentRankOf(item: ModelItem): number {
		// Finite sentinel so subtracting two non-recent ranks yields 0, not NaN.
		return this.recentRank.get(`${item.provider}/${item.id}`) ?? Number.MAX_SAFE_INTEGER;
	}

	private isProviderConfigured(item: ModelItem): boolean {
		return this.configuredProviders?.has(item.provider) || this.modelRegistry.hasConfiguredAuth(item.model);
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		sorted.sort((a, b) => {
			const configuredDiff = Number(this.isProviderConfigured(b)) - Number(this.isProviderConfigured(a));
			if (configuredDiff !== 0) return configuredDiff;
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
			const rankDiff = this.recentRankOf(a) - this.recentRankOf(b);
			if (rankDiff !== 0) return rankDiff;
			const providerDiff = a.provider.localeCompare(b.provider);
			if (providerDiff !== 0) return providerDiff;
			const aFeatured = a.model.featured === true;
			const bFeatured = b.model.featured === true;
			if (aFeatured !== bFeatured) return aFeatured ? -1 : 1;
			return a.id.localeCompare(b.id, undefined, { numeric: true });
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("app.model.toggleScope", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selector.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		const { text, provider } = splitProviderFilter(query.trim());
		const pool = provider
			? this.activeModels.filter((item) => item.provider.toLowerCase().includes(provider))
			: this.activeModels;
		let matches: ModelItem[];
		if (text) {
			const scored = pool.flatMap((item) => {
				const match = scoreModelSearch(item, text);
				return match ? [{ item, ...match }] : [];
			});
			scored.sort(
				(a, b) =>
					a.quality - b.quality ||
					a.score - b.score ||
					Number(this.isProviderConfigured(b.item)) - Number(this.isProviderConfigured(a.item)) ||
					Number(modelsAreEqual(this.currentModel, b.item.model)) -
						Number(modelsAreEqual(this.currentModel, a.item.model)) ||
					this.recentRankOf(a.item) - this.recentRankOf(b.item) ||
					this.getModelKey(a.item).localeCompare(this.getModelKey(b.item), undefined, { numeric: true }),
			);
			matches = scored.map(({ item }) => item);
		} else {
			matches = pool;
		}
		this.filteredModels = matches;
		// Shared post-filter cursor rule lives in MenuSelector.filter.
		this.selector.filter(matches, query);
		this.updateList();
	}

	override render(width: number): string[] {
		this.syncHeaderHelp();
		if (this.selector.relayout(this.filteredModels.length)) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.syncHeaderHelp();
		this.selector.relayout(this.filteredModels.length);
		this.selector.renderWindow(
			this.filteredModels,
			(item, selected) => {
				const isCurrent = modelsAreEqual(this.currentModel, item?.model);
				const isConfigured = item !== undefined && this.isProviderConfigured(item);
				const meta = !item
					? undefined
					: isConfigured
						? isCurrent
							? theme.fg("success", "current")
							: undefined
						: theme.fg("warning", isCurrent ? "current · sign in" : "sign in");
				return new MenuRow({
					primary: item?.id ?? "",
					secondary: item?.model.output?.some((m) => m !== "text")
						? `${item.provider} · ${item.model.output.filter((m) => m !== "text").join("+")} out`
						: (item?.provider ?? ""),
					meta,
					selected,
				});
			},
			(text) => new Text(text, 0, 0),
		);

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selector.getSelectedIndex()];
			if (selected && this.shouldShowSelectedDetails()) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(theme.fg("muted", selected.model.name), 0, 0));
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.model.toggleScope")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		const handled = this.selector.handleKey(keyData, {
			totalItems: this.filteredModels.length,
			rerender: () => this.updateList(),
			onConfirm: () => this.handleConfirm(),
			onCancel: () => this.onCancelCallback(),
		});
		if (handled) return;
		// Left arrow when the search field is at its start dismisses the selector.
		if (shouldTreatAsBack(keyData, this.searchInput)) {
			this.onCancelCallback();
			return;
		}
		// Pass everything else to search input
		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
	}

	private handleSelect(model: Model<Api>): void {
		this.onSelectCallback(model);
	}

	private handleConfirm(): void {
		const selectedModel = this.filteredModels[this.selector.getSelectedIndex()];
		if (selectedModel) {
			this.handleSelect(selectedModel.model);
		}
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	private syncHeaderHelp(): void {
		let headerHelpRows = 0;
		this.headerHelpContainer.clear();
		if (this.shouldShowHeaderHelp()) {
			if (this.scopeText && this.scopeHintText) {
				this.headerHelpContainer.addChild(this.scopeText);
				this.headerHelpContainer.addChild(this.scopeHintText);
				headerHelpRows += 2;
			} else if (this.warningText) {
				this.headerHelpContainer.addChild(this.warningText);
				headerHelpRows += 1;
			}
			this.headerHelpContainer.addChild(new Spacer(1));
			headerHelpRows += 1;
		}
		this.headerHelpRows = headerHelpRows;
	}

	/** Reserved-row arithmetic for the shared list layout (base chrome, optional header/help/detail). */
	private get reservedRows(): number {
		return (
			MODEL_LIST_RESERVED_ROWS.base +
			this.getHeaderRows() +
			this.headerHelpRows +
			(this.shouldShowSelectedDetails() ? MODEL_LIST_RESERVED_ROWS.detail : 0)
		);
	}

	private shouldShowHeaderHelp(): boolean {
		return this.hasRows(MODEL_HELP_MIN_ROWS);
	}

	private shouldShowSelectedDetails(): boolean {
		return this.hasRows(MODEL_DETAIL_MIN_ROWS);
	}

	private hasRows(minRows: number): boolean {
		const rows = this.getRows?.();
		return rows === undefined || !Number.isFinite(rows) || rows >= minRows;
	}
}
