export interface AnsiCode {
	code: string;
	length: number;
}

type ControlStringEnds = Map<number, number | null>;

interface AnsiScanState {
	controlStringEnds?: ControlStringEnds;
}

function cacheControlStringEnds(str: string, from: number, ends: ControlStringEnds): void {
	let nextBel = -1;
	let nextSt = -1;

	for (let i = str.length - 1; i >= from; i--) {
		if (str[i] === "\x07") {
			nextBel = i;
		}
		if (str[i] !== "\x1b") {
			continue;
		}

		const next = str[i + 1];
		if (next === "\\") {
			nextSt = i;
		} else if (next === "]" || next === "_") {
			if (nextBel !== -1 && (nextSt === -1 || nextBel < nextSt)) {
				ends.set(i, nextBel + 1);
			} else {
				ends.set(i, nextSt === -1 ? null : nextSt + 2);
			}
		} else if (next === "P" || next === "^" || next === "X") {
			ends.set(i, nextSt === -1 ? null : nextSt + 2);
		}
	}
}

function extractControlStringEnd(str: string, pos: number, allowBel: boolean, state?: AnsiScanState): number | null {
	if (state?.controlStringEnds?.has(pos)) {
		const end = state.controlStringEnds.get(pos);
		return end ?? null;
	}

	let j = pos + 2;
	while (j < str.length) {
		if (allowBel && str[j] === "\x07") {
			return j + 1;
		}
		if (str[j] === "\x1b" && str[j + 1] === "\\") {
			return j + 2;
		}
		j++;
	}
	if (state) {
		const ends: ControlStringEnds = new Map();
		cacheControlStringEnds(str, pos, ends);
		state.controlStringEnds = ends;
	}
	return null;
}

function extractAnsiEndAt(str: string, pos: number, state?: AnsiScanState): number | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;

	const next = str[pos + 1];

	// CSI: parameter bytes, then intermediate bytes, then one final byte.
	if (next === "[") {
		let j = pos + 2;
		let hasIntermediate = false;
		while (j < str.length) {
			const byte = str.charCodeAt(j);
			if (byte >= 0x30 && byte <= 0x3f && !hasIntermediate) {
				j++;
				continue;
			}
			if (byte >= 0x20 && byte <= 0x2f) {
				hasIntermediate = true;
				j++;
				continue;
			}
			if (byte >= 0x40 && byte <= 0x7e) {
				return j + 1;
			}
			return null;
		}
		return null;
	}

	// OSC uses BEL or ST. APC also accepts BEL for existing private markers.
	if (next === "]" || next === "_") {
		return extractControlStringEnd(str, pos, true, state);
	}

	// DCS, PM, and SOS are terminated by ST.
	if (next === "P" || next === "^" || next === "X") {
		return extractControlStringEnd(str, pos, false, state);
	}

	return null;
}

function extractAnsiCodeAt(str: string, pos: number, state?: AnsiScanState): AnsiCode | null {
	const end = extractAnsiEndAt(str, pos, state);
	return end === null ? null : { code: str.substring(pos, end), length: end - pos };
}

/** Extract an ANSI escape sequence from a string at the given position. */
export function extractAnsiCode(str: string, pos: number): AnsiCode | null {
	return extractAnsiCodeAt(str, pos);
}

/** Create a scanner whose malformed-control-string cache is released after this string scan. */
export function createAnsiCodeExtractor(str: string): (pos: number) => AnsiCode | null {
	const state: AnsiScanState = {};
	return (pos) => extractAnsiCodeAt(str, pos, state);
}

function createAnsiEndExtractor(str: string): (pos: number) => number | null {
	const state: AnsiScanState = {};
	return (pos) => extractAnsiEndAt(str, pos, state);
}

type Osc8Terminator = "\x07" | "\x1b\\";

interface ActiveHyperlink {
	params: string;
	url: string;
	terminator: Osc8Terminator;
}

export function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
	if (!ansiCode.startsWith("\x1b]8;")) {
		return undefined;
	}

	const terminator: Osc8Terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
	const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
	const separatorIndex = body.indexOf(";");
	if (separatorIndex === -1) {
		return undefined;
	}

	const params = body.slice(0, separatorIndex);
	const url = body.slice(separatorIndex + 1);
	if (!url) {
		return null;
	}
	return { params, url, terminator };
}

function formatOsc8Hyperlink(hyperlink: ActiveHyperlink): string {
	return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

function formatOsc8Close(terminator: Osc8Terminator): string {
	return `\x1b]8;;${terminator}`;
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
export class AnsiCodeTracker {
	// Track individual attributes separately so we can reset them specifically
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"
	private activeHyperlink: ActiveHyperlink | null = null;

	process(ansiCode: string): void {
		// OSC 8 hyperlink: \x1b]8;;<url>\x1b\\ (open) or \x1b]8;;\x1b\\ (close).
		// Preserve the original terminator because some terminals only make BEL-terminated
		// links clickable. OAuth login URLs use BEL, so reopening wrapped lines with ST
		// made only the first physical line clickable in those terminals.
		const hyperlink = parseOsc8Hyperlink(ansiCode);
		if (hyperlink !== undefined) {
			this.activeHyperlink = hyperlink;
			return;
		}

		if (!ansiCode.endsWith("m")) {
			return;
		}

		// Extract the parameters between \x1b[ and m
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		if (!match) return;

		const params = match[1];
		if (params === "" || params === "0") {
			// Full reset
			this.reset();
			return;
		}

		// Parse parameters (can be semicolon-separated)
		const parts = params.split(";");
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);

			// Handle 256-color and RGB codes which consume multiple parameters
			if (code === 38 || code === 48) {
				// 38;5;N (256 color fg) or 38;2;R;G;B (RGB fg)
				// 48;5;N (256 color bg) or 48;2;R;G;B (RGB bg)
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 color: 38;5;N or 48;5;N
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 3;
					continue;
				} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB color: 38;2;R;G;B or 48;2;R;G;B
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 5;
					continue;
				}
			}

			// Standard SGR codes
			switch (code) {
				case 0:
					this.reset();
					break;
				case 1:
					this.bold = true;
					break;
				case 2:
					this.dim = true;
					break;
				case 3:
					this.italic = true;
					break;
				case 4:
					this.underline = true;
					break;
				case 5:
					this.blink = true;
					break;
				case 7:
					this.inverse = true;
					break;
				case 8:
					this.hidden = true;
					break;
				case 9:
					this.strikethrough = true;
					break;
				case 21:
					this.bold = false;
					break; // Some terminals
				case 22:
					this.bold = false;
					this.dim = false;
					break;
				case 23:
					this.italic = false;
					break;
				case 24:
					this.underline = false;
					break;
				case 25:
					this.blink = false;
					break;
				case 27:
					this.inverse = false;
					break;
				case 28:
					this.hidden = false;
					break;
				case 29:
					this.strikethrough = false;
					break;
				case 39:
					this.fgColor = null;
					break; // Default fg
				case 49:
					this.bgColor = null;
					break; // Default bg
				default:
					// Standard foreground colors 30-37, 90-97
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						this.fgColor = String(code);
					}
					// Standard background colors 40-47, 100-107
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						this.bgColor = String(code);
					}
					break;
			}
			i++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
		// SGR reset does not affect OSC 8 hyperlink state
	}

	/** Clear all state for reuse. */
	clear(): void {
		this.reset();
		this.activeHyperlink = null;
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
		if (this.activeHyperlink) {
			result += formatOsc8Hyperlink(this.activeHyperlink);
		}
		return result;
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null ||
			this.activeHyperlink !== null
		);
	}

	/**
	 * Get reset codes for attributes that need to be turned off at line end.
	 * Underline must be closed to prevent bleeding into padding.
	 * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
	 * Returns empty string if no attributes need closing.
	 */
	getLineEndReset(): string {
		let result = "";
		if (this.underline) {
			result += "\x1b[24m"; // Underline off only
		}
		if (this.activeHyperlink) {
			result += formatOsc8Close(this.activeHyperlink.terminator); // Re-opened at line start via getActiveCodes()
		}
		return result;
	}
}

export function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = 0;
	const extractAnsi = createAnsiCodeExtractor(text);
	while (i < text.length) {
		const ansiResult = extractAnsi(i);
		if (ansiResult) {
			tracker.process(ansiResult.code);
			i += ansiResult.length;
		} else {
			i++;
		}
	}
}

// Fast path for the common CSI form. The shared scanner handles the wider CSI
// grammar, control strings, malformed sequences, and ordinary two-byte escapes.
const COMMON_CSI_REGEX = /\x1b\[[0-9;:?<=>]*[\x40-\x7e]/g;

/** Remove all escape sequences (CSI, OSC, DCS/APC, two-char) leaving plain text. */
export function stripAnsi(str: string): string {
	if (!str.includes("\x1b")) return str;

	const input = str.replace(COMMON_CSI_REGEX, "");
	let escapeIndex = input.indexOf("\x1b");
	if (escapeIndex === -1) return input;

	const result: string[] = [];
	let plainStart = 0;
	const extractAnsiEnd = createAnsiEndExtractor(input);
	while (escapeIndex !== -1) {
		const ansiEnd = extractAnsiEnd(escapeIndex);
		if (ansiEnd !== null) {
			if (plainStart < escapeIndex) result.push(input.slice(plainStart, escapeIndex));
			plainStart = ansiEnd;
		} else {
			const next = input.charCodeAt(escapeIndex + 1);
			if (escapeIndex + 1 < input.length && next !== 0x0a && next !== 0x0d && next !== 0x2028 && next !== 0x2029) {
				if (plainStart < escapeIndex) result.push(input.slice(plainStart, escapeIndex));
				plainStart = escapeIndex + 2;
			}
		}
		escapeIndex = input.indexOf("\x1b", Math.max(escapeIndex + 1, plainStart));
	}
	if (plainStart < input.length) result.push(input.slice(plainStart));
	return result.join("");
}
