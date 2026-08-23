import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { IgnoreMatcher } from "../utils/ignore-matcher.js";
import { toPosixPath } from "../utils/shared.js";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type { IgnoreMatcher };

/**
 * Rewrite one gitignore-style line so it applies relative to the tree root
 * instead of the directory whose ignore file declared it.
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * Load .gitignore/.ignore/.fdignore rules from `dir` into the matcher,
 * re-anchored so patterns keep working when matching paths relative to `rootDir`.
 */
export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {
			// Unreadable ignore file: skip it rather than failing resource loading.
		}
	}
}
