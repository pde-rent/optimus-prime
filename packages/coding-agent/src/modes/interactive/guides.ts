import type { KeyId } from "@earendil-works/pi-tui";

import { formatKeyText, keyText } from "./components/keybinding-hints.js";

interface ExtensionShortcutInfo {
	description?: string;
	extensionPath: string;
}

export function buildShortcutGuide(): string {
	const tab = keyText("tui.input.tab");
	const newLine = keyText("tui.input.newLine");
	const clearInput = keyText("app.input.clear");
	const shortcutsKey = keyText("app.shortcuts");
	const selectModel = keyText("app.model.select");
	const expandTools = keyText("app.tools.expand");
	const expandMessages = keyText("app.messages.expand");
	const expandEdits = keyText("app.edits.expand");
	const toggleThinking = keyText("app.thinking.toggle");
	const externalEditor = keyText("app.editor.external");
	const promptStash = keyText("app.prompt.stash");
	const pasteImage = keyText("app.clipboard.pasteImage");

	return `
**Prompt**
\`!\` shell mode · \`/\` commands · \`@\` file paths
\`${tab}\` complete paths · \`${newLine}\` new line
\`${clearInput}\` interrupt · press twice to rewind or clear the prompt

**Controls**
\`${selectModel}\` select model · \`/effort\` set reasoning · \`${expandTools}\` tool output
\`${expandMessages}\` agent messages · \`${expandEdits}\` edit diffs · \`${toggleThinking}\` thinking blocks · \`${promptStash}\` stash prompt · \`${externalEditor}\` edit in \`$EDITOR\`
\`${pasteImage}\` paste image

**Help**
${shortcutsKey ? `\`${shortcutsKey}\` quick shortcuts · ` : ""}\`/hotkeys\` full reference
`;
}

export function buildHotkeysGuide(extensionShortcuts: ReadonlyMap<KeyId, ExtensionShortcutInfo> | undefined): string {
	const cursorUp = keyText("tui.editor.cursorUp");
	const cursorDown = keyText("tui.editor.cursorDown");
	const cursorLeft = keyText("tui.editor.cursorLeft");
	const cursorRight = keyText("tui.editor.cursorRight");
	const cursorWordLeft = keyText("tui.editor.cursorWordLeft");
	const cursorWordRight = keyText("tui.editor.cursorWordRight");
	const cursorLineStart = keyText("tui.editor.cursorLineStart");
	const cursorLineEnd = keyText("tui.editor.cursorLineEnd");
	const jumpForward = keyText("tui.editor.jumpForward");
	const jumpBackward = keyText("tui.editor.jumpBackward");
	const pageUp = keyText("tui.editor.pageUp");
	const pageDown = keyText("tui.editor.pageDown");
	const submit = keyText("tui.input.submit");
	const newLine = keyText("tui.input.newLine");
	const deleteWordBackward = keyText("tui.editor.deleteWordBackward");
	const deleteWordForward = keyText("tui.editor.deleteWordForward");
	const deleteToLineStart = keyText("tui.editor.deleteToLineStart");
	const deleteToLineEnd = keyText("tui.editor.deleteToLineEnd");
	const yank = keyText("tui.editor.yank");
	const yankPop = keyText("tui.editor.yankPop");
	const undo = keyText("tui.editor.undo");
	const tab = keyText("tui.input.tab");
	const clear = keyText("app.clear");
	const clearInput = keyText("app.input.clear");
	const interrupt = keyText("app.interrupt");
	const shortcutsKey = keyText("app.shortcuts");
	const exit = keyText("app.exit");
	const selectModel = keyText("app.model.select");
	const expandTools = keyText("app.tools.expand");
	const expandMessages = keyText("app.messages.expand");
	const expandEdits = keyText("app.edits.expand");
	const toggleThinking = keyText("app.thinking.toggle");
	const focusSubagents = keyText("app.subagents.focus");
	const toggleSubagentGraph = keyText("app.subagents.graph");
	const manageHeartbeats = keyText("app.heartbeats.open");
	const externalEditor = keyText("app.editor.external");
	const promptStash = keyText("app.prompt.stash");
	const followUp = keyText("app.message.followUp");
	const browseQueue = keyText("app.message.navigateOlder");
	const pasteImage = keyText("app.clipboard.pasteImage");
	const viewportPageUp = keyText("tui.viewport.pageUp");
	const viewportPageDown = keyText("tui.viewport.pageDown");
	const viewportTop = keyText("tui.viewport.top");
	const viewportFollow = keyText("tui.viewport.follow");

	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${clearInput}\` | Clear input / cancel autocomplete |
| \`${clear}\` | Interrupt current operation (first) / exit (second) |
${interrupt ? `| \`${interrupt}\` | Interrupt current operation |\n` : ""}${shortcutsKey ? `| \`${shortcutsKey}\` | Show quick shortcuts |\n` : ""}| \`${exit}\` | Exit (when editor is empty) |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${expandMessages}\` | Toggle agent message expansion |
| \`${expandEdits}\` | Toggle edit diff expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${focusSubagents}\` | Focus the subagent summary / open the scoped agents view |
| \`${toggleSubagentGraph}\` | Toggle the live subagent graph |
| \`${manageHeartbeats}\` | Manage heartbeats |
| \`${externalEditor}\` | Edit message in external editor |
| \`${promptStash}\` | Stash or restore draft prompt |
| \`${followUp}\` | Queue follow-up message |
| \`${browseQueue}\` | Check out a queued message for editing (esc returns it) |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |

**Fullscreen mode (\`/fullscreen\`)**
| Key | Action |
|-----|--------|
| \`${viewportPageUp}\` / \`${viewportPageDown}\` | Scroll transcript by page |
| \`${viewportTop}\` | Scroll to top |
| \`${viewportFollow}\` | Scroll to bottom and follow output |
| mouse wheel | Scroll transcript |
| mouse drag | Select and copy text |
| mouse click on link | Open link in browser |
`;

	const shortcuts = extensionShortcuts;
	if (shortcuts && shortcuts.size > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const [key, shortcut] of shortcuts) {
			const description = shortcut.description ?? shortcut.extensionPath;
			hotkeys += `| \`${formatKeyText(key)}\` | ${description} |\n`;
		}
	}

	return hotkeys;
}
