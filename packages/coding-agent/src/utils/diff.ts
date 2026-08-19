/**
 * Myers diff, replacing the `diff` package.
 *
 * Implements the greedy O(ND) algorithm from "An O(ND) Difference Algorithm and Its
 * Variations" (Myers, 1986): walk furthest-reaching D-paths, recording each frontier, then walk
 * the frontiers backwards to recover the edit script. Only the two entry points this codebase
 * used are provided, returning the same `Change` shape the package did.
 */

export interface Change {
	value: string;
	added?: boolean;
	removed?: boolean;
	/** Number of tokens (lines or words) the change covers. */
	count?: number;
}

/**
 * Diff two token lists, returning runs of equal / removed / added indices.
 *
 * `equals` decides token identity, which is what lets the word differ treat any two runs of
 * whitespace as the same token.
 */
function myers<T>(a: T[], b: T[], equals: (x: T, y: T) => boolean): Array<{ type: -1 | 0 | 1; tokens: T[] }> {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	// `v[k]` is the furthest x reached on diagonal k; one snapshot is kept per edit distance so
	// the path can be walked back once the end is reached.
	const v = new Int32Array(2 * max + 1);
	const offset = max;
	const trace: Int32Array[] = [];

	let d = 0;
	outer: for (; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			// Extend downward when that diagonal is further along, otherwise rightward.
			let x =
				k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			// Free ride along the diagonal for as long as the tokens match.
			while (x < n && y < m && equals(a[x], b[y])) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) break outer;
		}
	}

	// Walk the frontiers backwards, emitting one step per edit.
	const steps: Array<{ type: -1 | 0 | 1; token: T }> = [];
	let x = n;
	let y = m;
	for (let depth = Math.min(d, trace.length - 1); depth > 0; depth--) {
		const previous = trace[depth];
		const k = x - y;
		const fromK =
			k === -depth || (k !== depth && previous[offset + k - 1] < previous[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = previous[offset + fromK];
		const prevY = prevX - fromK;
		while (x > prevX && y > prevY) {
			// Take the token from the new side: a loose whitespace match means the two differ,
			// and the new spelling is the one being rendered.
			x--;
			steps.push({ type: 0, token: b[--y] });
		}
		if (x > prevX) steps.push({ type: -1, token: a[--x] });
		else if (y > prevY) steps.push({ type: 1, token: b[--y] });
	}
	while (x > 0 && y > 0) {
		x--;
		steps.push({ type: 0, token: b[--y] });
	}
	while (x > 0) steps.push({ type: -1, token: a[--x] });
	while (y > 0) steps.push({ type: 1, token: b[--y] });
	steps.reverse();

	// Collapse consecutive steps of the same kind into runs.
	const runs: Array<{ type: -1 | 0 | 1; tokens: T[] }> = [];
	for (const step of steps) {
		const last = runs[runs.length - 1];
		if (last && last.type === step.type) last.tokens.push(step.token);
		else runs.push({ type: step.type, tokens: [step.token] });
	}
	return runs;
}

/** Order runs so a removal always precedes the addition it sits beside. */
function toChanges<T>(runs: Array<{ type: -1 | 0 | 1; tokens: T[] }>, join: (tokens: T[]) => string): Change[] {
	const ordered: Array<{ type: -1 | 0 | 1; tokens: T[] }> = [];
	for (const run of runs) {
		const previous = ordered[ordered.length - 1];
		if (run.type === -1 && previous?.type === 1) {
			// The package emits removed-then-added; Myers can produce either order.
			ordered[ordered.length - 1] = run;
			ordered.push(previous);
			continue;
		}
		ordered.push(run);
	}
	return ordered.map((run) => {
		const change: Change = { value: join(run.tokens), count: run.tokens.length };
		if (run.type === 1) change.added = true;
		if (run.type === -1) change.removed = true;
		return change;
	});
}

/** Split into lines, each keeping its trailing newline so the pieces rejoin exactly. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	const trailing = lines[lines.length - 1] === "";
	if (trailing) lines.pop();
	return lines.map((line, i) => (i === lines.length - 1 && !trailing ? line : `${line}\n`));
}

export function diffLines(oldText: string, newText: string): Change[] {
	const runs = myers(splitLines(oldText), splitLines(newText), (x, y) => x === y);
	return toChanges(runs, (tokens) => tokens.join(""));
}

/**
 * Split into whitespace runs, word runs, and single punctuation characters.
 *
 * Punctuation is separated so `1;` against `2;` reports the digit as the change and leaves the
 * semicolon equal, rather than rewriting the whole token.
 */
function splitWords(text: string): string[] {
	return text.match(/\s+|[\w]+|[^\s\w]/g) ?? [];
}

const isWhitespace = (token: string): boolean => /^\s+$/.test(token);

/**
 * Word diff.
 *
 * Whitespace runs compare equal to each other regardless of length, matching the package's
 * behaviour: reflowing a paragraph should not mark every word as changed.
 */
export function diffWords(oldText: string, newText: string): Change[] {
	const before = splitWords(oldText);
	const after = splitWords(newText);
	const runs = myers(before, after, (x, y) => x === y || (isWhitespace(x) && isWhitespace(y)));

	// Two presentational rules the package applies, both of which keep an edit visually tight.
	for (let i = 0; i < runs.length; i++) {
		const run = runs[i];
		const next = runs[i + 1];
		// Whitespace that merely leads an inserted or deleted run belongs to the equal text
		// before it, so a trailing space is not highlighted as part of the change.
		if (run.type === 0 && next && next.type !== 0 && next.tokens.length > 1 && isWhitespace(next.tokens[0])) {
			run.tokens.push(next.tokens.shift() as string);
		}
	}
	return toChanges(runs, (tokens) => tokens.join(""));
}
