/**
 * Exact single-occurrence string replacement for existing files.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

// Keep in sync with DIFF_DISPLAY_MIME in src/core/tools/repl-types.ts.
const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

/** Expand a leading `~` (or `~user`, which only resolves for the current user). */
function expandUser(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
	return path;
}

export default function createSkill({ display, cwd }) {
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
	async function run(path, oldStr, newStr) {
		if (typeof path !== "string") throw new TypeError(`path must be a string, got ${typeof path}`);
		if (typeof oldStr !== "string") throw new TypeError(`old_str must be a string, got ${typeof oldStr}`);
		if (typeof newStr !== "string") throw new TypeError(`new_str must be a string, got ${typeof newStr}`);

		const expanded = expandUser(path);
		const resolvedPath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
		const file = Bun.file(resolvedPath);
		if (!(await file.exists())) {
			throw new Error(`${path} not found`);
		}

		const content = await file.text();
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
		await Bun.write(resolvedPath, content.replace(oldStr, newStr));

		try {
			display({
				mimeType: DIFF_DISPLAY_MIME,
				data: { path: resolvedPath, old_str: oldStr, new_str: newStr, start_line: startLine },
			});
		} catch {
			// display is best-effort: the edit already landed
		}
		return `Edited ${resolvedPath}`;
	}

	// Callable directly (`await edit(path, old, new)`) and as `edit.run(...)`,
	// mirroring the documented call shapes.
	return Object.assign(run, { run });
}
