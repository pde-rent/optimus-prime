import assert from "node:assert";
import { describe, it } from "node:test";
import { FullscreenViewport } from "../src/fullscreen.js";
import { urlAtColumn } from "../src/utils.js";

describe("FullscreenViewport persistent selection", () => {
	it("scrollback selection survives endActiveSelection (copy-on-release) and keeps painting", () => {
		const viewport = new FullscreenViewport();
		const transcript = ["hello world", "second line", "third line"];

		viewport.composeFrame(transcript, ["dock"], 10);
		assert.strictEqual(viewport.beginSelection(0, 0), true);
		viewport.extendSelection(1, 6);

		// Release copies without dismissing.
		const text = viewport.endActiveSelection();
		assert.strictEqual(text, "hello world\nsecond");
		assert.strictEqual(viewport.hasSelection(), true);

		// Later frames keep the highlight.
		const frame = viewport.composeFrame(transcript, ["dock"], 10);
		assert.match(frame[0], /\x1b\[7m/);
		assert.match(frame[1], /\x1b\[7m/);
		assert.doesNotMatch(frame[2], /\x1b\[7m/);

		// Only an explicit dismissal removes it.
		viewport.clearSelection();
		const cleared = viewport.composeFrame(transcript, ["dock"], 10);
		assert.doesNotMatch(cleared.join("\n"), /\x1b\[7m/);
	});

	it("a new click replaces the persistent scrollback selection", () => {
		const viewport = new FullscreenViewport();
		const transcript = ["alpha", "beta", "gamma"];

		viewport.composeFrame(transcript, ["dock"], 10);
		viewport.beginSelection(0, 0);
		viewport.extendSelection(0, 5);
		assert.strictEqual(viewport.endActiveSelection(), "alpha");

		// New press-drag starts a fresh selection (dismissal by new selection).
		assert.strictEqual(viewport.beginSelection(1, 0), true);
		viewport.extendSelection(1, 4);
		assert.strictEqual(viewport.endActiveSelection(), "beta");

		const frame = viewport.composeFrame(transcript, ["dock"], 10);
		assert.doesNotMatch(frame[0], /\x1b\[7m/);
		assert.match(frame[1], /\x1b\[7m/);
	});

	it("frame/dock selection persists across re-renders until cleared", () => {
		const viewport = new FullscreenViewport();
		const regions = [{ line: 1, col: 0, width: 14 }];

		viewport.applyFrameSelection(["top", "clickable text", "bot"], 3, regions);
		assert.strictEqual(viewport.beginFrameSelection(1, 0), true);
		viewport.extendFrameSelection(1, 9);
		assert.strictEqual(viewport.endFrameSelection(), "clickable"); // trailing space is trimmed

		// Re-render with changed content: highlight follows the live frame.
		const repainted = ["top", "clickable TEXT!", "bot"];
		viewport.applyFrameSelection(repainted, 3, regions);
		assert.match(repainted[1], /\x1b\[7m/);

		viewport.clearSelection();
		const cleared = ["top", "clickable TEXT!", "bot"];
		viewport.applyFrameSelection(cleared, 3, regions);
		assert.doesNotMatch(cleared[1], /\x1b\[7m/);
	});

	it("selection painting keeps OSC 8 links clickable outside the selected span", () => {
		const viewport = new FullscreenViewport();
		const linked = "\x1b]8;;https://example.com\x07visit us\x1b]8;;\x07 tail";
		const transcript = [linked, "row two", "row three"];

		viewport.composeFrame(transcript, ["dock"], 10);
		assert.strictEqual(viewport.beginSelection(0, 12), true); // inside " tail"
		viewport.extendSelection(0, 16);
		viewport.endActiveSelection();

		const frame = viewport.composeFrame(transcript, ["dock"], 10);
		assert.strictEqual(urlAtColumn(frame[0], 2), "https://example.com");
		assert.strictEqual(urlAtColumn(frame[0], 9), null); // past the link close
	});
});

// TUI-level wiring: typing dismisses a persistent selection, escape consumes
// the dismissal. Uses the same virtual-terminal approach as fullscreen.test.ts.
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class StaticTranscript implements Component {
	render(width: number): string[] {
		return Array.from({ length: 20 }, (_, i) => `Line ${i}`.padEnd(width));
	}
	invalidate(): void {}
}

class RecordingDock implements Component {
	inputs: string[] = [];
	render(_width: number): string[] {
		return ["> dock"];
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

async function selectViaMouse(terminal: VirtualTerminal, tui: TUI, copies: string[]): Promise<void> {
	tui.onCopy = (text) => copies.push(text);
	terminal.sendInput("\x1b[<0;1;1M"); // press at screen (1,1)
	terminal.sendInput("\x1b[<32;8;2M"); // drag with motion bit to (2,8)
	terminal.sendInput("\x1b[<0;8;2m"); // release
	await terminal.waitForRender();
	assert.strictEqual(copies.length, 1);
}

describe("TUI persistent selection dismissal", () => {
	it("typing dismisses the selection; a later escape reaches the editor", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new StaticTranscript();
		const dock = new RecordingDock();
		tui.addChild(chat);
		tui.addChild(dock);
		tui.setFocus(dock);
		tui.start();
		tui.enterFullscreen({ scroll: [chat], dock, mouse: true });
		await terminal.waitForRender();

		const copies: string[] = [];
		await selectViaMouse(terminal, tui, copies);

		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.ok(dock.inputs.includes("x"));

		// Selection is gone, so escape is no longer intercepted.
		const before = dock.inputs.length;
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		assert.strictEqual(dock.inputs.length, before + 1);

		tui.stop();
	});

	it("escape consumes the key and dismisses a persistent selection", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new StaticTranscript();
		const dock = new RecordingDock();
		tui.addChild(chat);
		tui.addChild(dock);
		tui.setFocus(dock);
		tui.start();
		tui.enterFullscreen({ scroll: [chat], dock, mouse: true });
		await terminal.waitForRender();

		const copies: string[] = [];
		await selectViaMouse(terminal, tui, copies);

		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		assert.strictEqual(dock.inputs.length, 0); // consumed by dismissal

		// With the selection gone the next escape reaches the editor.
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		assert.strictEqual(dock.inputs.length, 1);

		tui.stop();
	});
});
