const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

interface CompletedPaste {
	/** Text between the start marker and the end marker. */
	content: string;
	/** Input that followed the end marker in the same chunk. */
	rest: string;
}

/**
 * Incremental bracketed-paste state machine shared by text components.
 *
 * Terminals may split bracketed pastes across stdin chunks arbitrarily, so
 * every chunk is fed through feed() until the end marker arrives. Data
 * outside a paste passes through untouched.
 */
export class BracketedPasteBuffer {
	private buffer = "";
	private inPaste = false;

	/** True while a paste has started but its end marker has not arrived. */
	get active(): boolean {
		return this.inPaste;
	}

	/**
	 * Feed one stdin chunk into the state machine. Returns the completed paste
	 * content plus any trailing input once the end marker arrives, and null
	 * while a paste is still open or none was started.
	 */
	feed(data: string): CompletedPaste | null {
		if (data.includes(BRACKETED_PASTE_START)) {
			this.inPaste = true;
			this.buffer = "";
			data = data.replace(BRACKETED_PASTE_START, "");
		}

		if (!this.inPaste) return null;

		this.buffer += data;
		const endIndex = this.buffer.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) return null;

		const content = this.buffer.substring(0, endIndex);
		const rest = this.buffer.substring(endIndex + BRACKETED_PASTE_END.length);
		this.buffer = "";
		this.inPaste = false;
		return { content, rest };
	}
}
