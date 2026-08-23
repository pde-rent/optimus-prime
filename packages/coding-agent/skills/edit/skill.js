/**
 * Targeted edits to existing files, two ways.
 *
 * `edit(path, old, new)` replaces a unique string. It needs no prior read, but it
 * must quote the old text -- which is the bulk of its cost on a large hunk -- and it
 * cannot express a pure insertion without retyping an anchor twice.
 *
 * `edit.patch(path, tag, hunks)` names lines instead of quoting them. Line numbers
 * are only safe if the file has not moved under the model since it looked, so a patch
 * carries a tag: a short hash of the file content that `edit.src()` printed. The tag
 * is validated by re-hashing the live file, never by trusting the recorded snapshot,
 * so a stale anchor is rejected before it can corrupt code.
 *
 * The tag idea is adapted from oh-my-pi's hashline (https://omp.sh, MIT). Their
 * version is a text patch DSL with a tokenizer, parser and grammar; none of that is
 * needed here, because in a REPL the arguments are already the parse tree.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

// Keep in sync with DIFF_DISPLAY_MIME in src/core/tools/repl-types.ts.
const DIFF_DISPLAY_MIME = "application/vnd.optimus-prime.diff+json";

/** Expand a leading `~` (or `~user`, which only resolves for the current user). */
function expandUser(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
	return path;
}

/** Trailing whitespace and CR are stripped per line so a formatter-only change does not invalidate a tag. */
function hashText(text) {
	const normalized = text.replace(/[ \t\r]+(?=\n|$)/g, "");
	return (Bun.hash.xxHash32(normalized, 0) & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

/** Windows line endings are restored on write, so an edit never reformats a file wholesale. */
function splitLines(text) {
	const crlf = text.includes("\r\n");
	return { lines: text.replace(/\r\n/g, "\n").split("\n"), join: (parts) => parts.join(crlf ? "\r\n" : "\n") };
}

export default function createSkill({ display, cwd }) {
	/**
	 * Content this session has shown the model, by resolved path. Only ever read to
	 * report what changed; a tag is always checked against the file on disk.
	 */
	const snapshots = new Map();
	/**
	 * Replace a unique string in a file.
	 *
	 * `old_str` must appear exactly once in the file at `path`; that match is
	 * replaced with `new_str` and the file is written back in place. Prefer this
	 * over rewriting a whole file for targeted edits.
	 *
	 * @param {string} path File to edit: relative to cwd, absolute, or `~`-prefixed.
	 * @param {string} oldStr Exact text to find. Must occur exactly once.
	 * @param {string} newStr Replacement text.
	 * @returns {Promise<string>} A short confirmation message.
	 * @throws If the file is missing, or `old_str` is absent or matches more than once.
	 */
	/** Resolve `~`, relative and absolute paths the same way for every entry point. */
	function resolvePath(path) {
		const expanded = expandUser(path);
		return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	}

	async function run(path, oldStrOrPairs, newStr) {
		if (typeof path !== "string") throw new TypeError(`path must be a string, got ${typeof path}`);
		const pairs = Array.isArray(oldStrOrPairs)
			? oldStrOrPairs.map((pair) => (Array.isArray(pair) ? pair : [pair[0], pair[1]]))
			: [[oldStrOrPairs, newStr]];
		for (const [o] of pairs) {
			if (typeof o !== "string") throw new TypeError(`old_str must be a string, got ${typeof o}`);
		}
		if (!Array.isArray(oldStrOrPairs) && typeof newStr !== "string") {
			throw new TypeError(`new_str must be a string, got ${typeof newStr}`);
		}

		const resolvedPath = resolvePath(path);
		const file = Bun.file(resolvedPath);
		if (!(await file.exists())) {
			throw new Error(`${path} not found`);
		}

		let content = await file.text();
		for (const [o, n] of pairs) {
			content = applyReplacement(resolvedPath, path, content, o, n);
		}
		await Bun.write(resolvedPath, content);
		snapshots.set(resolvedPath, content);
		return `Edited ${resolvedPath} (${pairs.length} replacement${pairs.length === 1 ? "" : "s"})`;
	}

	/** Find the single occurrence of oldStr in content and return content with it replaced. */
	function applyReplacement(resolvedPath, path, content, oldStr, newStr) {
		let count = 0;
		let index = content.indexOf(oldStr);
		const matchIndex = index;
		while (index !== -1) {
			count += 1;
			if (count > 1) break;
			index = content.indexOf(oldStr, index + Math.max(oldStr.length, 1));
		}
		if (count === 0) throw new Error(`string not found in ${path}`);
		if (count > 1) {
			throw new Error(`found ${count} occurrences in ${path}, need exactly 1 — widen the snippet to make it unique`);
		}

		const startLine = content.slice(0, matchIndex).split("\n").length;
		const updated = content.replace(oldStr, newStr);

		try {
			display({
				mimeType: DIFF_DISPLAY_MIME,
				data: { path: resolvedPath, old_str: oldStr, new_str: newStr, start_line: startLine },
			});
		} catch {
			// display is best-effort: the edit already landed
		}
		return updated;
	}

	/**
	 * Print a file with line numbers, and record the tag that `patch` will require.
	 *
	 * @param {string} path File to read.
	 * @param {number} [from] First line, 1-based.
	 * @param {number} [to] Last line, inclusive.
	 * @returns {Promise<string>} `[path#TAG]` followed by `N:text` rows.
	 */
	async function src(path, from = 1, to = Number.POSITIVE_INFINITY) {
		const resolvedPath = resolvePath(path);
		const file = Bun.file(resolvedPath);
		if (!(await file.exists())) throw new Error(`${path} not found`);
		const text = await file.text();
		const { lines } = splitLines(text);
		const tag = hashText(text);
		snapshots.set(resolvedPath, text);
		const first = Math.max(1, Math.floor(from));
		const last = Math.min(lines.length, to === Number.POSITIVE_INFINITY ? lines.length : Math.floor(to));
		const body = lines.slice(first - 1, last).map((line, index) => `${first + index}:${line}`);
		return [`[${path}#${tag}]`, ...body].join("\n");
	}

	/**
	 * Apply line-addressed hunks to a file, rejecting the whole call if the file has
	 * changed since `tag` was issued.
	 *
	 * Every line number indexes the tagged snapshot, so numbers never shift between
	 * hunks in one call. Hunks are applied last-first for that reason.
	 *
	 * @param {string} path File to edit.
	 * @param {string} tag Tag from the most recent `edit.src()` or `edit.patch()` of this file.
	 * @param {Array<{at?: [number, number], after?: number, text?: string}>} hunks
	 *   `{at:[a,b], text}` replaces original lines a..b, `{at:[a,b]}` deletes them, and
	 *   `{after:n, text}` inserts after line n (`after:0` inserts at the head).
	 * @returns {Promise<string>} The new tag, for the next patch without re-reading.
	 */
	async function patch(path, tag, hunks) {
		if (typeof tag !== "string" || !/^[0-9A-Fa-f]{4}$/.test(tag)) {
			throw new TypeError(`tag must be the 4-character tag from edit.src("${path}"), got ${JSON.stringify(tag)}`);
		}
		if (!Array.isArray(hunks) || hunks.length === 0) throw new TypeError("hunks must be a non-empty array");

		const resolvedPath = resolvePath(path);
		const file = Bun.file(resolvedPath);
		if (!(await file.exists())) throw new Error(`${path} not found`);
		const before = await file.text();
		const live = hashText(before);
		const { lines, join } = splitLines(before);

		if (live !== tag.toUpperCase()) {
			// Hand back everything needed to retry in one go: the fresh tag, and the text
			// now sitting at each anchor. Without this the model must re-read to recover,
			// which is the round trip that makes stale anchors expensive.
			const seen = snapshots.has(resolvedPath);
			const context = hunks
				.map((hunk) => (hunk.at ? hunk.at[0] : hunk.after) ?? 1)
				.map((line) => `  ${line}:${lines[line - 1] ?? "<past end of file>"}`)
				.join("\n");
			throw new Error(
				`${path} changed since tag #${tag.toUpperCase()}; it now hashes to #${live}. ` +
					`${seen ? "A later edit or an external write moved it." : "That tag was not issued in this session."} ` +
					`Retry against #${live}, or re-read with edit.src(). Current text at your anchors:\n${context}`,
			);
		}

		const normalized = hunks.map((hunk, index) => {
			const insert = hunk.after !== undefined;
			const start = insert ? Math.floor(hunk.after) + 1 : Math.floor(hunk.at?.[0]);
			const end = insert ? Math.floor(hunk.after) : Math.floor(hunk.at?.[1]);
			if (!Number.isFinite(start) || !Number.isFinite(end)) {
				throw new TypeError(`hunk ${index} needs {at:[a,b]} or {after:n}`);
			}
			if (!insert && (start < 1 || end > lines.length || end < start)) {
				throw new RangeError(`hunk ${index} range ${start}..${end} is outside 1..${lines.length} of ${path}`);
			}
			if (insert && (start < 1 || start > lines.length + 1)) {
				throw new RangeError(`hunk ${index} inserts after line ${hunk.after}, past the end of ${path}`);
			}
			return { start, end, insert, body: hunk.text === undefined ? [] : splitLines(String(hunk.text)).lines };
		});

		const ordered = [...normalized].sort((left, right) => left.start - right.start);
		for (let index = 1; index < ordered.length; index++) {
			if (ordered[index].start <= ordered[index - 1].end) {
				throw new RangeError(
					`hunks overlap at line ${ordered[index].start} of ${path}; each line may be touched once`,
				);
			}
		}

		// Last first, so earlier hunks still address the original numbering.
		const next = [...lines];
		for (const hunk of [...ordered].reverse()) {
			next.splice(hunk.start - 1, hunk.insert ? 0 : hunk.end - hunk.start + 1, ...hunk.body);
		}
		const after = join(next);
		if (after === before) {
			// A patch that parses, applies, and changes nothing reads to the model as a bad
			// anchor, and it responds by widening the payload. Failing loudly stops that.
			throw new Error(
				`${path} unchanged: the hunk bodies are already byte-identical to those lines. Re-read before editing again rather than widening the range.`,
			);
		}

		await Bun.write(resolvedPath, after);
		snapshots.set(resolvedPath, after);
		try {
			display({
				mimeType: DIFF_DISPLAY_MIME,
				data: { path: resolvedPath, old_str: before, new_str: after, start_line: 1 },
			});
		} catch {
			// display is best-effort: the edit already landed
		}
		return hashText(after);
	}

	// Callable directly (`await edit(path, old, new)`) and as `edit.run(...)`,
	// mirroring the documented call shapes.
	return Object.assign(run, { run, src, patch });
}
