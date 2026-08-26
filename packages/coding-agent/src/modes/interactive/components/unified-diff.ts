/**
 * Detection and parsing of unified diffs in arbitrary tool output, so text like
 * `git diff` output renders through the same rich diff renderer as edit results.
 *
 * Conservative by design: a region only counts as a diff when it has a real
 * `--- `/`+++ ` file-header pair followed by at least one `@@ -l,c +l,c @@`
 * hunk header. Ordinary shell output (chatter like "++ done" or "---" rules)
 never engages the renderer.
 */

/** Total output lines above which a detected diff falls back to plain rendering. */
export const MAX_UNIFIED_DIFF_LINES = 2000;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const GIT_METADATA_LINE =
	/^(?:index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

interface DiffLineSpec {
	sign: "+" | "-" | " ";
	lineNum: number;
	content: string;
}

export interface UnifiedDiffFile {
	/** Display path with `a/` / `b/` prefixes and quotes stripped. */
	path: string;
	/** File body rendered in the rich renderer's `<sign><lineNum> <content>` format. */
	diffText: string;
	added: number;
	removed: number;
}

export type ParsedDiffBlock = { kind: "text"; text: string } | { kind: "diff"; file: UnifiedDiffFile };

export interface ParsedUnifiedDiff {
	blocks: ParsedDiffBlock[];
	files: UnifiedDiffFile[];
	/** True when the output looks like a diff but exceeds MAX_UNIFIED_DIFF_LINES. */
	tooLarge: boolean;
}

function stripQuotes(path: string): string {
	if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
		return path.slice(1, -1);
	}
	return path;
}

/** Strip timestamps after a tab, quoting, and git's a/ b/ prefixes; keep /dev/null as-is. */
function headerPath(raw: string): string {
	const withoutTimestamp = raw.split("\t")[0] ?? "";
	return stripQuotes(withoutTimestamp.trim());
}

function displayPath(oldRaw: string, newRaw: string): string | undefined {
	const oldPath = headerPath(oldRaw);
	const newPath = headerPath(newRaw);
	const chosen = oldPath === "/dev/null" ? newPath : oldPath === "" ? newPath : oldPath;
	if (!chosen || chosen === "/dev/null") {
		return undefined;
	}
	const stripped = chosen.replace(/^([ab])\//, "");
	return stripped === "" ? undefined : stripped;
}

interface ParsedFileResult {
	file: UnifiedDiffFile;
	endIndex: number;
}

/**
 * Try to parse one file segment starting at `start`. Returns null when the
 * candidate does not form a complete diff segment (headers + at least one hunk).
 */
function tryParseFileSegment(lines: readonly string[], start: number): ParsedFileResult | null {
	let i = start;

	if (lines[i]?.startsWith("diff --git ")) {
		i++;
		while (i < lines.length) {
			const line = lines[i];
			if (line.startsWith("--- ")) break;
			if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) return null;
			if (line.startsWith("diff --git ") || HUNK_HEADER.test(line)) return null;
			if (line === "" || GIT_METADATA_LINE.test(line)) {
				i++;
				continue;
			}
			return null;
		}
	}

	const oldLine = lines[i];
	const newLine = lines[i + 1];
	if (oldLine === undefined || !oldLine.startsWith("--- ")) return null;
	if (newLine === undefined || !newLine.startsWith("+++ ")) return null;
	const path = displayPath(oldLine.slice(4), newLine.slice(4));
	if (path === undefined) return null;
	i += 2;

	const specs: DiffLineSpec[] = [];
	let oldNum = 0;
	let newNum = 0;
	let hunkCount = 0;

	while (i < lines.length) {
		const match = HUNK_HEADER.exec(lines[i]);
		if (!match) break;
		oldNum = Number(match[1]);
		newNum = Number(match[3]);
		i++;
		hunkCount++;

		while (i < lines.length) {
			const line = lines[i];
			if (line.startsWith("diff --git ")) break;
			// A later file's header pair is only recognized when a hunk follows,
			// so removed content that itself looks like "--- x" stays body text.
			if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && HUNK_HEADER.test(lines[i + 2] ?? "")) {
				break;
			}
			if (line.startsWith("@@ -") && HUNK_HEADER.test(line)) break;
			if (line.startsWith("\\")) {
				// "\ No newline at end of file"
				i++;
				continue;
			}
			if (line.startsWith("+")) {
				specs.push({ sign: "+", lineNum: newNum++, content: line.slice(1) });
			} else if (line.startsWith("-")) {
				specs.push({ sign: "-", lineNum: oldNum++, content: line.slice(1) });
			} else if (line.startsWith(" ") || line === "") {
				specs.push({ sign: " ", lineNum: oldNum++, content: line.slice(1) });
				newNum++;
			} else {
				// Anything else ends the hunk body; the outer scan re-syncs.
				break;
			}
			i++;
		}
	}

	if (hunkCount === 0 || specs.length === 0) {
		return null;
	}

	const width = Math.max(...specs.map((spec) => String(spec.lineNum).length));
	const diffText = specs
		.map((spec) => `${spec.sign}${String(spec.lineNum).padStart(width, " ")} ${spec.content}`)
		.join("\n");
	const added = specs.filter((spec) => spec.sign === "+").length;
	const removed = specs.filter((spec) => spec.sign === "-").length;

	return { file: { path, diffText, added, removed }, endIndex: i };
}

/** Quick conservative check for diff-shaped output (used before parsing huge outputs). */
function looksLikeUnifiedDiff(lines: readonly string[]): boolean {
	for (let i = 0; i < lines.length; i++) {
		if (!HUNK_HEADER.test(lines[i])) continue;
		for (let j = Math.max(0, i - 20); j < i; j++) {
			if (lines[j].startsWith("--- ") && lines[j + 1]?.startsWith("+++ ")) return true;
		}
	}
	return false;
}

/**
 * Detect and split unified-diff output into per-file blocks interleaved with any
 * plain-text regions around them. Returns undefined when no complete diff
 * segment is found, or `{ tooLarge: true }` when a detected diff exceeds
 * MAX_UNIFIED_DIFF_LINES (caller falls back to plain rendering with a note).
 */
export function parseUnifiedDiff(text: string): ParsedUnifiedDiff | undefined {
	if (text.trim() === "") return undefined;
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.length > MAX_UNIFIED_DIFF_LINES) {
		return looksLikeUnifiedDiff(lines) ? { blocks: [], files: [], tooLarge: true } : undefined;
	}

	const blocks: ParsedDiffBlock[] = [];
	const files: UnifiedDiffFile[] = [];
	let i = 0;
	let plainStart = 0;

	const flushPlain = (end: number): void => {
		const slice = lines.slice(plainStart, end).join("\n").replace(/\n+$/, "");
		if (slice.trim() !== "") {
			blocks.push({ kind: "text", text: slice });
		}
	};

	while (i < lines.length) {
		const isCandidate = lines[i].startsWith("diff --git ") || lines[i].startsWith("--- ");
		if (!isCandidate) {
			i++;
			continue;
		}
		const parsed = tryParseFileSegment(lines, i);
		if (parsed) {
			flushPlain(i);
			blocks.push({ kind: "diff", file: parsed.file });
			files.push(parsed.file);
			i = parsed.endIndex;
			// Skip blank separators between segments so they don't reopen a plain block.
			while (i < lines.length && lines[i].trim() === "") i++;
			plainStart = i;
		} else {
			i++;
		}
	}
	flushPlain(lines.length);

	if (files.length === 0) return undefined;
	return { blocks, files, tooLarge: false };
}
