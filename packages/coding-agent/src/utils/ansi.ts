/**
 * ANSI styling and stripping. Replaces `chalk` and `strip-ansi`.
 *
 * Plain TypeScript rather than `Bun.color`/`Bun.stripANSI`: colour codes are just strings, so
 * there is nothing Bun does better here, and one implementation stays valid under both the
 * shipped Bun runtime and the Node-based test runner.
 *
 * Suppression follows chalk's precedence exactly, so piped and CI output stays clean.
 */

/** CSI sequences (colour, cursor) and OSC sequences (titles, hyperlinks). */
const ANSI_PATTERN = new RegExp(
	[
		// CSI: ESC [ params intermediates final
		"\\u001B\\[[0-?]*[ -/]*[@-~]",
		// OSC: ESC ] ... terminated by BEL or ST
		"\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
		// Single-character escapes
		"\\u001B[@-Z\\\\-_]",
	].join("|"),
	"g",
);

/** Remove every ANSI escape sequence. Replaces `strip-ansi`. */
export function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}

export default stripAnsi;

const CODES: Record<string, string> = {
	reset: "\u001b[0m",
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	italic: "\u001b[3m",
	underline: "\u001b[4m",
	inverse: "\u001b[7m",
	strikethrough: "\u001b[9m",
	black: "\u001b[30m",
	red: "\u001b[31m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	blue: "\u001b[34m",
	magenta: "\u001b[35m",
	cyan: "\u001b[36m",
	white: "\u001b[37m",
	gray: "\u001b[90m",
	grey: "\u001b[90m",
	redBright: "\u001b[91m",
	greenBright: "\u001b[92m",
	yellowBright: "\u001b[93m",
	blueBright: "\u001b[94m",
	magentaBright: "\u001b[95m",
	cyanBright: "\u001b[96m",
	whiteBright: "\u001b[97m",
	bgBlack: "\u001b[40m",
	bgRed: "\u001b[41m",
	bgGreen: "\u001b[42m",
	bgYellow: "\u001b[43m",
	bgBlue: "\u001b[44m",
	bgMagenta: "\u001b[45m",
	bgCyan: "\u001b[46m",
	bgWhite: "\u001b[47m",
};

/** chalk's precedence: FORCE_COLOR, then NO_COLOR, then TERM, then TTY. */
function colorEnabled(): boolean {
	const env = process.env;
	if (env.FORCE_COLOR === "0") return false;
	if (env.FORCE_COLOR !== undefined) return true;
	if (env.NO_COLOR) return false;
	if (env.TERM === "dumb") return false;
	return Boolean(process.stdout?.isTTY);
}

/**
 * A callable style that is also chainable, so `color.magenta.bold("x")` works.
 *
 * Declared as an interface rather than a recursive type alias: the alias form is circular and
 * TypeScript rejects it, while an interface may reference itself.
 */
export interface Style {
	(text: string): string;
	readonly [style: string]: Style;
}

function build(open: string[]): Style {
	const apply = (text: string): string =>
		colorEnabled() && open.length > 0 ? `${open.join("")}${text}${CODES.reset}` : text;

	// A proxy gives chalk's chained call shape without enumerating every combination.
	return new Proxy(apply, {
		get(_target, prop: string) {
			const code = CODES[prop];
			return code === undefined ? undefined : build([...open, code]);
		},
	}) as Style;
}

/** Drop-in for chalk's default export, covering the styles this codebase uses. */
export const color = build([]);

/**
 * Bold that closes with SGR 22 (bold off) instead of a full reset, so it can be
 * nested inside a background span — tool panels and selected rows paint a
 * background around already-styled text, and a full reset would strip the
 * background for the remainder of the line.
 */
export function boldSpan(text: string): string {
	return colorEnabled() ? `\u001b[1m${text}\u001b[22m` : text;
}
