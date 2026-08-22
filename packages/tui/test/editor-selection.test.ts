import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

// Legacy shift-modified arrow sequences (see LEGACY_SEQUENCE_KEY_IDS in keys.ts)
const SHIFT_LEFT = "\x1b[d";
const SHIFT_RIGHT = "\x1b[c";
const SHIFT_DOWN = "\x1b[b";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const HOME = "\x01"; // ctrl+a - column 0 of the current line
const END = "\x05"; // ctrl+e - end of the current line
const DELETE_KEY = "\x1b[3~";
const BACKSPACE = "\x7f";

describe("Editor selection", () => {
	it("shift+Right extends a selection from the cursor (anchor/head tracked)", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(HOME);

		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT);

		assert.strictEqual(editor.hasSelection(), true);
		assert.deepStrictEqual(editor.getSelectionAnchor(), { line: 0, col: 0 });
		assert.deepStrictEqual(editor.getSelectionHead(), { line: 0, col: 3 });
		assert.strictEqual(editor.getSelectedText(), "hel");
	});

	it("shift+Left selects backwards", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(END);

		editor.handleInput(SHIFT_LEFT);
		editor.handleInput(SHIFT_LEFT);

		assert.strictEqual(editor.hasSelection(), true);
		assert.strictEqual(editor.getSelectedText(), "ld");
	});

	it("Delete deletes the selected range instead of the next character", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(HOME);

		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT); // 'hel' selected
		editor.handleInput(DELETE_KEY);

		assert.strictEqual(editor.getText(), "lo world");
		assert.strictEqual(editor.hasSelection(), false);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("Backspace deletes the selected range instead of the previous character", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(END);

		editor.handleInput(SHIFT_LEFT);
		editor.handleInput(SHIFT_LEFT); // 'ld'
		editor.handleInput(BACKSPACE);

		assert.strictEqual(editor.getText(), "hello wor");
		assert.strictEqual(editor.hasSelection(), false);
	});

	it("typing replaces the selection", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(HOME);

		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT); // 'he'
		editor.handleInput("H");

		assert.strictEqual(editor.getText(), "Hllo world");
		assert.strictEqual(editor.hasSelection(), false);
	});

	it("plain cursor movement clears the selection without deleting", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(HOME);

		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT);
		assert.strictEqual(editor.hasSelection(), true);

		editor.handleInput(LEFT);
		assert.strictEqual(editor.hasSelection(), false);
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("deleteSelectedRange spans multiple lines", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("first\nsecond\nthird");
		editor.handleInput(HOME); // column 0 (of line 2)
		editor.handleInput(UP); // line 1
		editor.handleInput(UP); // line 0

		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT); // 'fi' selected
		editor.handleInput(SHIFT_DOWN); // head onto line 1

		assert.strictEqual(editor.hasSelection(), true);
		assert.strictEqual(editor.deleteSelectedRange(), true);

		assert.strictEqual(editor.getText(), "cond\nthird");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("mouse press-drag-release selects, copies, and keeps the highlight across renders", () => {
		const tui = createTestTUI();
		const editor = new Editor(tui, defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");

		editor.render(80); // establish the hit-test snapshot

		const copies: string[] = [];
		tui.copyText = (text: string) => copies.push(text);

		// Row 0 is the top border; content rows follow. Columns are 0-based
		// screen columns; padding and prompt prefix are zero here.
		assert.strictEqual(editor.handleMouseHit("press", 1, 0), true);
		assert.strictEqual(editor.handleMouseHit("drag", 1, 5), true);
		assert.strictEqual(editor.handleMouseHit("release", 1, 5), true);

		assert.deepStrictEqual(copies, ["hello"]);
		assert.strictEqual(editor.getSelectedText(), "hello");

		// Highlight persists across renders with no mouse events in between.
		// The cursor sits on 'h' (its own reverse-video cell), so the rest of
		// the selection shows up right after it as one reverse-video run.
		let previous: string | undefined;
		for (let i = 0; i < 2; i++) {
			const rendered = editor.render(80).join("\n");
			assert.ok(rendered.includes("\x1b[7mello\x1b[27m"), "render keeps selection styling");
			if (previous !== undefined) assert.strictEqual(rendered, previous);
			previous = rendered;
		}
	});

	it("a new mouse click dismisses the persistent selection", () => {
		const tui = createTestTUI();
		const editor = new Editor(tui, defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");

		editor.render(80);
		editor.handleMouseHit("press", 1, 0);
		editor.handleMouseHit("drag", 1, 5);
		editor.handleMouseHit("release", 1, 5);
		assert.strictEqual(editor.hasSelection(), true);

		editor.render(80);
		editor.handleMouseHit("press", 1, 8);
		editor.handleMouseHit("release", 1, 8);
		assert.strictEqual(editor.hasSelection(), false);
	});
});
