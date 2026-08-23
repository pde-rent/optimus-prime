import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffLines } from "../../utils/diff.js";
import type { IndexEntry } from "./index.js";
import { entryStage } from "./index.js";
import {
	type GitTreeEntry,
	parseCommit,
	parseTree,
	serializeTree,
	TREE_MODE_DIR,
	writeLooseObject,
} from "./objects.js";
import type { GitRepository } from "./repository.js";

/**
 * Unified diff for the two agent-facing surfaces: index-vs-worktree ("git diff") and
 * HEAD-vs-index ("git diff --cached"). Line diffs come from the shared Myers implementation
 * in src/utils/diff.ts - reused, not reimplemented (spec §7 fallback path).
 */

export interface DiffOptions {
	contextLines?: number;
	/**
	 * Byte source for blob shas that are not in the object store - diffWorktree
	 * hashes worktree content virtually and feeds those bytes through here.
	 * Defaults to reading the stored blob.
	 */
	readBytes?: (sha: string) => Uint8Array;
}

export interface FileDiff {
	path: string;
	oldMode: string | null;
	newMode: string | null;
	oldSha: string | null;
	newSha: string | null;
	/** Full unified-diff text including the "diff --git" header. One short line for binaries. */
	patch: string;
	binary: boolean;
}

/** NUL byte in the first 8 KiB means binary (isomorphic-git isBinary heuristic, spec §7). */
export function isBinaryContent(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, 8192);
	for (let i = 0; i < head.length; i++) if (head[i] === 0) return true;
	return false;
}

export function blobBytes(repo: GitRepository, sha: string): Uint8Array {
	const raw = repo.readObject(sha);
	if (raw === null || raw.type !== "blob") throw new Error(`not a blob: ${sha}`);
	return raw.body;
}

export interface TreeFile {
	mode: string;
	sha: string;
}

/** Flatten a tree into path -> { mode, sha }. */
export function flatTree(repo: GitRepository, treeSha: string): Map<string, TreeFile> {
	const files = new Map<string, TreeFile>();
	const walk = (sha: string, prefix: string): void => {
		const raw = repo.readObject(sha);
		if (raw === null || raw.type !== "tree") throw new Error(`tree not found: ${sha}`);
		for (const entry of parseTree(raw.body)) {
			const path = prefix + entry.name;
			if (entry.mode === TREE_MODE_DIR) walk(entry.sha, `${path}/`);
			else files.set(path, { mode: entry.mode, sha: entry.sha });
		}
	};
	walk(treeSha, "");
	return files;
}

/** Parse the commit object at `sha`; throws when absent or not a commit. */
export function sameTreeFile(a: TreeFile | null | undefined, b: TreeFile | null | undefined): boolean {
	return a?.sha === b?.sha && a?.mode === b?.mode;
}

/** Parents of a commit; [] for absent or non-commit objects (tolerant history-walk helper). */
export function commitParents(repo: GitRepository, sha: string): string[] {
	const raw = repo.readObject(sha);
	if (raw === null || raw.type !== "commit") return [];
	return parseCommit(raw.body).parents;
}

/** HEAD's flattened tree; empty before the first commit. */
export function headTreeFiles(repo: GitRepository): Map<string, TreeFile> {
	const headTree = repo.headTreeSha();
	return headTree === null ? new Map<string, TreeFile>() : flatTree(repo, headTree);
}

/**
 * Write nested tree objects covering a flat path map (tree sort treats directory
 * names as "/"-suffixed); returns the root tree sha.
 */
export function writeTreeFromFiles(repo: GitRepository, files: Map<string, TreeFile>): string {
	const build = (prefix: string): string => {
		const direct: GitTreeEntry[] = [];
		const dirs = new Map<string, Map<string, TreeFile>>();
		for (const [path, file] of files) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) direct.push({ mode: file.mode, name: rest, sha: file.sha });
			else {
				const name = rest.slice(0, slash);
				if (!dirs.has(name)) dirs.set(name, new Map());
				dirs.get(name)?.set(path, file);
			}
		}
		for (const [name] of dirs) {
			direct.push({ mode: TREE_MODE_DIR, name, sha: build(`${prefix + name}/`) });
		}
		direct.sort(compareTreeEntries);
		return writeLooseObject(repo.gitDir, "tree", serializeTree(direct));
	};
	return build("");
}

function compareTreeEntries(a: GitTreeEntry, b: GitTreeEntry): number {
	const aKey = a.mode === TREE_MODE_DIR ? `${a.name}/` : a.name;
	const bKey = b.mode === TREE_MODE_DIR ? `${b.name}/` : b.name;
	return Buffer.compare(Buffer.from(aKey), Buffer.from(bKey));
}

/** Index contents as path -> { mode, sha } over stage-0 entries only. */
export function flatIndex(entries: IndexEntry[]): Map<string, TreeFile> {
	const files = new Map<string, TreeFile>();
	for (const entry of entries) {
		if (entryStage(entry) === 0) files.set(entry.path, { mode: entry.mode.toString(8), sha: entry.sha });
	}
	return files;
}

/** Worktree files as path -> content bytes (sorted paths; symlinks contribute their target text). */
export function flatWorktree(repo: GitRepository): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	for (const path of repo.listWorktreeFiles()) {
		files.set(path, readWorktreeBytes(repo.workdir, path));
	}
	return files;
}

/** Read file content for hashing/indexing; symlinks contribute their target text. */
export function readWorktreeBytes(workdir: string, relPath: string): Uint8Array {
	const absolute = join(workdir, relPath);
	if (lstatSync(absolute).isSymbolicLink()) {
		return new TextEncoder().encode(readFileSync(absolute, "latin1"));
	}
	return new Uint8Array(readFileSync(absolute));
}

const SHORT_SHA = 7;

function short(sha: string | undefined): string {
	return (sha ?? "0000000000000000000000000000000000000000").slice(0, SHORT_SHA);
}

/** Render one pair of blob snapshots as a git-style unified-diff file section. */
export function renderFileDiff(
	repo: GitRepository,
	path: string,
	before: TreeFile | null,
	after: TreeFile | null,
	options: DiffOptions = {},
): FileDiff {
	const context = options.contextLines ?? 3;
	const read = (file: TreeFile | null): Uint8Array =>
		file === null ? new Uint8Array() : (options.readBytes?.(file.sha) ?? blobBytes(repo, file.sha));
	const oldBytes = read(before);
	const newBytes = read(after);
	const binary = (before !== null && isBinaryContent(oldBytes)) || (after !== null && isBinaryContent(newBytes));
	const meta: string[] = [];
	meta.push(`diff --git a/${path} b/${path}`);
	if (before === null && after !== null) meta.push(`new file mode ${after.mode}`);
	if (before !== null && after === null) meta.push(`deleted file mode ${before.mode}`);
	if (before && after && before.mode !== after.mode) {
		meta.push(`old mode ${before.mode}`);
		meta.push(`new mode ${after.mode}`);
	}
	meta.push(`index ${short(before?.sha)}..${short(after?.sha)}`);
	let patch: string;
	if (binary) {
		patch =
			meta.join("\n") +
			"\nBinary files " +
			(before ? `a/${path}` : "/dev/null") +
			" and " +
			(after ? `b/${path}` : "/dev/null") +
			" differ\n";
	} else {
		meta.push(`--- ${before ? `a/${path}` : "/dev/null"}`);
		meta.push(`+++ ${after ? `b/${path}` : "/dev/null"}`);
		patch = `${meta.join("\n")}\n${buildHunks(decodeLoose(oldBytes), decodeLoose(newBytes), context).join("")}`;
	}
	return {
		path,
		oldMode: before?.mode ?? null,
		newMode: after?.mode ?? null,
		oldSha: before?.sha ?? null,
		newSha: after?.sha ?? null,
		patch,
		binary,
	};
}

function decodeLoose(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

interface DiffLine {
	text: string;
	noNewline: boolean;
}

function toDiffLines(text: string): DiffLine[] {
	if (text === "") return [];
	const parts = text.split("\n");
	const trailing = parts[parts.length - 1] === "";
	if (trailing) parts.pop();
	return parts.map((line, i) => ({
		text: i === parts.length - 1 && !trailing ? line : `${line}\n`,
		noNewline: i === parts.length - 1 && !trailing,
	}));
}

/**
 * Build git-style "@@ -a,b +c,d @@" hunk blocks: changed step regions expanded by
 * `context` lines on each side, merged when the expansions overlap.
 */
export function buildHunks(beforeText: string, afterText: string, context: number): string[] {
	const changes = diffLines(beforeText, afterText);
	const before = toDiffLines(beforeText);
	const after = toDiffLines(afterText);
	type Step = { type: "same" | "del" | "add"; ai?: number; bi?: number };
	const steps: Step[] = [];
	let ai = 0;
	let bi = 0;
	for (const change of changes) {
		for (let i = 0; i < (change.count ?? change.value.length); i++) {
			if (change.added) steps.push({ type: "add", bi: bi++ });
			else if (change.removed) steps.push({ type: "del", ai: ai++ });
			else steps.push({ type: "same", ai: ai++, bi: bi++ });
		}
	}
	const hunks: string[] = [];
	const total = steps.length;
	let s = 0;
	while (s < total && steps[s].type === "same") s++;
	while (s < total) {
		// Region starts at a changed step; extend over same-runs of <= 2*context followed by more changes.
		let e = s;
		for (;;) {
			let gapSame = 0;
			let t = e + 1;
			while (t < total && steps[t].type === "same") {
				gapSame++;
				t++;
			}
			if (t < total && gapSame <= context * 2) e = t;
			else break;
		}
		const startStep = Math.max(0, s - context);
		const endStep = Math.min(total - 1, e + context);
		hunks.push(renderHunk(steps, startStep, endStep, before, after));
		s = e + 1;
		while (s < total && steps[s].type === "same") s++;
	}
	return hunks;
}

function renderHunk(
	steps: Array<{ type: "same" | "del" | "add"; ai?: number; bi?: number }>,
	startStep: number,
	endStep: number,
	before: DiffLine[],
	after: DiffLine[],
): string {
	let aFrom = -1;
	let aTo = -1;
	let bFrom = -1;
	let bTo = -1;
	for (let i = startStep; i <= endStep; i++) {
		const ai = steps[i].ai;
		const bi = steps[i].bi;
		if (ai !== undefined) {
			if (aFrom === -1 || ai < aFrom) aFrom = ai;
			aTo = ai;
		}
		if (bi !== undefined) {
			if (bFrom === -1 || bi < bFrom) bFrom = bi;
			bTo = bi;
		}
	}
	const aCount = aFrom === -1 ? 0 : aTo - aFrom + 1;
	const bCount = bFrom === -1 ? 0 : bTo - bFrom + 1;
	// Zero-length sides anchor at the line BEFORE which they sit (1-based next line number).
	const aHeader =
		aCount === 0
			? zeroAnchor(steps, startStep, endStep, "ai", aFrom, aTo)
			: String(aFrom + 1) + (aCount === 1 ? "" : `,${aCount}`);
	const bHeader =
		bCount === 0
			? zeroAnchor(steps, startStep, endStep, "bi", bFrom, bTo)
			: String(bFrom + 1) + (bCount === 1 ? "" : `,${bCount}`);
	const out: string[] = [`@@ -${aHeader} +${bHeader} @@\n`];
	for (let i = startStep; i <= endStep; i++) {
		const step = steps[i];
		if (step.type === "same") emitLine(out, " ", before[step.ai as number]);
		else if (step.type === "del") emitLine(out, "-", before[step.ai as number]);
		else emitLine(out, "+", after[step.bi as number]);
	}
	return out.join("");
}

/**
 * Zero-count hunk side: anchor is the line AFTER which the change sits, 1-based
 * ("0,0" when it sits before the first line). Take it from the region's context,
 * falling back to the nearest neighbouring step that references this side.
 */
function zeroAnchor(
	steps: Array<{ type: "same" | "del" | "add"; ai?: number; bi?: number }>,
	startStep: number,
	endStep: number,
	side: "ai" | "bi",
	fromInRange: number,
	toInRange: number,
): string {
	if (fromInRange !== -1) return `${String(toInRange + 1)},0`;
	for (let i = startStep - 1; i >= 0; i--) {
		const index = steps[i][side];
		if (index !== undefined) return `${String(index + 1)},0`;
	}
	for (let i = endStep + 1; i < steps.length; i++) {
		const index = steps[i][side];
		if (index !== undefined) return `${String(index)},0`;
	}
	return "0,0";
}

function emitLine(out: string[], prefix: string, line: DiffLine): void {
	out.push(prefix + line.text);
	if (line.noNewline) out.push("\\ No newline at end of file\n");
}

/** All files differing between two snapshot maps, sorted by path. */
export function diffSnapshots(
	repo: GitRepository,
	beforeFiles: Map<string, TreeFile>,
	afterFiles: Map<string, TreeFile>,
	options: DiffOptions = {},
): FileDiff[] {
	const paths = new Set<string>([...beforeFiles.keys(), ...afterFiles.keys()]);
	const out: FileDiff[] = [];
	for (const path of [...paths].sort()) {
		const before = beforeFiles.get(path) ?? null;
		const after = afterFiles.get(path) ?? null;
		if (sameTreeFile(before, after)) continue;
		out.push(renderFileDiff(repo, path, before, after, options));
	}
	return out;
}

/** "git diff": index vs worktree (untracked files excluded, like git). */
export function diffWorktree(repo: GitRepository, options: DiffOptions = {}): FileDiff[] {
	const indexed = flatIndex(repo.loadIndex().entries);
	const content = flatWorktree(repo);
	// Deleted paths simply drop out of the after-map, so diffSnapshots renders them.
	const after = new Map<string, TreeFile>();
	const worktreeBlobs = new Map<string, Uint8Array>();
	for (const [path, entry] of indexed) {
		const bytes = content.get(path);
		if (bytes === undefined) continue;
		const sha = repo.hashBlob(bytes);
		worktreeBlobs.set(sha, bytes);
		after.set(path, { mode: entry.mode, sha });
	}
	return diffSnapshots(repo, indexed, after, {
		...options,
		readBytes: (sha) => worktreeBlobs.get(sha) ?? blobBytes(repo, sha),
	});
}

/** "git diff --cached": HEAD vs index. */
export function diffStaged(repo: GitRepository, options: DiffOptions = {}): FileDiff[] {
	const headTree = repo.headTreeSha();
	const before = headTree === null ? new Map<string, TreeFile>() : flatTree(repo, headTree);
	const after = flatIndex(repo.loadIndex().entries);
	return diffSnapshots(repo, before, after, options);
}
