import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type Container, setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import stripAnsi from "../src/utils/ansi.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function resource(path: string, enabled: boolean, metadata: PathMetadata): ResolvedResource {
	return { path, enabled, metadata };
}

function packageMeta(source: string): PathMetadata {
	return { source, scope: "user", origin: "package" };
}

function createSelector(paths: ResolvedPaths): ConfigSelectorComponent {
	return new ConfigSelectorComponent(
		paths,
		SettingsManager.inMemory(),
		"/w",
		"/agent",
		() => {},
		() => {},
		() => {},
	);
}

/** Flat rows: group A header, subgroup headers between each pair of items. */
function buildGroupedPaths(): ResolvedPaths {
	return {
		extensions: [resource("/w/extensions/ext-a.ts", false, packageMeta("pkg-a"))],
		skills: [
			resource("/w/skills/alpha/SKILL.md", true, packageMeta("pkg-a")),
			resource("/w/skills/omega/SKILL.md", false, packageMeta("pkg-a")),
			resource("/w/skills/beta/SKILL.md", true, packageMeta("pkg-b")),
		],
		prompts: [],
		themes: [],
		diagnostics: [],
	};
}

/** One group, one subgroup, n items: rows are header, header, items. */
function buildLongPaths(itemCount: number): ResolvedPaths {
	const digits = String(itemCount).length;
	return {
		extensions: [],
		skills: Array.from({ length: itemCount }, (_, index) =>
			resource(`/w/skills/skill-${String(index + 1).padStart(digits, "0")}/SKILL.md`, false, packageMeta("pkg-a")),
		),
		prompts: [],
		themes: [],
		diagnostics: [],
	};
}

/** The row currently carrying the cursor, stripped of ANSI codes. */
function selectedRow(component: Container): string {
	const line = component
		.render(80)
		.map((value) => stripAnsi(value))
		.find((value) => value.trim().startsWith(">") && value.includes("["));
	return line ?? "";
}

function renderedOutput(component: Container): string {
	return component
		.render(80)
		.map((value) => stripAnsi(value))
		.join("\n");
}

describe("ConfigSelectorComponent navigation", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("starts on the first resource and skips headers when moving", () => {
		const selector = createSelector(buildGroupedPaths());
		const list = selector.getResourceList();

		expect(selectedRow(selector)).toContain("ext-a.ts");

		list.handleInput(DOWN); // skips the Skills subgroup header
		expect(selectedRow(selector)).toContain("[x] alpha");

		list.handleInput(DOWN);
		expect(selectedRow(selector)).toContain("omega");

		list.handleInput(DOWN); // skips the pkg-b group header and its subgroup header
		expect(selectedRow(selector)).toContain("[x] beta");
	});

	it("stays put when moving past either end", () => {
		const selector = createSelector(buildGroupedPaths());
		const list = selector.getResourceList();

		list.handleInput(UP);
		expect(selectedRow(selector)).toContain("ext-a.ts");

		list.handleInput(DOWN);
		list.handleInput(DOWN);
		list.handleInput(DOWN);
		expect(selectedRow(selector)).toContain("[x] beta");
		list.handleInput(DOWN); // last resource
		expect(selectedRow(selector)).toContain("[x] beta");

		list.handleInput(UP); // skips both pkg-b headers
		expect(selectedRow(selector)).toContain("omega");
	});

	it("pages to the last and first resources in a short list", () => {
		const selector = createSelector(buildGroupedPaths());
		const list = selector.getResourceList();

		list.handleInput(PAGE_DOWN); // clamps to the bottom row, then walks back to an item
		expect(selectedRow(selector)).toContain("[x] beta");

		list.handleInput(PAGE_UP); // clamps to the top row, then walks forward to an item
		expect(selectedRow(selector)).toContain("ext-a.ts");
	});

	it("pages by the visible window across a long list of items", () => {
		const selector = createSelector(buildLongPaths(20));
		const list = selector.getResourceList();

		expect(selectedRow(selector)).toContain("skill-01");

		list.handleInput(PAGE_DOWN); // 2 + 15 lands directly on an item
		expect(selectedRow(selector)).toContain("skill-16");
		expect(renderedOutput(selector)).toContain("(16/20)");

		list.handleInput(PAGE_UP); // 16 - 15 walks forward from the top to the first item
		expect(selectedRow(selector)).toContain("skill-01");
	});

	it("resets to the first match when the search query changes", () => {
		const selector = createSelector(buildGroupedPaths());
		const list = selector.getResourceList();
		const toggles: string[] = [];
		list.onToggle = (item) => {
			toggles.push(item.displayName);
		};

		list.handleInput(DOWN);
		list.handleInput(DOWN);
		expect(selectedRow(selector)).toContain("omega");

		list.handleInput("beta"); // only pkg-b's skill matches
		expect(selectedRow(selector)).toContain("[x] beta");

		list.handleInput("\r"); // confirm acts on the matched resource
		expect(toggles).toEqual(["beta"]);
	});

	it("toggles the selected resource with space", () => {
		const selector = createSelector(buildGroupedPaths());
		const list = selector.getResourceList();
		const toggles: string[] = [];
		list.onToggle = (item) => {
			toggles.push(item.path);
		};

		list.handleInput(" ");
		expect(toggles).toEqual(["/w/extensions/ext-a.ts"]);
		expect(selectedRow(selector)).toContain("[x] ext-a.ts");
	});
});
