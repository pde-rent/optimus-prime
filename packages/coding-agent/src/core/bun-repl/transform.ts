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
 */

export interface TransformResult {
	/** The rewritten code, ready to be wrapped in an async IIFE. */
	code: string;
	/** The text of the final top-level statement, if it was an expression (used for result capture). */
	lastExpression?: string;
}

/** After a top-level `}`, does the following token continue the current statement? */
function isContinuationAfterBrace(src: string, i: number): boolean {
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
			if (ch === "\n") lineComment = false;
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
			if (ch === "}" && depth === 0 && !isContinuationAfterBrace(src, i)) {
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

/** Transform a single top-level segment. */
function transformSegment(seg: Seg): Seg {
	const trimmed = seg.src.trim();
	if (!trimmed) return seg;
	const isDecl = /^(async\s+)?(const|let|var|class|function)\b/.test(trimmed);
	seg.isDecl = isDecl;
	if (isDecl) {
		const { out } = rewriteDeclaration(seg.src);
		seg.out = out;
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
	const segs = splitTopLevelSegments(src).map(transformSegment);
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
