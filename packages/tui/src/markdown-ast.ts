/**
 * Markdown lexer built on Bun's native markdown parser.
 *
 * `Bun.markdown.render()` is a bottom-up visitor: every callback receives the
 * already-rendered children string plus a small metadata object, and whatever it
 * returns is spliced into the parent's children string. Returning an index
 * sentinel instead of markup turns that visitor into a lexer - each callback
 * records a node and hands back a pointer, so a parent can rebuild its child list
 * by decoding the pointers out of the string it was given.
 *
 * The node shapes below mirror the subset of marked's token tree that the TUI
 * renderer consumes, so the renderer stays a plain tree walk.
 */

const SENTINEL = "\u0000";

export interface TextNode {
	type: "text";
	text: string;
	tokens?: MarkdownNode[];
}
export interface HeadingNode {
	type: "heading";
	depth: number;
	tokens: MarkdownNode[];
}
export interface ParagraphNode {
	type: "paragraph";
	tokens: MarkdownNode[];
}
export interface CodeNode {
	type: "code";
	text: string;
	lang?: string;
}
export interface BlockquoteNode {
	type: "blockquote";
	tokens: MarkdownNode[];
}
export interface ListItemNode {
	type: "list_item";
	tokens: MarkdownNode[];
}
export interface ListNode {
	type: "list";
	ordered: boolean;
	start: number;
	items: ListItemNode[];
}
export interface TableCellNode {
	type: "table_cell";
	tokens: MarkdownNode[];
	text: string;
}
export interface TableNode {
	type: "table";
	header: TableCellNode[];
	rows: TableCellNode[][];
}
export interface HrNode {
	type: "hr";
}
export interface HtmlNode {
	type: "html";
	raw: string;
}
export interface StrongNode {
	type: "strong";
	tokens: MarkdownNode[];
}
export interface EmNode {
	type: "em";
	tokens: MarkdownNode[];
}
export interface DelNode {
	type: "del";
	tokens: MarkdownNode[];
}
export interface CodespanNode {
	type: "codespan";
	text: string;
}
export interface LinkNode {
	type: "link";
	href: string;
	text: string;
	tokens: MarkdownNode[];
}
export interface ImageNode {
	type: "image";
	href: string;
	text: string;
}
export interface MathNode {
	type: "blockMath" | "inlineMath";
	text: string;
}

export type MarkdownNode =
	| TextNode
	| HeadingNode
	| ParagraphNode
	| CodeNode
	| BlockquoteNode
	| ListItemNode
	| ListNode
	| TableCellNode
	| TableNode
	| HrNode
	| HtmlNode
	| StrongNode
	| EmNode
	| DelNode
	| CodespanNode
	| LinkNode
	| ImageNode
	| MathNode;

/** Metadata objects Bun hands to the renderer callbacks. */
interface HeadingMeta {
	level: number;
}
interface LinkMeta {
	href: string;
	title?: string;
}
interface ImageMeta {
	src: string;
	title?: string;
}
interface ListMeta {
	ordered: boolean;
	start?: number;
	depth: number;
}
interface CodeMeta {
	language?: string | null;
}

interface BunMarkdown {
	render(source: string, renderer: object, options: object): string;
}

let bunMarkdown: BunMarkdown | undefined;

/**
 * Resolved on first use rather than at import time: reading the global while the
 * module is being evaluated would break any consumer that imports pi-tui before
 * the runtime is in place, and would surface as a property-of-undefined error
 * instead of something actionable.
 */
function getBunMarkdown(): BunMarkdown {
	bunMarkdown ??= (globalThis as { Bun?: { markdown?: BunMarkdown } }).Bun?.markdown;
	if (!bunMarkdown) {
		throw new Error("Markdown rendering requires Bun.markdown; run this under Bun 1.3 or newer.");
	}
	return bunMarkdown;
}

// --- math -------------------------------------------------------------------

/**
 * Bun's parser has no extension hook, so math has to be lifted out of the source
 * before it is handed over: `\[` would otherwise be escape-processed down to `[`
 * and underscores inside a formula would lex as emphasis. Placeholders use
 * private-use codepoints, which carry no markdown meaning and survive inline
 * parsing untouched.
 */
const MATH_OPEN = "\ue000";
const MATH_CLOSE = "\ue001";

// Sticky so the scanner can match at an offset without slicing the source.
const BLOCK_MATH_REGEX = /[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/y;
// Every position the scanner has to stop at. Alternating on the autolink starts
// keeps the skip between stops inside the regex engine.
const INTERESTING_REGEX = /[\n`~<($[\\]|https?:\/\/|www\.|[\w.+-]+@[\w-]+\./g;
// GFM autolink literals, which Bun (CommonMark only) does not recognise.
const AUTOLINK_REGEX = /(?:https?:\/\/|www\.)[^\s<]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/y;
const TRAILING_PUNCTUATION = "!\"'.,:;?";
const FENCE_REGEX = /[ ]{0,3}(`{3,}|~{3,})/y;
// $...$ follows the pandoc/GitHub rules so prose dollar amounts never match: the
// opening $ must be followed by a non-space, the closing $ preceded by a
// non-space and not followed by a digit ("between $5 and $10" never matches).
const INLINE_MATH_PATTERNS = [
	/\$\$([\s\S]+?)\$\$/y,
	/\\\[([\s\S]+?)\\\]/y,
	/\\\(([\s\S]+?)\\\)/y,
	/\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/y,
];

function needsPreprocessing(text: string): boolean {
	return (
		text.includes("$") ||
		text.includes("~") ||
		text.includes("@") ||
		text.includes("://") ||
		text.includes("www.") ||
		text.includes("\\(") ||
		text.includes("\\[")
	);
}

/**
 * Trim the trailing punctuation GFM excludes from an autolink literal. A closing
 * paren stays only while it balances one opened inside the URL, so
 * `(https://x/a_(b))` keeps the inner pair and drops the outer one.
 */
function trimAutolink(literal: string): string {
	let end = literal.length;
	while (end > 0) {
		const last = literal[end - 1];
		if (TRAILING_PUNCTUATION.includes(last)) {
			end--;
			continue;
		}
		if (last !== ")") break;
		let opens = 0;
		let closes = 0;
		for (let i = 0; i < end; i++) {
			if (literal[i] === "(") opens++;
			else if (literal[i] === ")") closes++;
		}
		if (closes <= opens) break;
		end--;
	}
	return literal.slice(0, end);
}

interface Preprocessed {
	source: string;
	math: MathNode[];
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
	pattern.lastIndex = index;
	return pattern.exec(text);
}

/**
 * Rewrite the source so Bun's parser sees only constructs it handles: math spans
 * become placeholders and lone strikethrough tildes get escaped. Fenced blocks,
 * code spans, autolinks and link destinations are skipped so `$x$` inside code
 * and `~` inside a URL stay literal. Unterminated delimiters never match, so
 * partially streamed math stays plain text until its closing delimiter arrives.
 */
function preprocess(text: string): Preprocessed {
	const math: MathNode[] = [];
	const parts: string[] = [];
	// Everything from `pending` to `index` is passed through untouched; it is
	// copied in one slice whenever a rewrite actually has to be emitted.
	let pending = 0;
	let index = 0;
	let atLineStart = true;
	const emit = (replacement: string, consumed: number): void => {
		if (index > pending) parts.push(text.slice(pending, index));
		parts.push(replacement);
		index += consumed;
		pending = index;
	};

	while (index < text.length) {
		const char = text[index];

		if (atLineStart) {
			const fence = matchAt(FENCE_REGEX, text, index);
			if (fence) {
				const marker = fence[1][0].repeat(fence[1].length);
				const close = text.indexOf(`\n${marker}`, index + fence[0].length);
				const lineEnd = close === -1 ? -1 : text.indexOf("\n", close + 1);
				index = close === -1 || lineEnd === -1 ? text.length : lineEnd;
				continue;
			}
			// Checked before the indent is consumed: models often indent display
			// math, which would otherwise lex as an indented code block.
			const block = matchAt(BLOCK_MATH_REGEX, text, index);
			if (block) {
				math.push({ type: "blockMath", text: (block[1] ?? block[2]).trim() });
				emit(`${MATH_OPEN}${math.length - 1}${MATH_CLOSE}\n`, block[0].length);
				continue;
			}
		}

		if (char === "`") {
			let run = 0;
			while (text[index + run] === "`") run++;
			const close = text.indexOf("`".repeat(run), index + run);
			index = close === -1 ? index + run : close + run;
			atLineStart = false;
			continue;
		}

		if (char === "~" && text[index + 1] !== "~" && text[index - 1] !== "~") {
			// Bun accepts a single-tilde run as strikethrough; GitHub and the
			// renderer this replaced require two. Escaping keeps the tilde literal.
			emit("\\~", 1);
			atLineStart = false;
			continue;
		}

		if (char === "<" || char === "[" || (char === "(" && text[index - 1] === "]")) {
			// Autolinks, link labels and link destinations pass through untouched so
			// their URLs keep their tildes, dollar signs and underscores.
			const close = text.indexOf(char === "<" ? ">" : char === "[" ? "]" : ")", index);
			if (close > index && (char === "[" || !/\s/.test(text.slice(index, close)))) {
				index = close + 1;
				atLineStart = false;
				continue;
			}
		}

		const autolink = matchAt(AUTOLINK_REGEX, text, index);
		if (autolink) {
			// Wrapping the literal in a CommonMark autolink hands the whole URL to Bun
			// as a single token, so nothing inside it can lex as emphasis.
			const literal = trimAutolink(autolink[0]);
			const target = literal.startsWith("www.") ? `https://${literal}` : literal;
			emit(target === literal ? `<${literal}>` : `[${literal}](${target})`, literal.length);
			atLineStart = false;
			continue;
		}

		if (char === "$" || char === "\\") {
			let matched = false;
			for (const pattern of INLINE_MATH_PATTERNS) {
				const match = matchAt(pattern, text, index);
				if (!match) continue;
				math.push({ type: "inlineMath", text: match[1].trim() });
				emit(`${MATH_OPEN}${math.length - 1}${MATH_CLOSE}`, match[0].length);
				matched = true;
				break;
			}
			if (matched) {
				atLineStart = false;
				continue;
			}
		}

		if (char === "\n") {
			atLineStart = true;
			index++;
			continue;
		}
		atLineStart = false;
		// Nothing between two of these characters can change the output, so let the
		// regex engine skip the run instead of stepping through it.
		INTERESTING_REGEX.lastIndex = index + 1;
		const next = INTERESTING_REGEX.exec(text);
		index = next ? next.index : text.length;
	}

	if (parts.length === 0) return { source: text, math };
	if (index > pending) parts.push(text.slice(pending, index));
	return { source: parts.join(""), math };
}

/** Split a text node's content back apart on math placeholders. */
function splitMathPlaceholders(text: string, math: MathNode[], out: MarkdownNode[]): void {
	let index = 0;
	while (index < text.length) {
		const open = text.indexOf(MATH_OPEN, index);
		if (open === -1) break;
		const close = text.indexOf(MATH_CLOSE, open + 1);
		if (close === -1) break;
		const node = math[Number(text.slice(open + 1, close))];
		if (!node) {
			index = close + 1;
			continue;
		}
		if (open > index) out.push({ type: "text", text: text.slice(index, open) });
		out.push(node);
		index = close + 1;
	}
	if (index === 0) {
		out.push({ type: "text", text });
	} else if (index < text.length) {
		out.push({ type: "text", text: text.slice(index) });
	}
}

// --- autolinks --------------------------------------------------------------

const BLOCK_TYPES = new Set(["list", "code", "blockMath", "paragraph", "blockquote", "table", "hr", "html"]);

/**
 * Bun hands a list item its inline children directly, while the renderer treats
 * every child of an item as its own line. Wrapping each inline run in a text node
 * restores the one-line-per-run grouping.
 */
function groupInline(nodes: MarkdownNode[]): MarkdownNode[] {
	if (!nodes.some((node) => !BLOCK_TYPES.has(node.type))) return nodes;
	const out: MarkdownNode[] = [];
	let run: MarkdownNode[] = [];
	const flush = () => {
		if (run.length > 0) out.push({ type: "text", text: "", tokens: run });
		run = [];
	};
	for (const node of nodes) {
		if (BLOCK_TYPES.has(node.type)) {
			flush();
			out.push(node);
		} else {
			run.push(node);
		}
	}
	flush();
	return out;
}

// --- lexer ------------------------------------------------------------------

class Lexer {
	private nodes: MarkdownNode[] = [];
	private math: MathNode[] = [];
	private readonly renderer: Record<string, (children: string, meta?: unknown) => string>;

	constructor() {
		const push = (node: MarkdownNode): string => {
			this.nodes.push(node);
			return SENTINEL + (this.nodes.length - 1).toString(36) + SENTINEL;
		};
		const kids = (children: string): MarkdownNode[] => this.decode(children);
		const flat = (children: string): string => this.plainText(this.decode(children));

		this.renderer = {
			text: (raw: string) => {
				if (this.math.length === 0) return push({ type: "text", text: raw });
				const parts: MarkdownNode[] = [];
				splitMathPlaceholders(raw, this.math, parts);
				let out = "";
				for (const node of parts) out += push(node);
				return out;
			},
			heading: (children: string, meta?: unknown) =>
				push({ type: "heading", depth: (meta as HeadingMeta).level, tokens: kids(children) }),
			paragraph: (children: string) => {
				const tokens = kids(children);
				if (!tokens.some((node) => node.type === "blockMath")) {
					return push({ type: "paragraph", tokens });
				}
				// Display math placeholders sit inside the paragraph Bun built around
				// them; lift them back out as sibling blocks. Returning several
				// sentinels splits one callback into several nodes.
				let out = "";
				let run: MarkdownNode[] = [];
				const flush = () => {
					if (run.some((node) => node.type !== "text" || node.text.trim() !== "")) {
						out += push({ type: "paragraph", tokens: run });
					}
					run = [];
				};
				for (const node of tokens) {
					if (node.type === "blockMath") {
						flush();
						out += push(node);
					} else {
						run.push(node);
					}
				}
				flush();
				return out;
			},
			blockquote: (children: string) => push({ type: "blockquote", tokens: kids(children) }),
			code: (children: string, meta?: unknown) =>
				push({
					type: "code",
					// Bun emits the trailing newline of the fence as its own text node.
					text: flat(children).replace(/\n$/, ""),
					// Indented code blocks arrive without a metadata argument at all, and a
					// fence with no info string reports a null language.
					lang: (meta as CodeMeta | undefined)?.language ?? undefined,
				}),
			hr: () => push({ type: "hr" }),
			html: (children: string) => push({ type: "html", raw: flat(children) }),
			strong: (children: string) => push({ type: "strong", tokens: kids(children) }),
			emphasis: (children: string) => push({ type: "em", tokens: kids(children) }),
			strikethrough: (children: string) => push({ type: "del", tokens: kids(children) }),
			codespan: (children: string) => push({ type: "codespan", text: flat(children) }),
			link: (children: string, meta?: unknown) =>
				push({
					type: "link",
					href: (meta as LinkMeta).href,
					text: flat(children),
					tokens: kids(children),
				}),
			image: (children: string, meta?: unknown) =>
				push({ type: "image", href: (meta as ImageMeta).src, text: flat(children) }),
			listItem: (children: string) => push({ type: "list_item", tokens: groupInline(kids(children)) }),
			list: (children: string, meta?: unknown) => {
				const info = meta as ListMeta;
				return push({
					type: "list",
					ordered: info.ordered,
					start: info.start ?? 1,
					items: kids(children).filter((node): node is ListItemNode => node.type === "list_item"),
				});
			},
			th: (children: string) => push({ type: "table_cell", tokens: kids(children), text: "" }),
			td: (children: string) => push({ type: "table_cell", tokens: kids(children), text: "" }),
			tr: (children: string) => push({ type: "text", text: "", tokens: kids(children) }),
			thead: (children: string) => push({ type: "text", text: "thead", tokens: kids(children) }),
			tbody: (children: string) => push({ type: "text", text: "tbody", tokens: kids(children) }),
			table: (children: string) => {
				const sections = kids(children);
				const header: TableCellNode[] = [];
				const rows: TableCellNode[][] = [];
				for (const section of sections) {
					const rowNodes = "tokens" in section ? (section.tokens ?? []) : [];
					for (const row of rowNodes) {
						const cells = ("tokens" in row ? (row.tokens ?? []) : []).filter(
							(cell): cell is TableCellNode => cell.type === "table_cell",
						);
						if (section.type === "text" && section.text === "thead" && header.length === 0) {
							header.push(...cells);
						} else {
							rows.push(cells);
						}
					}
				}
				return push({ type: "table", header, rows });
			},
		};
	}

	/** Decode a children string back into the nodes its sentinels point at. */
	private decode(children: string): MarkdownNode[] {
		const out: MarkdownNode[] = [];
		let index = 0;
		while (index < children.length) {
			const open = children.indexOf(SENTINEL, index);
			if (open === -1) break;
			const close = children.indexOf(SENTINEL, open + 1);
			if (close === -1) break;
			// Bun writes soft/hard line breaks straight into the children string
			// rather than through a callback, so gaps between sentinels are literal.
			if (open > index) out.push({ type: "text", text: children.slice(index, open) });
			const node = this.nodes[Number.parseInt(children.slice(open + 1, close), 36)];
			if (node) out.push(node);
			index = close + 1;
		}
		if (index < children.length) out.push({ type: "text", text: children.slice(index) });
		return out;
	}

	private plainText(nodes: MarkdownNode[]): string {
		let out = "";
		for (const node of nodes) {
			if (node.type === "text" || node.type === "codespan") out += node.text;
			if ("tokens" in node && node.tokens) out += this.plainText(node.tokens);
		}
		return out;
	}

	lex(text: string): MarkdownNode[] {
		this.nodes = [];
		let source = text;
		this.math = [];
		if (needsPreprocessing(text)) {
			const prepared = preprocess(text);
			source = prepared.source;
			this.math = prepared.math;
		}
		const top = getBunMarkdown().render(source, this.renderer, {});
		return this.decode(top).filter((node) => node.type !== "text" || node.text.trim() !== "");
	}
}

/**
 * Stand-in for marked's `token.raw`, which Bun's renderer cannot supply: a
 * structural fingerprint of a block, used only as a render-cache key. Two blocks with
 * the same fingerprint render identically, which is all the cache requires. Two
 * independent FNV-1a accumulators keep collisions out of reach without building
 * the (potentially document-sized) string a literal digest would need.
 */
let hashA = 0;
let hashB = 0;

function hash(value: string): void {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		hashA = Math.imul(hashA ^ code, 0x01000193);
		hashB = Math.imul(hashB ^ code, 0x85ebca6b) + 1;
	}
}

function hashNode(node: MarkdownNode): void {
	hash(node.type);
	if ("depth" in node) hashA = Math.imul(hashA ^ node.depth, 0x01000193);
	if ("lang" in node && node.lang) hash(node.lang);
	if ("href" in node) hash(node.href);
	if ("ordered" in node) hashA = Math.imul(hashA ^ (node.start * 2 + (node.ordered ? 1 : 0)), 0x01000193);
	if ("text" in node) hash(node.text);
	if (node.type === "html") hash(node.raw);
	if ("tokens" in node && node.tokens) for (const child of node.tokens) hashNode(child);
	if ("items" in node) for (const item of node.items) hashNode(item);
	if ("header" in node) {
		for (const cell of node.header) hashNode(cell);
		for (const row of node.rows) for (const cell of row) hashNode(cell);
	}
}

export function blockDigest(node: MarkdownNode): string {
	hashA = 0x811c9dc5;
	hashB = 0xdeadbeef;
	hashNode(node);
	return `${hashA.toString(36)}:${hashB.toString(36)}`;
}

const lexer = new Lexer();

/** Parse markdown into the block-level node list the TUI renderer walks. */
export function lexMarkdown(text: string): MarkdownNode[] {
	return lexer.lex(text);
}
