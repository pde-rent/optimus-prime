/**
 * Incremental ("partial") JSON parser.
 *
 * Replaces the `partial-json` npm package. We only ever called its `parse(text)`
 * entry point with the default `Allow.ALL` mode, from a single call site
 * (`parseStreamingJson` in `./json-parse.ts`), to preview tool-call arguments
 * while a model is still streaming them. A ~150 line recursive-descent scanner
 * covers that one mode, so the dependency bought us nothing but supply-chain
 * surface.
 *
 * Deliberate difference from `partial-json`: this parser **fails closed**.
 * `partial-json` happily returns `12` for the buffer `{"count": 12` even though
 * the next chunk may turn it into `123`, i.e. it invents a value that is wrong
 * rather than absent. Here, any token that is still being written when the
 * buffer ends is dropped instead:
 *
 * - truncated numbers (`{"n": 12` -> `{}`)
 * - truncated literals (`{"b": tru` -> `{}`)
 * - truncated object keys (`{"na` -> `{}`)
 *
 * The one exception is string *values*, where a prefix is genuinely a prefix of
 * the final value and is what the streaming UI wants to render (`{"s": "hel` ->
 * `{ s: "hel" }`). A trailing incomplete escape (`"a\`, `"a\u12`) is dropped
 * rather than guessed, as is a trailing unpaired high surrogate.
 *
 * The parser never throws: callers get a best-effort value or `undefined`.
 */

/** Returned by the value parsers when nothing can be salvaged from the buffer. */
const INCOMPLETE = Symbol("incomplete");

type ParseResult = unknown | typeof INCOMPLETE;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_CHARS = new Set(["-", "+", ".", "e", "E", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const SIMPLE_ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/** Result of scanning a string literal: `text` plus whether the closing quote was seen. */
interface StringResult {
	text: string;
	closed: boolean;
}

/** Trailing unpaired high surrogate would corrupt the preview; drop it. */
function dropDanglingSurrogate(text: string): string {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

class PartialJsonParser {
	private index = 0;

	constructor(private readonly source: string) {}

	parse(): ParseResult {
		this.skipWhitespace();
		if (this.index >= this.source.length) {
			return INCOMPLETE;
		}
		return this.parseValue();
	}

	private skipWhitespace(): void {
		while (this.index < this.source.length && WHITESPACE.has(this.source[this.index] as string)) {
			this.index++;
		}
	}

	private parseValue(): ParseResult {
		this.skipWhitespace();
		if (this.index >= this.source.length) {
			return INCOMPLETE;
		}
		const char = this.source[this.index];
		if (char === '"') {
			const result = this.parseString();
			// A partial string value is a real prefix of the final value, so keep it.
			return result.closed ? result.text : dropDanglingSurrogate(result.text);
		}
		if (char === "{") {
			return this.parseObject();
		}
		if (char === "[") {
			return this.parseArray();
		}
		return this.parseLiteralOrNumber();
	}

	/**
	 * Scans a string literal, repairing what `repairJson` would repair: raw control
	 * characters are kept verbatim and unknown escapes degrade to a literal
	 * backslash. Incomplete trailing escapes are dropped.
	 */
	private parseString(): StringResult {
		this.index++; // opening quote
		let text = "";
		while (this.index < this.source.length) {
			const char = this.source[this.index] as string;
			if (char === '"') {
				this.index++;
				return { text, closed: true };
			}
			if (char !== "\\") {
				text += char;
				this.index++;
				continue;
			}

			const next = this.source[this.index + 1];
			if (next === undefined) {
				this.index++; // dangling backslash: drop rather than guess
				return { text, closed: false };
			}
			if (next === "u") {
				const digits = this.source.slice(this.index + 2, this.index + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
					if (this.index + 6 > this.source.length) {
						this.index = this.source.length; // truncated \uXXXX: drop
						return { text, closed: false };
					}
					text += "\\u"; // malformed escape in complete input: keep literally
					this.index += 2;
					continue;
				}
				text += String.fromCharCode(Number.parseInt(digits, 16));
				this.index += 6;
				continue;
			}
			const simple = SIMPLE_ESCAPES[next];
			text += simple ?? `\\${next}`;
			this.index += 2;
		}
		return { text, closed: false };
	}

	/** `true` / `false` / `null` / numbers. Any token still open at EOF is dropped. */
	private parseLiteralOrNumber(): ParseResult {
		for (const [token, value] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (this.source.startsWith(token, this.index)) {
				this.index += token.length;
				return value;
			}
		}

		const start = this.index;
		while (this.index < this.source.length && NUMBER_CHARS.has(this.source[this.index] as string)) {
			this.index++;
		}
		if (this.index === start) {
			return INCOMPLETE; // not a value we recognise at all
		}
		if (this.index >= this.source.length) {
			return INCOMPLETE; // still being written; the next chunk may change it
		}
		try {
			return JSON.parse(this.source.slice(start, this.index)) as unknown;
		} catch {
			return INCOMPLETE;
		}
	}

	private parseObject(): Record<string, unknown> {
		this.index++; // opening brace
		const object: Record<string, unknown> = {};
		for (;;) {
			this.skipWhitespace();
			if (this.index >= this.source.length) {
				return object;
			}
			if (this.source[this.index] === "}") {
				this.index++;
				return object;
			}
			if (this.source[this.index] !== '"') {
				return object; // malformed key position
			}

			const key = this.parseString();
			if (!key.closed) {
				return object; // partial key: we do not know its final name
			}

			this.skipWhitespace();
			if (this.source[this.index] !== ":") {
				return object;
			}
			this.index++;

			const value = this.parseValue();
			if (value === INCOMPLETE) {
				return object;
			}
			object[key.text] = value;

			this.skipWhitespace();
			if (this.source[this.index] === ",") {
				this.index++;
				continue;
			}
			if (this.source[this.index] === "}") {
				this.index++;
			}
			return object;
		}
	}

	private parseArray(): unknown[] {
		this.index++; // opening bracket
		const array: unknown[] = [];
		for (;;) {
			this.skipWhitespace();
			if (this.index >= this.source.length) {
				return array;
			}
			if (this.source[this.index] === "]") {
				this.index++;
				return array;
			}

			const value = this.parseValue();
			if (value === INCOMPLETE) {
				return array;
			}
			array.push(value);

			this.skipWhitespace();
			if (this.source[this.index] === ",") {
				this.index++;
				continue;
			}
			if (this.source[this.index] === "]") {
				this.index++;
			}
			return array;
		}
	}
}

/**
 * Best-effort parse of a possibly incomplete JSON document.
 *
 * @returns the salvaged value, or `undefined` when the buffer holds nothing
 *   that can be trusted. Never throws.
 */
export function parsePartialJson(text: string): unknown {
	try {
		const result = new PartialJsonParser(text).parse();
		return result === INCOMPLETE ? undefined : result;
	} catch {
		return undefined;
	}
}
