import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	BrandSplashHeader,
	getRandomStartHint,
	InteractiveMode,
	START_HINTS,
} from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { OPTIMUS_LOGO } from "../src/themes/optimus-logo.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function createMode(sessionHasMessages = false, returnToAgentsView = false, getEditorText = () => "") {
		const mode = {
			sessionHasMessages,
			options: { returnToAgentsView },
			editor: { getText: getEditorText },
			connectionState: {
				model: { name: "test-model", reasoning: true },
				thinkingLevel: "high",
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("keeps a blank row above the shared splash and limits its metadata", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				topPadding: true,
				getStartHint: () => 'Try "refactor @<filepath>"',
			},
		);

		const lines = header.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(lines[0]).toBe("");
		expect(output).toContain("optimus prime");
		expect(output).toContain("v0.0.0");
		expect(output).toContain("test-model");
		expect(output).toContain("/tmp/project");
		expect(output).toContain('Try "refactor @<filepath>"');
		expect(output).not.toContain("input");
		expect(output).not.toContain("files");
		expect(output).not.toContain("help");

		const unpadded = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
		);
		expect(unpadded.render(120)[0]).not.toBe("");
	});

	it("paints splash metadata over the bottom-right of the mark", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "deepseek/deepseek-v4-flash-0731",
			() => "/tmp/project",
		);

		const logoRows = OPTIMUS_LOGO.split("\n");
		const canvasWidth = logoRows.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		const rendered = header.render(120).map((line) => stripAnsi(line).slice(1));
		const artRows = rendered.slice(0, logoRows.length);

		const metaLines = [
			"optimus prime",
			"version v0.0.0",
			"model   deepseek/deepseek-v4-flash-0731",
			"cwd     /tmp/project",
		];
		const blockWidth = Math.max(...metaLines.map((line) => line.length));
		const blockStart = canvasWidth - blockWidth;
		const blockTop = artRows.length - metaLines.length;

		// Rows above the block keep the mark byte for byte.
		for (const [index, row] of artRows.slice(0, blockTop).entries()) {
			expect(row.trimEnd()).toBe(logoRows[index]);
		}

		for (const [index, meta] of metaLines.entries()) {
			const row = artRows[blockTop + index] ?? "";
			// Right-aligned against the art canvas, not against the trimmed row.
			expect(row.slice(blockStart, canvasWidth).trimEnd()).toBe(meta);
			// One blank gutter column keeps the ink from touching the text.
			expect(row[blockStart - 1]).toBe(" ");
			expect(row.slice(0, blockStart - 1)).toBe((logoRows[blockTop + index] ?? "").slice(0, blockStart - 1));
		}

		expect(rendered.some((row) => row.includes("type to search sessions"))).toBe(true);
	});

	it("shows the whole model id instead of truncating it", () => {
		const modelId = "deepseek/deepseek-v4-flash-0731";
		const header = new BrandSplashHeader(
			"0.0.0",
			() => modelId,
			() => "/tmp/project",
		);

		for (const width of [80, 120]) {
			expect(stripAnsi(header.render(width).join("\n"))).toContain(modelId);
		}
	});

	it("starts the mark at the head row with no orphan antenna glyph", () => {
		const logoRows = OPTIMUS_LOGO.split("\n");
		const inkColumn = (row: string) => [...row].findIndex((char) => char !== "⠀" && char !== " ");
		const inkCount = (row: string) => [...row].filter((char) => char !== "⠀" && char !== " ").length;

		expect(logoRows).toHaveLength(18);
		expect(inkColumn(logoRows[0] ?? "")).toBe(16);
		// A row carrying a single glyph reads as a rendering artifact, not as art.
		expect(logoRows.filter((row) => inkCount(row) <= 1)).toEqual([]);
	});

	it("does not wrap or throw in narrow terminals", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
		);

		for (const width of [60, 80, 120]) {
			const lines = header.render(width);
			for (const line of lines) {
				expect(stripAnsi(line)).not.toContain("\n");
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	it("randomly selects from five concise filepath prompts", () => {
		expect(START_HINTS).toHaveLength(5);
		expect(new Set(START_HINTS).size).toBe(5);

		for (const [index, hint] of START_HINTS.entries()) {
			expect(getRandomStartHint(() => index / START_HINTS.length)).toBe(hint);
			expect(hint).toMatch(/^Try ".*@<filepath>.*"$/);
		}
	});

	it("places the fresh-chat shortcut hint after the model and effort", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high  ? for shortcuts");
	});

	it("routes session-view requests through the existing agents-view return path", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, true), { returnToAgentsView });

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
	});

	it("explains why a draft blocks the destructive agents-view handoff", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(false, true, () => "draft prompt"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Send, stash, or clear your draft before opening agents");
	});

	it("opens the shared session view on back navigation for process-local chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, false), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(requestAgentsView).toHaveBeenCalledOnce();
		expect(returnToAgentsView).not.toHaveBeenCalled();
	});

	it("returns to the daemon agents view on back navigation for daemon chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, true), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("leaves back navigation to the editor while a draft exists", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const mode = Object.assign(
			createMode(false, false, () => "draft prompt"),
			{ requestAgentsView },
		);

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(false);
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("explains that the agents view needs the daemon for non-daemon chats", async () => {
		const showStatus = vi.fn();
		const shutdown = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, false), {
			returnToAgentsView: vi.fn(async () => {}),
			showStatus,
			shutdown,
		});

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("needs the daemon"));
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("keeps the lowercase agents hint while typing", () => {
		let editorText = "";
		const mode = createMode(false, true, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("← agents/resume  test-model • high  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("← agents/resume  test-model • high");
	});

	it("hides the fresh-chat shortcut hint while the prompt has text", () => {
		let editorText = "";
		const mode = createMode(false, false, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("test-model • high  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("test-model • high");

		editorText = " ";
		expect(stripAnsi(getLabel())).toBe("test-model • high");

		editorText = "";
		expect(stripAnsi(getLabel())).toBe("test-model • high  ? for shortcuts");
	});

	it("hides the tray shortcut guidance for chats with history", () => {
		const mode = createMode(true);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high");
	});

	it("keeps the question-mark shortcut guide compact", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getShortcutGuide").call(createMode());

		expect(guide).toContain("`!` shell mode · `/` commands · `@` file paths");
		expect(guide).toContain("stash prompt");
		expect(guide).toContain("`/hotkeys` full reference");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("suspend");
		expect(guide).not.toContain("**Navigation**");
		expect(guide).not.toContain("**Extensions**");
	});

	it("renders question-mark shortcut help ephemerally without appending to chat history", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);
		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);

		expect(chatContainer.children).toHaveLength(0);
		expect(shortcutGuideContainer.children).toHaveLength(2);

		Reflect.get(InteractiveMode.prototype, "clearShortcutGuide").call(mode);

		expect(shortcutGuideContainer.children).toHaveLength(0);
	});

	it("keeps /hotkeys comprehensive without Ctrl+Z", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getHotkeysGuide").call(createMode());

		expect(guide).toContain("**Navigation**");
		expect(guide).toContain("**Editing**");
		expect(guide).toContain("**Fullscreen mode (`/fullscreen`)**");
		expect(guide).toContain("Queue follow-up message");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("Suspend to background");
	});

	it("renders /hotkeys in chat history instead of the temporary guide", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);

		expect(chatContainer.children).toHaveLength(2);
		expect(shortcutGuideContainer.children).toHaveLength(0);
	});
});
