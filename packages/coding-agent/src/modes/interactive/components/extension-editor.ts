import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { runExternalEditor } from "./external-editor.js";
import { keyHint } from "./keybinding-hints.js";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		if (this.keybindings.matches(keyData, "app.editor.external")) {
			this.openExternalEditor();
			return;
		}

		this.editor.handleInput(keyData);
	}

	private openExternalEditor(): void {
		this.tui.stop();
		const newContent = runExternalEditor(this.editor.getText(), { tmpPrefix: "pi-extension-editor" });
		if (newContent !== undefined) {
			this.editor.setText(newContent);
		}
		this.tui.start();
		// Force full re-render since external editor uses alternate screen
		this.tui.requestRender(true);
	}
}
