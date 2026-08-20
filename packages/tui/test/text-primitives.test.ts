import assert from "node:assert";
import { describe, it } from "node:test";
import {
	collapseText,
	DOT_SEPARATOR,
	dotJoin,
	ELLIPSIS,
	padEndAnsi,
	padStartAnsi,
	truncateToWidth,
	visibleWidth,
} from "../src/utils.js";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("padEndAnsi", () => {
	it("pads plain text to the requested column count", () => {
		assert.strictEqual(padEndAnsi("abc", 6), "abc   ");
		assert.strictEqual(visibleWidth(padEndAnsi("abc", 6)), 6);
	});

	it("ignores ANSI escapes when measuring", () => {
		const styled = `${RED}abc${RESET}`;
		assert.strictEqual(padEndAnsi(styled, 6), `${styled}   `);
		assert.strictEqual(visibleWidth(padEndAnsi(styled, 6)), 6);
	});

	it("counts wide CJK graphemes as two columns", () => {
		assert.strictEqual(padEndAnsi("世界", 6), "世界  ");
		assert.strictEqual(visibleWidth(padEndAnsi("世界", 6)), 6);
		assert.strictEqual(visibleWidth(padEndAnsi("あ", 5)), 5);
	});

	it("counts emoji graphemes as two columns", () => {
		assert.strictEqual(visibleWidth(padEndAnsi("🙂", 4)), 4);
	});

	it("pads styled wide text by visible width, not code-unit length", () => {
		const styled = `${RED}世界${RESET}`;
		assert.strictEqual(visibleWidth(padEndAnsi(styled, 8)), 8);
		// String.prototype.padEnd would add nothing here: `.length` already exceeds 8.
		assert.notStrictEqual(padEndAnsi(styled, 8), styled.padEnd(8));
	});

	it("leaves over-wide text untouched", () => {
		assert.strictEqual(padEndAnsi("abcdef", 3), "abcdef");
		assert.strictEqual(padEndAnsi("世界", 3), "世界");
	});

	it("treats zero and negative widths as no padding", () => {
		assert.strictEqual(padEndAnsi("ab", 0), "ab");
		assert.strictEqual(padEndAnsi("ab", -5), "ab");
		assert.strictEqual(padEndAnsi("", 0), "");
	});

	it("pads an empty string to the full width", () => {
		assert.strictEqual(padEndAnsi("", 3), "   ");
	});
});

describe("padStartAnsi", () => {
	it("right-aligns plain text", () => {
		assert.strictEqual(padStartAnsi("abc", 6), "   abc");
		assert.strictEqual(visibleWidth(padStartAnsi("abc", 6)), 6);
	});

	it("ignores ANSI escapes when measuring", () => {
		const styled = `${RED}42${RESET}`;
		assert.strictEqual(padStartAnsi(styled, 5), `   ${styled}`);
		assert.strictEqual(visibleWidth(padStartAnsi(styled, 5)), 5);
	});

	it("counts wide CJK graphemes as two columns", () => {
		assert.strictEqual(padStartAnsi("世界", 6), "  世界");
		assert.strictEqual(visibleWidth(padStartAnsi("世界", 6)), 6);
	});

	it("leaves over-wide text untouched", () => {
		assert.strictEqual(padStartAnsi("abcdef", 3), "abcdef");
		assert.strictEqual(padStartAnsi(`${RED}世界${RESET}`, 2), `${RED}世界${RESET}`);
	});

	it("treats zero and negative widths as no padding", () => {
		assert.strictEqual(padStartAnsi("ab", 0), "ab");
		assert.strictEqual(padStartAnsi("ab", -5), "ab");
	});

	it("mirrors padEndAnsi so a pair of columns aligns", () => {
		const left = padEndAnsi(`${RED}世界${RESET}`, 8);
		const right = padStartAnsi("あ12", 8);
		assert.strictEqual(visibleWidth(left), visibleWidth(right));
	});
});

describe("collapseText", () => {
	it("collapses newlines and runs of whitespace to single spaces", () => {
		assert.strictEqual(collapseText("a\n\nb"), "a b");
		assert.strictEqual(collapseText("a   b\t\tc"), "a b c");
		assert.strictEqual(collapseText("line one\r\nline two"), "line one line two");
	});

	it("trims leading and trailing whitespace", () => {
		assert.strictEqual(collapseText("  padded  "), "padded");
		assert.strictEqual(collapseText("\n\ttabbed\n"), "tabbed");
	});

	it("returns an empty string for whitespace-only and empty input", () => {
		assert.strictEqual(collapseText(""), "");
		assert.strictEqual(collapseText("   \n\t "), "");
	});

	it("leaves already-flat text unchanged", () => {
		assert.strictEqual(collapseText("already flat"), "already flat");
	});

	it("preserves non-whitespace content including ANSI and wide characters", () => {
		assert.strictEqual(collapseText(`${RED}a\n b${RESET}`), `${RED}a b${RESET}`);
		assert.strictEqual(collapseText("世  界"), "世 界");
	});
});

describe("dotJoin", () => {
	it("joins parts with the dot separator by default", () => {
		assert.strictEqual(dotJoin(["a", "b", "c"]), `a${DOT_SEPARATOR}b${DOT_SEPARATOR}c`);
		assert.strictEqual(DOT_SEPARATOR, " · ");
	});

	it("drops undefined, null and empty parts", () => {
		assert.strictEqual(dotJoin(["a", undefined, "b"]), "a · b");
		assert.strictEqual(dotJoin(["a", null, "b"]), "a · b");
		assert.strictEqual(dotJoin(["a", "", "b"]), "a · b");
		assert.strictEqual(dotJoin([undefined, "only", null, ""]), "only");
	});

	it("returns an empty string when nothing survives filtering", () => {
		assert.strictEqual(dotJoin([]), "");
		assert.strictEqual(dotJoin([undefined, null, ""]), "");
	});

	it("never emits a leading, trailing or doubled separator", () => {
		const joined = dotJoin(["", "a", undefined, "", "b", null]);
		assert.strictEqual(joined, "a · b");
		assert.strictEqual(joined.includes(`${DOT_SEPARATOR}${DOT_SEPARATOR}`), false);
	});

	it("accepts a caller-styled separator without touching the parts", () => {
		const dim = `\x1b[2m · ${RESET}`;
		assert.strictEqual(dotJoin([`${RED}a${RESET}`, "b"], dim), `${RED}a${RESET}${dim}b`);
	});

	it("keeps whitespace-only parts, which are not empty", () => {
		assert.strictEqual(dotJoin(["a", " ", "b"]), "a ·   · b");
	});
});

describe("ELLIPSIS", () => {
	it("is the default ellipsis of truncateToWidth", () => {
		const truncated = truncateToWidth("this text is far too long", 10);
		assert.strictEqual(truncated.endsWith(ELLIPSIS), true);
		assert.strictEqual(truncated, truncateToWidth("this text is far too long", 10, ELLIPSIS));
		assert.ok(visibleWidth(truncated) <= 10);
	});
});
