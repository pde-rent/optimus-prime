/**
 * Top-level transformation for the Bun REPL.
 *
 * The REPL executes user code inside an async IIFE so top-level `await` works,
 * but a function body would scope `const`/`let`/`class`/`function` to that
 * invocation and drop them between `execute` calls. To keep declared bindings
 * alive across separate executes, we rewrite top-level declaration statements
 * into assignments against the persistent `globalThis` (the vm context's global
 * object), which survives across evaluations.
 *
 * Only *top-level* declarations are rewritten. Declarations nested inside
 * blocks, loops, functions, classes, or other braces keep their normal block
 * scoping and are left untouched.
 *
 * Top-level static `import` statements get the same treatment: a vm script cannot
 * run them at all, so they are rewritten to `await import(...)` with their bindings
 * assigned onto `globalThis` (see rewriteImport below).
 */

export interface TransformResult {
	/** The rewritten code, ready to be wrapped in an async IIFE. */
	code: string;
	/** The text of the final top-level statement, if it was an expression (used for result capture). */
	lastExpression?: string;
}

/** After a top-level `}`, does the following token continue the current statement? */
function isContinuationAfterBrace(src: string, i: number, current: string): boolean {
	let j = i;
	while (j < src.length && /\s/.test(src[j])) j++;
	if (j >= src.length) return false;
	const ch = src[j];
	// Operators, property/member/paren/call access, template continuation.
	if (".([`+-*/%?:,=&|!<>~^".includes(ch)) return true;
	if (ch === "/" && src[j + 1] === "/") return false;
	// A word: continue only for the keywords that legally follow a `}`. Any other
	// identifier or keyword (class/function/const/let/var/…) starts a new statement.
	if (/[A-Za-z_$]/.test(ch)) {
		const word = /[A-Za-z_$][\w$]*/.exec(src.slice(j))?.[0] ?? "";
		// `from` only continues an import clause (`import { a }\nfrom "m"`). Anywhere else
		// it is an ordinary identifier that legitimately starts a new statement, e.g.
		// `class C {}` followed by a `from(...)` call.
		if (word === "from") return /^import\b/.test(maskComments(current).trim());
		return ["else", "catch", "finally", "of", "in", "instanceof", "extends", "as", "satisfies"].includes(word);
	}
	return false;
}

interface Seg {
	/** Raw source of the segment. */
	src: string;
	/** True when the segment is a top-level declaration statement (const/let/var/class/function/async function). */
	isDecl: boolean;
	/** For decl segments: expanded assignment statements; for others: the source (unchanged). */
	out: string;
	/** True when this segment is a top-level expression statement (candidate for result capture). */
	isExpression: boolean;
}

/** Split source into top-level statement segments, brace/string/template/comment aware. */
function splitTopLevelSegments(src: string): Seg[] {
	const segs: Seg[] = [];
	let current = "";
	let depth = 0; // nesting of () [] {
	let stringMode: "'" | '"' | "`" | null = null;
	let lineComment = false;
	let blockComment = false;
	let i = 0;
	const n = src.length;

	const flush = (): void => {
		if (current.trim().length === 0) {
			current = "";
			return;
		}
		const trimmed = current.trim();
		const m = /^(async\s+)?(const|let|var|class|function)\b/.exec(trimmed);
		const isDecl = !!m;
		segs.push({
			src: current,
			isDecl,
			out: current,
			isExpression: !isDecl,
		});
		current = "";
	};

	while (i < n) {
		const ch = src[i];
		const next = src[i + 1];

		// Line comment
		if (!blockComment && stringMode === null && ch === "/" && next === "/") {
			lineComment = true;
			current += ch + next;
			i += 2;
			continue;
		}
		// Block comment
		if (!lineComment && stringMode === null && ch === "/" && next === "*") {
			blockComment = true;
			current += ch + next;
			i += 2;
			continue;
		}
		if (lineComment) {
			current += ch;
			if (ch === "\n") {
				lineComment = false;
				// A line comment swallows its own newline, so a statement that ends in one
				// merges with the next line. That is harmless for ordinary statements (the
				// engine's ASI sorts them out) but fatal for an import, which has to be
				// recognised as a whole statement to be rewritten, so end it here.
				if (depth === 0 && STATIC_IMPORT_HEAD.test(maskComments(current).trim())) {
					flush();
					current = "";
				}
			}
			i++;
			continue;
		}
		if (blockComment) {
			current += ch;
			if (ch === "*" && next === "/") {
				current += next;
				i += 2;
				blockComment = false;
				continue;
			}
			i++;
			continue;
		}

		// String / template mode
		if (stringMode !== null) {
			current += ch;
			if (stringMode === "`") {
				// handle ${ ... } nested template expressions by tracking braces
				if (ch === "\\") {
					current += src[i + 1] ?? "";
					i += 2;
					continue;
				}
				if (ch === "$" && next === "{") {
					// enter nested expression: raw-include until matching }
					current += next;
					i += 2;
					let tdepth = 1;
					while (i < n && tdepth > 0) {
						const c2 = src[i];
						if (c2 === "{") tdepth++;
						else if (c2 === "}") tdepth--;
						current += c2;
						i++;
					}
					continue;
				}
				if (ch === "`") stringMode = null;
			} else {
				if (ch === "\\") {
					current += src[i + 1] ?? "";
					i += 2;
					continue;
				}
				if (ch === stringMode) stringMode = null;
			}
			i++;
			continue;
		}

		// Entering a string/template
		if (ch === "'" || ch === '"' || ch === "`") {
			stringMode = ch;
			current += ch;
			i++;
			continue;
		}

		// Track nesting
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			current += ch;
			i++;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			if (depth > 0) depth--;
			current += ch;
			i++;
			// Only a top-level `}` closes a block/function/class body. A new statement may
			// follow on the same line (`function f(){} class C{}`), unless the next token
			// continues the current statement (`.`/`(`/`[`, or `else`/`catch`/`finally`/`of`).
			// A `)`/`]` never ends a statement — `(…) {}` continues the same one.
			if (ch === "}" && depth === 0 && !isContinuationAfterBrace(src, i, current)) {
				flush();
				current = "";
			}
			continue;
		}

		// At top level (depth 0), a newline or ; terminates a statement
		if (depth === 0 && (ch === ";" || ch === "\n")) {
			flush();
			current = "";
			// swallow the terminator
			i++;
			continue;
		}

		// If we're at depth 0 and the segment-so-far is empty/whitespace and we
		// hit a decl keyword, remember it (not strictly necessary; flush() re-detects)
		current += ch;
		i++;
	}

	if (current.trim().length > 0) flush();
	return segs.filter((s) => s.src.trim().length > 0);
}

/** Identifier extractor for a destructuring pattern text (no strings/templates expected). */
function extractPatternNames(pattern: string): string[] {
	const names: string[] = [];
	// Walk the pattern, collecting identifiers, ignoring property keys after a '.'
	let _depth = 0;
	let i = 0;
	let word = "";
	const n = pattern.length;
	const pushWord = () => {
		if (word.length > 0) {
			names.push(word);
			word = "";
		}
	};
	while (i < n) {
		const ch = pattern[i];
		if (/[A-Za-z0-9_$]/.test(ch)) {
			word += ch;
			i++;
			continue;
		}
		pushWord();
		if (ch === ".") {
			// consume the property name that follows (it is a key, not a binding)
			i++;
			let _key = "";
			while (i < n && /[A-Za-z0-9_$]/.test(pattern[i])) {
				_key += pattern[i];
				i++;
			}
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{" || ch === ")" || ch === "]" || ch === "}") {
			_depth++;
			i++;
			continue;
		}
		i++;
	}
	pushWord();
	return names;
}

/**
 * Rewrite one declaration segment (`const ... = ...;` etc.) into `globalThis.<name> = ...;`
 * statements, and return those statements. `funcLike` indicates a class/function decl,
 * whose whole tail (body) is the initializer.
 */
function rewriteDeclaration(src: string): { out: string; names: string[] } {
	const trimmed = src.trim();
	let m = /^(async\s+)?(const|let|var)\b/.exec(trimmed);
	const names: string[] = [];
	if (m) {
		// const / let / var
		const head = m[0];
		const rest = trimmed.slice(head.length).replace(/;$/, "");
		// split declarators on top-level commas
		const declarators = splitTopLevel(rest, ",");
		const assigns: string[] = [];
		for (const dec of declarators) {
			const eqIdx = findTopLevelChar(dec, "=");
			if (eqIdx === -1) {
				// no initializer: e.g. `let a;` -> just declare
				const pat = dec.trim();
				names.push(...extractPatternNames(pat));
				continue;
			}
			const pat = dec.slice(0, eqIdx).trim();
			const init = dec.slice(eqIdx + 1).trim();
			const patNames = extractPatternNames(pat);
			names.push(...patNames);
			if (init.length === 0) continue;
			if (patNames.length === 1) {
				assigns.push(`globalThis.${patNames[0]} = ${init};`);
			} else {
				// destructuring assignment pattern works directly
				assigns.push(`(${pat} = ${init});`);
			}
		}
		return { out: assigns.join("\n"), names };
	}

	m = /^(async\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
	if (m) {
		const name = m[2];
		// rebuild as `globalThis.Name = class <name> ...`
		const afterName = trimmed.slice(m[1] ? m[1].length : 0).replace(/^class\s+/, "");
		// afterName = "Name <tail>"; need "Name <tail>" for the anonymous-class name
		const tail = afterName.slice(name.length);
		return { out: `globalThis.${name} = class ${name}${tail}`, names: [name] };
	}

	m = /^(async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
	if (m) {
		const name = m[2];
		const isAsync = /^async\b/.test(trimmed);
		const tailStart = trimmed.indexOf("(");
		const tail = trimmed.slice(tailStart);
		const kw = isAsync ? "async function" : "function";
		return {
			out: `globalThis.${name} = ${kw} ${name}${tail}`,
			names: [name],
		};
	}

	return { out: src, names: [] };
}

/** Split `str` on `sep` at top level (not inside ()[]{} or strings). */
function splitTopLevel(str: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	let i = 0;
	const n = str.length;
	let quote: "'" | '"' | "`" | null = null;
	while (i < n) {
		const ch = str[i];
		if (quote) {
			cur += ch;
			if (ch === "\\") {
				cur += str[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			cur += ch;
			i++;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			cur += ch;
			i++;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			if (depth > 0) depth--;
			cur += ch;
			i++;
			continue;
		}
		if (ch === sep && depth === 0) {
			parts.push(cur);
			cur = "";
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	if (cur.trim().length > 0 || parts.length > 0) parts.push(cur);
	return parts;
}

function findTopLevelChar(str: string, target: string): number {
	let depth = 0;
	let i = 0;
	const n = str.length;
	let quote: "'" | '"' | "`" | null = null;
	while (i < n) {
		const ch = str[i];
		if (quote) {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			i++;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			if (depth > 0) depth--;
			i++;
			continue;
		}
		if (ch === target && depth === 0) return i;
		i++;
	}
	return -1;
}

// ---------------------------------------------------------------------------
// Static `import` statements.
//
// The REPL evaluates cells as vm scripts, not modules, so a static import is a
// hard SyntaxError whose message ("import call expects one or two arguments")
// reads like a mis-called function and tells the author nothing. Models write the
// documented ESM idiom by habit, so the transformer rewrites the top-level forms
// into `await import(...)` and binds the results onto `globalThis`, exactly like a
// top-level `const`, so imported names survive into later cells.
// ---------------------------------------------------------------------------

/**
 * Does this statement start a static `import`?
 *
 * Deliberately excludes `import(` (already dynamic) and `import.meta`, and requires
 * a separator so identifiers such as `importAll()` are not matched.
 */
const STATIC_IMPORT_HEAD = /^import(?:\s+["'*{A-Za-z_$]|\s*["'*{])/;

/**
 * Blank out every comment, leaving string literals and character offsets intact.
 *
 * Import statements are matched and parsed against this masked copy, so a comment
 * before, after, or inside one cannot defeat the parse, while offsets still index
 * into the original source for the parts the rewrite keeps verbatim.
 */
const STRING_OR_COMMENT = /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1?|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
function maskComments(src: string): string {
	return src.replace(STRING_OR_COMMENT, (m) => (m.startsWith("/") ? " ".repeat(m.length) : m));
}

/** True when `src` contains a top-level static import statement. */
export function hasStaticImport(src: string): boolean {
	return splitTopLevelSegments(src).some((s) => STATIC_IMPORT_HEAD.test(maskComments(s.src).trim()));
}

/** If `text` is exactly one single/double-quoted string literal, return it verbatim; else null. */
function wholeStringLiteral(text: string): string | null {
	const s = text.trim();
	const quote = s[0];
	if (quote !== '"' && quote !== "'") return null;
	let i = 1;
	while (i < s.length) {
		if (s[i] === "\\") {
			i += 2;
			continue;
		}
		if (s[i] === quote) return i === s.length - 1 ? s : null;
		if (s[i] === "\n") return null;
		i++;
	}
	return null;
}

/** Index of the last top-level `from` keyword in an import clause, or -1. */
function lastTopLevelFrom(text: string): number {
	let found = -1;
	let depth = 0;
	let quote: "'" | '"' | "`" | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			if (depth > 0) depth--;
			continue;
		}
		if (depth !== 0) continue;
		if (text.startsWith("from", i) && (i === 0 || !/[\w$]/.test(text[i - 1])) && !/[\w$]/.test(text[i + 4] ?? " ")) {
			found = i;
		}
	}
	return found;
}

interface NamedSpecifier {
	/** The exported name on the module namespace. */
	name: string;
	/** The local binding it is exposed as. */
	local: string;
}

/**
 * Parse one entry of an `{ … }` import clause.
 *
 * Returns `undefined` for a type-only specifier (erased), `null` when the shape is
 * not understood (the whole statement is then left alone).
 */
function parseNamedSpecifier(raw: string): NamedSpecifier | null | undefined {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const isName = (t: string): boolean => /^[A-Za-z_$][\w$]*$/.test(t);
	// `type` is also a legal binding name: `{ type }` and `{ type as t }` import it,
	// while `{ type A }` / `{ type A as B }` are TypeScript type-only specifiers.
	if (tokens[0] === "type" && tokens.length > 1 && tokens[1] !== "as") return undefined;
	if (tokens.length === 1 && isName(tokens[0])) return { name: tokens[0], local: tokens[0] };
	if (tokens.length === 3 && tokens[1] === "as" && isName(tokens[0]) && isName(tokens[2])) {
		return { name: tokens[0], local: tokens[2] };
	}
	return null;
}

/**
 * Rewrite a top-level static import into dynamic-import assignments, or return null
 * when the form is not understood. Returning the original statement unchanged is far
 * safer than guessing: it fails loudly (with the hint added in repl-script) instead of
 * silently binding the wrong thing.
 *
 * `masked` is the statement with its comments blanked (see maskComments).
 */
function rewriteImport(masked: string, index: number): string | null {
	const stmt = masked.replace(/;+\s*$/, "").trim();
	const rest = stmt.slice("import".length).trim();

	// `import "m"` — side effect only.
	const bare = wholeStringLiteral(rest);
	if (bare !== null) return `await import(${bare});`;

	const fromIdx = lastTopLevelFrom(rest);
	if (fromIdx < 0) return null;
	const specifier = wholeStringLiteral(rest.slice(fromIdx + 4));
	if (specifier === null) return null;
	const clause = rest.slice(0, fromIdx).trim();
	if (!clause) return null;

	// `import type X from "m"` / `import type { A } from "m"` are erased entirely.
	// `import type from "m"` (clause is exactly `type`) is a default import named `type`.
	if (/^type\s/.test(clause)) return "";

	let defaultLocal: string | null = null;
	let namespaceLocal: string | null = null;
	const named: NamedSpecifier[] = [];
	let sawTypeOnly = false;
	let sawBraces = false;

	// A `{ … }` group can only be the last clause part, so splitting on top-level commas
	// keeps the braced group intact as one part.
	for (const part of splitTopLevel(clause, ",")) {
		const p = part.trim();
		if (!p) continue;
		if (p.startsWith("{")) {
			if (!p.endsWith("}")) return null;
			sawBraces = true;
			for (const spec of splitTopLevel(p.slice(1, -1), ",")) {
				if (!spec.trim()) continue;
				const parsed = parseNamedSpecifier(spec);
				if (parsed === null) return null;
				if (parsed === undefined) {
					sawTypeOnly = true;
					continue;
				}
				named.push(parsed);
			}
			continue;
		}
		const ns = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(p);
		if (ns) {
			if (namespaceLocal) return null;
			namespaceLocal = ns[1];
			continue;
		}
		if (/^[A-Za-z_$][\w$]*$/.test(p)) {
			if (defaultLocal) return null;
			defaultLocal = p;
			continue;
		}
		return null;
	}

	// Every specifier was type-only: TypeScript elides the statement, so do the same.
	if (!defaultLocal && !namespaceLocal && named.length === 0) {
		if (sawTypeOnly) return "";
		// `import {} from "m"` still runs the module for its side effects.
		return sawBraces ? `await import(${specifier});` : null;
	}

	const mod = `__mod${index}`;
	const lines = [`const ${mod} = await import(${specifier});`];
	if (defaultLocal) lines.push(`globalThis.${defaultLocal} = ${mod}.default;`);
	if (namespaceLocal) lines.push(`globalThis.${namespaceLocal} = ${mod};`);
	for (const { name, local } of named) lines.push(`globalThis.${local} = ${mod}[${JSON.stringify(name)}];`);
	// Wrapped in a block so the module temp cannot collide with a second import in the
	// same cell, and so it does not leak into the namespace listing.
	return `{ ${lines.join(" ")} }`;
}

/** Transform a single top-level segment. */
function transformSegment(seg: Seg, index: number): Seg {
	const trimmed = seg.src.trim();
	if (!trimmed) return seg;
	// Comments are masked (not removed) so `codeStart` still indexes the real source,
	// keeping any comment that precedes the statement in the emitted output.
	const masked = maskComments(seg.src);
	const codeStart = masked.search(/\S/);
	const stmt = codeStart < 0 ? "" : masked.slice(codeStart).trim();
	if (STATIC_IMPORT_HEAD.test(stmt)) {
		const rewritten = rewriteImport(stmt, index);
		// An import binds names for the rest of the session, so it behaves like a
		// declaration: never the cell's result value. An unrecognized form keeps its
		// original source and fails with the hint runJs attaches.
		seg.out = rewritten === null ? seg.src : seg.src.slice(0, codeStart) + rewritten;
		seg.isDecl = true;
		seg.isExpression = false;
		return seg;
	}
	if (!stmt) {
		// Comment-only segment. Capturing it as the cell's result would emit
		// `return (// done);`, so a cell that merely ends in a comment fails to compile.
		seg.out = seg.src;
		seg.isDecl = false;
		seg.isExpression = false;
		return seg;
	}
	const isDecl = /^(async\s+)?(const|let|var|class|function)\b/.test(trimmed);
	seg.isDecl = isDecl;
	if (isDecl) {
		const { out } = rewriteDeclaration(seg.src);
		// A declaration the rewriter could not read produces nothing. Emitting that would
		// delete the statement and report the cell as a success, so keep the original
		// source and let the engine raise the syntax error the author actually wrote.
		seg.out = out.trim() ? out : seg.src;
		seg.isExpression = false;
	} else {
		seg.out = seg.src;
		seg.isExpression = !/^(if|for|while|switch|try|return|throw|break|continue|import|export|do|with)\b/.test(
			trimmed,
		);
	}
	return seg;
}

export function transformTopLevel(src: string): TransformResult {
	const segs = splitTopLevelSegments(src).map((seg, i) => transformSegment(seg, i));
	// Last top-level expression becomes the cell's result value (like IPython's `Out`),
	// so it is emitted as a `return` rather than executed a second time.
	let lastIndex = -1;
	for (let k = segs.length - 1; k >= 0; k--) {
		const s = segs[k];
		if (s.isDecl) break;
		if (s.isExpression && s.src.trim()) {
			lastIndex = k;
			break;
		}
	}
	let code = "";
	for (let k = 0; k < segs.length; k++) {
		if (k === lastIndex) continue;
		code += `${segs[k].out}\n`;
	}
	const lastExpression = lastIndex >= 0 ? segs[lastIndex].src.trim().replace(/;$/, "") : undefined;
	return { code, lastExpression };
}
