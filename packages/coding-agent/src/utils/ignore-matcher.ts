/**
 * Gitignore pattern matching, replacing the `ignore` package.
 *
 * Implements the rules from gitignore(5) that this codebase depends on: comments and blank
 * lines, `!` negation with last-match-wins, `/` anchoring, trailing-slash directory-only
 * patterns, `*`/`?` within a path segment, and `**` across segments.
 */

interface Rule {
	test: RegExp;
	negated: boolean;
	directoryOnly: boolean;
}

/** Escape the regex metacharacters that are literal in a glob. */
const escapeLiteral = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Translate one gitignore pattern into a regular expression.
 *
 * The expression is matched against a path relative to the ignore file, with no leading slash.
 */
function compile(pattern: string): RegExp {
	let body = pattern;
	// An anchored pattern matches only from the root; an unanchored one matches at any depth.
	// A pattern is anchored if it has a leading slash, or a slash anywhere but the very end.
	const withoutTrailingSlash = body.endsWith("/") ? body.slice(0, -1) : body;
	const anchored = body.startsWith("/") || withoutTrailingSlash.includes("/");
	if (body.startsWith("/")) body = body.slice(1);
	if (body.endsWith("/")) body = body.slice(0, -1);

	let source = "";
	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char === "*") {
			const isDouble = body[i + 1] === "*";
			if (isDouble) {
				const before = body[i - 1];
				const after = body[i + 2];
				i++;
				if ((before === undefined || before === "/") && (after === undefined || after === "/")) {
					if (after === undefined) {
						// A trailing `**` matches everything below, to any depth.
						source += ".*";
						continue;
					}
					// A whole `**` segment: any number of segments, including none.
					i++;
					source += "(?:.*/)?";
					continue;
				}
				// `**` glued to other characters degrades to "anything, slashes included".
				source += ".*";
				continue;
			}
			// A single `*` stops at a separator.
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		if (char === "[") {
			const end = body.indexOf("]", i + 1);
			if (end !== -1) {
				let set = body.slice(i + 1, end);
				if (set.startsWith("!")) set = `^${set.slice(1)}`;
				source += `[${set}]`;
				i = end;
				continue;
			}
			source += "\\[";
			continue;
		}
		source += escapeLiteral(char);
	}

	// An unanchored pattern may start at any segment boundary. Everything below the match is
	// also ignored, which is what the trailing group allows.
	const prefix = anchored ? "^" : "^(?:.*/)?";
	return new RegExp(`${prefix}${source}(?:/.*)?$`);
}

/** Strip unescaped trailing whitespace, which gitignore ignores. */
function trimPattern(line: string): string {
	let end = line.length;
	while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
		if (end > 1 && line[end - 2] === "\\") break;
		end--;
	}
	return line.slice(0, end);
}

export class IgnoreMatcher {
	private rules: Rule[] = [];

	/** Add one pattern, a newline-separated block, or a list of either. */
	add(input: string | string[]): this {
		const lines = Array.isArray(input) ? input.flatMap((entry) => entry.split(/\r?\n/)) : input.split(/\r?\n/);
		for (const raw of lines) {
			let line = trimPattern(raw);
			if (!line || line.startsWith("#")) continue;
			const negated = line.startsWith("!");
			if (negated) line = line.slice(1);
			// `\#` and `\!` escape a leading character that would otherwise be special.
			if (line.startsWith("\\")) line = line.slice(1);
			if (!line) continue;
			this.rules.push({ test: compile(line), negated, directoryOnly: line.endsWith("/") });
		}
		return this;
	}

	/**
	 * True when `path` is ignored.
	 *
	 * `path` is relative to the ignore file and uses forward slashes; a trailing slash marks it
	 * as a directory, which is how directory-only patterns are honoured.
	 */
	ignores(path: string): boolean {
		const isDirectory = path.endsWith("/");
		const subject = isDirectory ? path.slice(0, -1) : path;
		if (!subject) return false;
		// gitignore(5): a file cannot be re-included once a parent directory is excluded, so an
		// excluded ancestor settles it before any `!` rule on the path itself is considered.
		const segments = subject.split("/");
		for (let i = 1; i < segments.length; i++) {
			if (this.matches(segments.slice(0, i).join("/"), true)) return true;
		}
		return this.matches(subject, isDirectory);
	}

	/** Apply every rule to one path, last match winning. */
	private matches(subject: string, isDirectory: boolean): boolean {
		let ignored = false;
		for (const rule of this.rules) {
			// A directory-only pattern never matches a file of the same name. Descendants are
			// covered by the ancestor walk in `ignores`, not by widening the pattern here —
			// widening it would let a negation like `!*/` re-include files inside a directory.
			if (rule.directoryOnly && !isDirectory) continue;
			if (!rule.test.test(subject)) continue;
			ignored = !rule.negated;
		}
		return ignored;
	}
}

export default function ignore(): IgnoreMatcher {
	return new IgnoreMatcher();
}
