/**
 * TUI component for managing package resources (enable/disable)
 */

import { basename, dirname, join, relative } from "node:path";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../../../config.js";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../../../core/package-manager.js";
import type { PackageSource, SettingsManager } from "../../../core/settings-manager.js";
import { theme } from "../theme/theme.js";
import { installFocusForwarder } from "./focus-forwarder.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import { MenuPanel, MenuSelector } from "./menu-panel.js";

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	extensions: "Extensions",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
};

interface ResourceItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	resourceType: ResourceType;
	displayName: string;
	groupKey: string;
	subgroupKey: string;
}

interface ResourceSubgroup {
	type: ResourceType;
	label: string;
	items: ResourceItem[];
}

interface ResourceGroup {
	key: string;
	label: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	source: string;
	subgroups: ResourceSubgroup[];
}

function getGroupLabel(metadata: PathMetadata): string {
	if (metadata.origin === "package") {
		return `${metadata.source} (${metadata.scope})`;
	}
	// Top-level resources
	if (metadata.source === "builtin") {
		return "Built-in";
	}
	if (metadata.source === "auto") {
		return metadata.scope === "user" ? `User (~/${CONFIG_DIR_NAME}/)` : `Project (${CONFIG_DIR_NAME}/)`;
	}
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

function buildGroups(resolved: ResolvedPaths): ResourceGroup[] {
	const groupMap = new Map<string, ResourceGroup>();

	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		for (const res of resources) {
			const { path, enabled, metadata } = res;
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}`;

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					key: groupKey,
					label: getGroupLabel(metadata),
					scope: metadata.scope,
					origin: metadata.origin,
					source: metadata.source,
					subgroups: [],
				});
			}

			const group = groupMap.get(groupKey)!;
			const subgroupKey = `${groupKey}:${resourceType}`;

			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			if (!subgroup) {
				subgroup = {
					type: resourceType,
					label: RESOURCE_TYPE_LABELS[resourceType],
					items: [],
				};
				group.subgroups.push(subgroup);
			}

			const fileName = basename(path);
			const parentFolder = basename(dirname(path));
			let displayName: string;
			if (resourceType === "extensions" && parentFolder !== "extensions") {
				displayName = `${parentFolder}/${fileName}`;
			} else if (resourceType === "skills" && fileName === "SKILL.md") {
				displayName = parentFolder;
			} else {
				displayName = fileName;
			}
			subgroup.items.push({
				path,
				enabled,
				metadata,
				resourceType,
				displayName,
				groupKey,
				subgroupKey,
			});
		}
	};

	addToGroup(resolved.extensions, "extensions");
	addToGroup(resolved.skills, "skills");
	addToGroup(resolved.prompts, "prompts");
	addToGroup(resolved.themes, "themes");

	// Sort groups: packages first, then top-level; user before project
	const groups = Array.from(groupMap.values());
	groups.sort((a, b) => {
		if (a.origin !== b.origin) {
			return a.origin === "package" ? -1 : 1;
		}
		if (a.scope !== b.scope) {
			return a.scope === "user" ? -1 : 1;
		}
		return a.source.localeCompare(b.source);
	});

	// Sort subgroups within each group by type order, and items by name
	const typeOrder: Record<ResourceType, number> = { extensions: 0, skills: 1, prompts: 2, themes: 3 };
	for (const group of groups) {
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		for (const subgroup of group.subgroups) {
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}

	return groups;
}

type FlatEntry =
	| { type: "group"; group: ResourceGroup }
	| { type: "subgroup"; subgroup: ResourceSubgroup; group: ResourceGroup }
	| { type: "item"; item: ResourceItem };

class ConfigSelectorHeader implements Component {
	invalidate(): void {}

	render(_width: number): string[] {
		const sep = theme.fg("muted", " · ");
		return [rawKeyHint("space", "toggle") + sep + keyHint("tui.select.cancel", "close", { primaryOnly: true })];
	}
}

class ResourceList implements Component, Focusable {
	private groups: ResourceGroup[];
	private flatItems: FlatEntry[] = [];
	private filteredItems: FlatEntry[] = [];
	private readonly listContainer = new Container();
	private readonly selector: MenuSelector<FlatEntry>;
	private searchInput: Input;
	private settingsManager: SettingsManager;
	private cwd: string;
	private agentDir: string;

	public requestRender?: () => void;
	public onCancel?: () => void;
	public onExit?: () => void;
	public onToggle?: (item: ResourceItem, newEnabled: boolean) => void;

	declare focused: boolean;

	constructor(groups: ResourceGroup[], settingsManager: SettingsManager, cwd: string, agentDir: string) {
		installFocusForwarder(this, () => [this.searchInput]);
		this.groups = groups;
		this.settingsManager = settingsManager;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.searchInput = new Input();
		this.selector = new MenuSelector<FlatEntry>(this.listContainer, {
			preferredVisibleItems: 15,
			reservedRows: () => 0,
			comfortableItemRows: 1,
			isSelectable: (entry) => entry.type === "item",
		});
		this.buildFlatList();
		const firstItemIndex = this.flatItems.findIndex((e) => e.type === "item");
		this.selector.setSelectedIndex(firstItemIndex >= 0 ? firstItemIndex : 0);
		this.filteredItems = [...this.flatItems];
		// Seeds the selector's item list so the isSelectable predicate applies from the start
		this.selector.filter(this.filteredItems, "");
	}

	private buildFlatList(): void {
		this.flatItems = [];
		for (const group of this.groups) {
			this.flatItems.push({ type: "group", group });
			for (const subgroup of group.subgroups) {
				this.flatItems.push({ type: "subgroup", subgroup, group });
				for (const item of subgroup.items) {
					this.flatItems.push({ type: "item", item });
				}
			}
		}
	}

	private filterItems(query: string): void {
		if (!query.trim()) {
			this.filteredItems = [...this.flatItems];
			this.selector.filter(this.filteredItems, query);
			return;
		}

		const lowerQuery = query.toLowerCase();
		const matchingItems = new Set<ResourceItem>();
		const matchingSubgroups = new Set<ResourceSubgroup>();
		const matchingGroups = new Set<ResourceGroup>();

		for (const entry of this.flatItems) {
			if (entry.type === "item") {
				const item = entry.item;
				if (
					item.displayName.toLowerCase().includes(lowerQuery) ||
					item.resourceType.toLowerCase().includes(lowerQuery) ||
					item.path.toLowerCase().includes(lowerQuery)
				) {
					matchingItems.add(item);
				}
			}
		}

		// Find which subgroups and groups contain matching items
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					if (matchingItems.has(item)) {
						matchingSubgroups.add(subgroup);
						matchingGroups.add(group);
					}
				}
			}
		}

		this.filteredItems = [];
		for (const entry of this.flatItems) {
			if (entry.type === "group" && matchingGroups.has(entry.group)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "item" && matchingItems.has(entry.item)) {
				this.filteredItems.push(entry);
			}
		}

		this.selector.filter(this.filteredItems, query);
	}

	updateItem(item: ResourceItem, enabled: boolean): void {
		item.enabled = enabled;
		// Update in groups too
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				const found = subgroup.items.find((i) => i.path === item.path && i.resourceType === item.resourceType);
				if (found) {
					found.enabled = enabled;
					return;
				}
			}
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Search input
		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.filteredItems.length === 0) {
			lines.push(theme.fg("muted", "  No resources found"));
			return lines;
		}

		const { start, end } = this.selector.renderWindow(this.filteredItems, (entry, selected) =>
			this.makeRow(entry, selected, width),
		);
		lines.push(...this.listContainer.render(width));

		// Scroll indicator counts resource items only, not the header rows
		if (start > 0 || end < this.filteredItems.length) {
			const itemCount = this.filteredItems.filter((e) => e.type === "item").length;
			const currentItemIndex =
				this.filteredItems.slice(0, this.selector.getSelectedIndex()).filter((e) => e.type === "item").length + 1;
			lines.push(theme.fg("dim", `  (${currentItemIndex}/${itemCount})`));
		}

		return lines;
	}

	private makeRow(entry: FlatEntry | undefined, selected: boolean, width: number): Text {
		if (entry?.type === "group") {
			// Main group header (no cursor)
			return new Text(truncateToWidth(`  ${theme.fg("accent", theme.bold(entry.group.label))}`, width, ""), 0, 0);
		}
		if (entry?.type === "subgroup") {
			// Subgroup header (indented, no cursor)
			return new Text(truncateToWidth(`    ${theme.fg("muted", entry.subgroup.label)}`, width, ""), 0, 0);
		}
		// Resource item (cursor only on items)
		const item = entry?.item;
		const cursor = selected ? "> " : "  ";
		const checkbox = item?.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
		const name = item && selected ? theme.bold(item.displayName) : (item?.displayName ?? "");
		return new Text(truncateToWidth(`${cursor}    ${checkbox} ${name}`, width, "..."), 0, 0);
	}

	handleInput(data: string): void {
		const handled = this.selector.handleKey(data, {
			totalItems: this.filteredItems.length,
			rerender: () => this.requestRender?.(),
			onConfirm: (index) => this.toggleAt(index),
			onCancel: () => this.onCancel?.(),
		});
		if (handled) return;
		if (matchesKey(data, "ctrl+c")) {
			this.onExit?.();
			return;
		}
		if (data === " ") {
			this.toggleAt(this.selector.getSelectedIndex());
			return;
		}

		// Pass to search input
		this.searchInput.handleInput(data);
		this.filterItems(this.searchInput.getValue());
	}

	private toggleAt(index: number): void {
		const entry = this.filteredItems[index];
		if (entry?.type !== "item") return;
		const newEnabled = !entry.item.enabled;
		this.toggleResource(entry.item, newEnabled);
		this.updateItem(entry.item, newEnabled);
		this.onToggle?.(entry.item, newEnabled);
	}

	private toggleResource(item: ResourceItem, enabled: boolean): void {
		if (item.metadata.origin === "top-level") {
			this.toggleTopLevelResource(item, enabled);
		} else {
			this.togglePackageResource(item, enabled);
		}
	}

	private toggleTopLevelResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (settings[arrayKey] ?? []) as string[];

		// Generate pattern for this resource
		const pattern = this.getResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		if (scope === "project") {
			if (arrayKey === "extensions") {
				this.settingsManager.setProjectExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setProjectSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setProjectPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setProjectThemePaths(updated);
			}
		} else {
			if (arrayKey === "extensions") {
				this.settingsManager.setExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setThemePaths(updated);
			}
		}
	}

	private togglePackageResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const pkgIndex = packages.findIndex((pkg) => {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			return source === item.metadata.source;
		});

		if (pkgIndex === -1) return;

		let pkg = packages[pkgIndex];

		// Convert string to object form if needed
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}

		// Get the resource array for this type
		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (pkg[arrayKey] ?? []) as string[];

		// Generate pattern relative to package root
		const pattern = this.getPackageResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;

		// Clean up empty filter object
		const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
			(k) => (pkg as Record<string, unknown>)[k] !== undefined,
		);
		if (!hasFilters) {
			packages[pkgIndex] = (pkg as { source: string }).source;
		}

		if (scope === "project") {
			this.settingsManager.setProjectPackages(packages);
		} else {
			this.settingsManager.setPackages(packages);
		}
	}

	private getTopLevelBaseDir(scope: "user" | "project"): string {
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}

	private getResourcePattern(item: ResourceItem): string {
		// Built-in resources live under the package install dir; their override
		// patterns are matched relative to metadata.baseDir, not the config dir.
		if (item.metadata.source === "builtin" && item.metadata.baseDir) {
			return relative(item.metadata.baseDir, item.path);
		}
		const scope = item.metadata.scope as "user" | "project";
		const baseDir = this.getTopLevelBaseDir(scope);
		return relative(baseDir, item.path);
	}

	private getPackageResourcePattern(item: ResourceItem): string {
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		return relative(baseDir, item.path);
	}
}

export class ConfigSelectorComponent extends Container implements Focusable {
	private resourceList: ResourceList;

	declare focused: boolean;

	constructor(
		resolvedPaths: ResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
	) {
		super();
		installFocusForwarder(this, () => [this.resourceList]);

		const groups = buildGroups(resolvedPaths);

		// Shared modal chrome so /config looks like every other dialog.
		const panel = new MenuPanel({
			title: "Resource Configuration",
			subtitle: "Type to filter resources",
		});
		this.addChild(panel);

		// Resource list
		this.resourceList = new ResourceList(groups, settingsManager, cwd, agentDir);
		this.resourceList.requestRender = requestRender;
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = () => requestRender();
		panel.addChild(new ConfigSelectorHeader());
		panel.addChild(new Spacer(1));
		panel.addChild(this.resourceList);
	}

	getResourceList(): ResourceList {
		return this.resourceList;
	}
}
