/**
 * Minimal ANSI styling helper — replaces the `chalk` package, which was a
 * runtime dependency of this package but is only ever used by tests and the
 * demo scripts in this directory. Emits the exact same SGR sequences chalk
 * emits (same open/close codes, same nested-close rewriting, same newline
 * re-opening), so existing assertions on styled output keep matching.
 *
 * `style` is always-on (equivalent to `new Chalk({ level: 3 })`, which is what
 * every test used). `autoStyle` mirrors chalk's default detection: disabled
 * when NO_COLOR is set or stdout is not a TTY.
 */

const CODES = {
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	blue: [34, 39],
	magenta: [35, 39],
	cyan: [36, 39],
	gray: [90, 39],
	bold: [1, 22],
	dim: [2, 22],
	italic: [3, 23],
	strikethrough: [9, 29],
	underline: [4, 24],
} as const satisfies Record<string, readonly [number, number]>;

type StyleName = keyof typeof CODES;

export type Style = ((text: string) => string) & { [K in StyleName]: Style };

function wrap(text: string, open: string, close: string): string {
	// chalk re-opens the style after a nested close code so the enclosing style
	// survives, and re-opens it after every newline. Empty input stays empty.
	if (text === "") return "";
	let result = text.includes(close) ? text.replaceAll(close, close + open) : text;
	if (result.includes("\n")) {
		result = result.replaceAll("\n", `${close}\n${open}`);
	}
	return open + result + close;
}

function build(chain: StyleName[], enabled: boolean): Style {
	const fn = ((text: string) => {
		if (!enabled) return text;
		let result = text;
		// Innermost style first, matching chalk's chain application order.
		for (let i = chain.length - 1; i >= 0; i--) {
			const [open, close] = CODES[chain[i]!];
			result = wrap(result, `\x1b[${open}m`, `\x1b[${close}m`);
		}
		return result;
	}) as Style;
	for (const name of Object.keys(CODES) as StyleName[]) {
		Object.defineProperty(fn, name, {
			get: () => build([...chain, name], enabled),
			configurable: true,
		});
	}
	return fn;
}

const colorEnabled = !process.env.NO_COLOR && Boolean(process.stdout?.isTTY);

/** Always emits ANSI codes (chalk level 3 equivalent). */
export const style: Style = build([], true);

/** Emits ANSI codes only when the terminal supports colour (chalk default). */
export const autoStyle: Style = build([], colorEnabled);
