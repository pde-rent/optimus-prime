import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffLines } from "../../utils/diff.js";
import { blobBytes, commitParents, flatTree, headTreeFiles, type TreeFile } from "./diff.js";
import type { GitIndex, IndexEntry } from "./index.js";
import { entryStage } from "./index.js";
import { parentsOf, parseCommit, serializeCommitMessage, writeLooseObject, ZERO_SHA } from "./objects.js";
import type { GitRepository } from "./repository.js";
import { applyTreeChanges, assertNoLocalEdits, materializeTree, writeBlobToWorktree } from "./worktree.js";

/**
 * Merge family (spec §8): merge-base finding, optional recursive virtual base,
 * per-path three-way tree merge, diff3-style content merge with 7-char markers,
 * plus the agent-facing commands built on it: merge (fast-forward / three-way /
 * MERGE_HEAD flow), cherry-pick, revert, findMergeBase.
 */

// ---------------------------------------------------------------------------
// History queries
// ---------------------------------------------------------------------------

/** All commits reachable from sha (inclusive). */
export function allAncestors(repo: GitRepository, sha: string): Set<string> {
	const out = new Set<string>();
	const queue = [sha];
	while (queue.length > 0) {
		const current = queue.pop() as string;
		if (out.has(current)) continue;
		out.add(current);
		queue.push(...commitParents(repo, current));
	}
	return out;
}

export function isAncestor(repo: GitRepository, ancestorSha: string, descendantSha: string): boolean {
	return ancestorSha === descendantSha || allAncestors(repo, descendantSha).has(ancestorSha);
}

// ---------------------------------------------------------------------------
// Commit history walk (git-log subset): topological order by descending commit
// time, --max-count / --since / --until filters, --oneline rendering.
// ---------------------------------------------------------------------------

/**
 * Commit history walk (git-log subset): first-parent-free topological order by descending commit
 * time like default git log, with --max-count / --since / --until filters and --oneline rendering.
 */
export interface LogEntry {
	sha: string;
	parents: string[];
	tree: string;
	authorName: string;
	authorEmail: string;
	authorTime: number;
	committerTime: number;
	/** First line of the message. */
	subject: string;
	message: string;
}

interface LogOptions {
	maxCount?: number;
	/** Committer time >= since (unix seconds), inclusive — matches git --since semantics closely enough for linear walks. */
	since?: number;
	/** Committer time <= until, inclusive. */
	until?: number;
	/** Walk only this starting point instead of HEAD. */
	from?: string;
}

export function logCommits(repo: GitRepository, options: LogOptions = {}): LogEntry[] {
	const start = options.from ?? repo.headCommitSha();
	if (start === null) return [];
	const seen = new Set<string>();
	const out: LogEntry[] = [];
	// Priority queue by committer time keeps the output equal to git log for normal histories.
	const pending: Array<{ sha: string; time: number }> = [{ sha: start, time: commitTime(repo, start) }];
	while (pending.length > 0) {
		pending.sort((a, b) => b.time - a.time);
		const { sha, time } = pending.shift() as { sha: string; time: number };
		if (seen.has(sha)) continue;
		seen.add(sha);
		if (options.until !== undefined && time > options.until) continue; // too new: skip but keep walking parents? no—ancestors are older only in practice; still walk
		if (options.since !== undefined && time < options.since)
			continue; // too old: prune the walk here
		else {
			const entry = readLogEntry(repo, sha);
			out.push(entry);
			if (options.maxCount !== undefined && out.length >= options.maxCount) break;
			for (const parent of entry.parents) pending.push({ sha: parent, time: commitTime(repo, parent) });
		}
		if (options.maxCount !== undefined && out.length >= options.maxCount) break;
	}
	return out;
}

function commitTime(repo: GitRepository, sha: string): number {
	return readLogEntry(repo, sha).committerTime;
}

function readLogEntry(repo: GitRepository, sha: string): LogEntry {
	const commit = repo.parseCommitAt(sha);
	return {
		sha,
		parents: commit.parents,
		tree: commit.tree,
		authorName: commit.author.name,
		authorEmail: commit.author.email,
		authorTime: commit.author.time,
		committerTime: commit.committer.time,
		subject: commit.message.split("\n")[0] ?? "",
		message: commit.message,
	};
}

/**
 * Maximal common ancestors (git merge-base semantics): the common ancestors that no
 * other common ancestor reaches. Every ancestor of a common commit is itself common,
 * so one dominated-marking pass over parent edges suffices.
 */
function findMergeBases(repo: GitRepository, aSha: string, bSha: string): string[] {
	const inA = allAncestors(repo, aSha);
	const inB = allAncestors(repo, bSha);
	const commonSet = new Set<string>();
	for (const sha of inA) if (inB.has(sha)) commonSet.add(sha);
	const dominated = new Set<string>();
	const markDominated = (sha: string): void => {
		if (dominated.has(sha)) return;
		dominated.add(sha);
		for (const parent of parentsOf(repo, sha)) markDominated(parent);
	};
	for (const sha of commonSet) {
		for (const parent of parentsOf(repo, sha)) markDominated(parent);
	}
	return [...commonSet].filter((sha) => !dominated.has(sha)).sort();
}

// ---------------------------------------------------------------------------
// Content merge (diff3-style, 7-char markers, spec §8)
// ---------------------------------------------------------------------------

interface ContentMergeResult {
	content: string;
	clean: boolean;
}

/** Old line i -> new line j for identical lines, derived from the shared Myers diff. */
function lineMap(oldText: string, newText: string): Array<number | null> {
	const map: Array<number | null> = [];
	let oi = 0;
	let ni = 0;
	const changes = diffLines(oldText, newText);
	for (const change of changes) {
		const count = change.count ?? 0;
		if (change.added) ni += count;
		else if (change.removed) oi += count;
		else {
			for (let k = 0; k < count; k++) map[oi + k] = ni + k;
			oi += count;
			ni += count;
		}
	}
	return map;
}

function splitKeepNewline(text: string): string[] {
	if (text === "") return [];
	const parts = text.split("\n");
	const trailing = parts[parts.length - 1] === "";
	if (trailing) parts.pop();
	return parts.map((line, i) => (i === parts.length - 1 && !trailing ? line : `${line}\n`));
}

const joinSlice = (lines: string[]): string => lines.join("");

/**
 * Three-way line merge. Non-conflicting hunks interleave cleanly; conflicting regions
 * become "<<<<<<< ourLabel / ours / ======= / theirs / >>>>>>> theirLabel" blocks.
 */
function mergeFileContent(
	baseText: string,
	ourText: string,
	theirText: string,
	ourLabel: string,
	theirLabel: string,
): ContentMergeResult {
	const base = splitKeepNewline(baseText);
	const ours = splitKeepNewline(ourText);
	const theirs = splitKeepNewline(theirText);
	const out: string[] = [];
	let clean = true;
	// Append lines, inserting a newline first when the buffer would otherwise run a
	// marker or new content into a final line that has no newline of its own.
	const emit = (lines: string[]): void => {
		for (const line of lines) {
			if (out.length > 0 && !out[out.length - 1].endsWith("\n") && !line.endsWith("\n")) out.push("\n");
			out.push(line);
		}
	};
	const emitConflict = (ourLines: string[], theirLines: string[]): void => {
		clean = false;
		emit([`<<<<<<< ${ourLabel}\n`]);
		emit(ourLines);
		emit(["=======\n"]);
		emit(theirLines);
		emit([`>>>>>>> ${theirLabel}\n`]);
	};
	const baseCount = base.length;
	const toOurs = lineMap(baseText, ourText);
	const toTheirs = lineMap(baseText, theirText);
	if (baseCount === 0) {
		// No common ancestor content: identical sides merge; anything else conflicts whole-file.
		if (joinSlice(ours) === joinSlice(theirs)) emit(ours);
		else if (ourText === "") emit(theirs);
		else if (theirText === "") emit(ours);
		else emitConflict(ours, theirs);
		return { content: out.join(""), clean };
	}
	let i = 0;
	while (i < baseCount) {
		if (toOurs[i] !== null && toTheirs[i] !== null) {
			emit([base[i]]);
			i++;
			continue;
		}
		// One unstable chunk [i, j) of base, with the corresponding ranges on each side.
		let j = i + 1;
		while (j < baseCount && !(toOurs[j] !== null && toTheirs[j] !== null)) j++;
		const ourStart = i === 0 ? 0 : (toOurs[i - 1] as number) + 1;
		const ourEnd = j === baseCount ? ours.length : (toOurs[j] as number);
		const theirStart = i === 0 ? 0 : (toTheirs[i - 1] as number) + 1;
		const theirEnd = j === baseCount ? theirs.length : (toTheirs[j] as number);
		const ourSlice = ours.slice(ourStart, ourEnd);
		const theirSlice = theirs.slice(theirStart, theirEnd);
		const baseSlice = base.slice(i, j);
		if (joinSlice(ourSlice) === joinSlice(theirSlice)) emit(ourSlice);
		else if (joinSlice(ourSlice) === joinSlice(baseSlice)) emit(theirSlice);
		else if (joinSlice(theirSlice) === joinSlice(baseSlice)) emit(ourSlice);
		else emitConflict(ourSlice, theirSlice);
		i = j;
	}
	return { content: out.join(""), clean };
}

// ---------------------------------------------------------------------------
// Tree merge
// ---------------------------------------------------------------------------

const BLOB_MODES = new Set(["100644", "100755"]);

interface PathConflict {
	path: string;
	/** Present stages keyed 1 (base), 2 (ours), 3 (theirs). */
	stages: Partial<Record<1 | 2 | 3, TreeFile>>;
	/** Content written into the worktree for this path (ours when it exists, else theirs). */
	worktree: TreeFile | null;
}

interface TreeMergeResult {
	/** Clean per-path outcomes (including content-merged blobs), keyed by path. */
	files: Map<string, TreeFile>;
	conflicts: PathConflict[];
	clean: boolean;
}

/**
 * Per-path three-way merge on (mode, sha) triples. Both-sides-blob divergences go
 * through mergeFileContent; everything else (modify/delete, mode clashes, symlinks,
 * gitlinks) conflicts outright per spec §8.
 */
/** Conflict stages keyed 1 (base), 2 (ours), 3 (theirs), keeping only present sides. */
function stageTriplet(
	baseEntry: TreeFile | null,
	ourEntry: TreeFile | null,
	theirEntry: TreeFile | null,
): Partial<Record<1 | 2 | 3, TreeFile>> {
	const stages: Partial<Record<1 | 2 | 3, TreeFile>> = {};
	if (baseEntry) stages[1] = baseEntry;
	if (ourEntry) stages[2] = ourEntry;
	if (theirEntry) stages[3] = theirEntry;
	return stages;
}

export function mergeTrees(
	repo: GitRepository,
	baseMap: Map<string, TreeFile>,
	ourMap: Map<string, TreeFile>,
	theirMap: Map<string, TreeFile>,
	ourLabel: string,
	theirLabel: string,
): TreeMergeResult {
	const files = new Map<string, TreeFile>();
	const conflicts: PathConflict[] = [];
	const paths = new Set<string>([...baseMap.keys(), ...ourMap.keys(), ...theirMap.keys()]);
	for (const path of [...paths].sort()) {
		const baseEntry = baseMap.get(path) ?? null;
		const ourEntry = ourMap.get(path) ?? null;
		const theirEntry = theirMap.get(path) ?? null;
		const sameEntry = (a: TreeFile | null, b: TreeFile | null): boolean => a?.sha === b?.sha && a?.mode === b?.mode;
		if (sameEntry(ourEntry, theirEntry)) {
			if (ourEntry) files.set(path, ourEntry);
			continue;
		}
		if (sameEntry(baseEntry, ourEntry)) {
			if (theirEntry) files.set(path, theirEntry);
			continue;
		}
		if (sameEntry(baseEntry, theirEntry)) {
			if (ourEntry) files.set(path, ourEntry);
			continue;
		}
		if (
			ourEntry !== null &&
			theirEntry !== null &&
			BLOB_MODES.has(ourEntry.mode) &&
			BLOB_MODES.has(theirEntry.mode)
		) {
			const baseText = baseEntry ? new TextDecoder().decode(blobBytes(repo, baseEntry.sha)) : "";
			const ourText = new TextDecoder().decode(blobBytes(repo, ourEntry.sha));
			const theirText = new TextDecoder().decode(blobBytes(repo, theirEntry.sha));
			const merged = mergeFileContent(baseText, ourText, theirText, ourLabel, theirLabel);
			const mode = ourEntry.mode === theirEntry.mode ? ourEntry.mode : (baseEntry?.mode ?? ourEntry.mode);
			const mergedSha = writeLooseObject(repo.gitDir, "blob", new TextEncoder().encode(merged.content));
			if (merged.clean) {
				files.set(path, { mode, sha: mergedSha });
			} else {
				conflicts.push({
					path,
					stages: stageTriplet(baseEntry, ourEntry, theirEntry),
					worktree: { mode, sha: mergedSha },
				});
			}
			continue;
		}
		// Structural conflict: modify/delete, mode clash, symlink or gitlink divergence.
		conflicts.push({ path, stages: stageTriplet(baseEntry, ourEntry, theirEntry), worktree: ourEntry ?? theirEntry });
	}
	return { files, conflicts, clean: conflicts.length === 0 };
}

/**
 * Recursive base simplification (spec §8): multiple merge bases are merged pairwise
 * into a virtual base tree; recursion is capped and degrades to the first base.
 * Returns a flat path map; virtual trees are hashed in memory only.
 */
function virtualBaseTree(repo: GitRepository, bases: string[], depth = 0): Map<string, TreeFile> {
	if (bases.length === 0) return new Map();
	if (bases.length === 1 || depth >= 8) return flatTree(repo, repo.commitTree(bases[0]));
	const current = flatTree(repo, repo.commitTree(bases[0]));
	for (let i = 1; i < bases.length; i++) {
		const next = flatTree(repo, repo.commitTree(bases[i]));
		const merged = mergeTrees(
			repo,
			virtualBaseTree(repo, findMergeBases(repo, bases[0], bases[i]), depth + 1),
			current,
			next,
			"base",
			"base",
		);
		// Virtual bases resolve conflicts by taking the first side (git degrades similarly).
		for (const conflict of merged.conflicts) {
			if (conflict.worktree) {
				const sha = writeLooseObject(repo.gitDir, "blob", blobBytes(repo, conflict.worktree.sha));
				current.set(conflict.path, { mode: conflict.worktree.mode, sha });
			}
		}
		for (const [path, file] of merged.files) current.set(path, file);
	}
	return current;
}

// ---------------------------------------------------------------------------
// Commands: merge / fast-forward / conclude / abort / cherry-pick / revert
// ---------------------------------------------------------------------------

type MergeStatus = "up-to-date" | "fast-forward" | "merged" | "conflict";

interface MergeOutcome {
	status: MergeStatus;
	commit: string | null;
	conflicts: string[];
}

interface MergeOptions {
	allowUnrelatedHistories?: boolean;
	/** Committer identity used when a merge commit is written. */
	committer?: { name: string; email: string };
	message?: string;
}

function gitDirFile(repo: GitRepository, name: string): string {
	return join(repo.gitDir, name);
}

function setOrigHead(repo: GitRepository, sha: string): void {
	writeFileSync(gitDirFile(repo, "ORIG_HEAD"), `${sha}\n`);
}

function defaultMergeMessage(repo: GitRepository, theirsRefish: string): string {
	const branch = repo.headBranch();
	const sourceName = theirsRefish.startsWith("refs/heads/") ? theirsRefish.slice("refs/heads/".length) : theirsRefish;
	return branch === null ? `Merge commit '${sourceName}'` : `Merge branch '${sourceName}'`;
}

export function committerNow(
	repo: GitRepository,
	options?: { committer?: { name: string; email: string } },
): { name: string; email: string } {
	if (options?.committer) return options.committer;
	const config = repo.config();
	return {
		name: config.get("user.name") ?? "BTR Git Client",
		email: config.get("user.email") ?? "git@btr.local",
	};
}

/** Move the current branch (or detached HEAD) to targetSha and make worktree+index match its tree. */
function fastForward(repo: GitRepository, targetSha: string): void {
	const before = headTreeFiles(repo);
	const after = flatTree(repo, repo.commitTree(targetSha));
	assertNoLocalEdits(repo, [...before.keys(), ...after.keys()], "merge");
	const index = repo.loadIndex();
	applyTreeChanges(repo, before, after, index);
	repo.saveIndex(index);
	repo.updateRef(repo.headBranch() ?? "HEAD", targetSha);
}

/**
 * git-merge equivalent: up-to-date no-op, fast-forward, three-way with auto-commit,
 * or conflict flow leaving MERGE_HEAD/MERGE_MSG and index stages 1/2/3 behind.
 */
export function mergeInto(repo: GitRepository, theirsRefish: string, options: MergeOptions = {}): MergeOutcome {
	if (existsSync(gitDirFile(repo, "MERGE_HEAD"))) {
		throw new Error("You have not concluded your merge (MERGE_HEAD exists)");
	}
	const theirs = repo.resolveRevision(theirsRefish);
	if (theirs === null) throw new Error(`unknown revision: ${theirsRefish}`);
	const head = repo.headCommitSha();
	setOrigHead(repo, head ?? ZERO_SHA);
	if (head !== null && isAncestor(repo, theirs, head)) {
		return { status: "up-to-date", commit: null, conflicts: [] };
	}
	if (head === null || isAncestor(repo, head, theirs)) {
		if (head !== null) fastForward(repo, theirs);
		else {
			const index = repo.loadIndex();
			for (const [path, file] of flatTree(repo, repo.commitTree(theirs))) {
				index.add(repo.makeIndexEntry(path, file.sha));
			}
			repo.saveIndex(index);
			repo.updateRef(repo.headBranch() ?? "HEAD", theirs);
		}
		return { status: "fast-forward", commit: theirs, conflicts: [] };
	}
	const bases = findMergeBases(repo, head, theirs);
	if (bases.length === 0 && !options.allowUnrelatedHistories) {
		throw new Error("refusing to merge unrelated histories");
	}
	const baseMap = virtualBaseTree(repo, bases);
	const ourMap = flatTree(repo, repo.commitTree(head));
	const theirMap = flatTree(repo, repo.commitTree(theirs));
	const label = theirsRefish.replace(/^refs\/heads\//, "");
	const merged = mergeTrees(repo, baseMap, ourMap, theirMap, "HEAD", label);
	assertNoLocalEdits(repo, [...ourMap.keys(), ...theirMap.keys()], "merge");
	const message = options.message ?? `${defaultMergeMessage(repo, label)}\n`;
	if (merged.clean) {
		const index = repo.loadIndex();
		applyTreeChanges(repo, ourMap, merged.files, index);
		const committer = committerNow(repo, options);
		const sha = writeLooseObject(
			repo.gitDir,
			"commit",
			serializeCommitMessage({
				tree: repo.writeTreeFromIndex(),
				parents: [head, theirs],
				message,
				author: { ...committer, time: Math.floor(Date.now() / 1000), timezoneOffset: "+0000" },
			}),
		);
		repo.updateRef(repo.headBranch() ?? "HEAD", sha);
		repo.saveIndex(index);
		return { status: "merged", commit: sha, conflicts: [] };
	}
	const index = repo.loadIndex();
	applyTreeChanges(repo, ourMap, merged.files, index);
	writeFileSync(gitDirFile(repo, "MERGE_HEAD"), `${theirs}\n`);
	writeFileSync(gitDirFile(repo, "MERGE_MSG"), message);
	landMergeConflicts(repo, index, merged.conflicts);
	repo.saveIndex(index);
	return { status: "conflict", commit: null, conflicts: merged.conflicts.map((conflict) => conflict.path) };
}

/**
 * Record conflicts as index stages 1/2/3 and write ours-or-theirs content into the
 * worktree. Shared by mergeInto / cherry-pick / revert / stash-apply / rebase.
 */
export function landMergeConflicts(repo: GitRepository, index: GitIndex, conflicts: PathConflict[]): void {
	for (const conflict of conflicts) {
		index.remove(conflict.path);
		for (const [stageText, file] of Object.entries(conflict.stages)) {
			index.add(stageEntry(repo, conflict.path, file as TreeFile, Number(stageText)));
		}
		if (conflict.worktree) {
			writeBlobToWorktree(repo, conflict.path, conflict.worktree.sha, conflict.worktree.mode);
		} else if (existsSync(join(repo.workdir, conflict.path))) {
			rmSync(join(repo.workdir, conflict.path));
		}
	}
}

function stageEntry(repo: GitRepository, path: string, file: TreeFile, stage: number): IndexEntry {
	return repo.makeStageIndexEntry(path, file.sha, stage);
}

/** Create the merge commit after conflicts were resolved in the index (git merge --continue). */
export function concludeMerge(
	repo: GitRepository,
	options: { committer?: { name: string; email: string }; message?: string } = {},
): string {
	const mergeHeadPath = gitDirFile(repo, "MERGE_HEAD");
	if (!existsSync(mergeHeadPath)) throw new Error("no merge in progress (MERGE_HEAD missing)");
	const index = repo.loadIndex();
	const unmerged = index.entries.filter((entry) => entryStage(entry) !== 0);
	if (unmerged.length > 0) {
		throw new Error(`unmerged paths remain: ${[...new Set(unmerged.map((entry) => entry.path))].join(", ")}`);
	}
	const theirs = readFileSyncText(mergeHeadPath).trim();
	const head = repo.headCommitSha();
	const committer = committerNow(repo, options);
	const message = options.message ?? readFileSyncText(gitDirFile(repo, "MERGE_MSG"));
	const sha = writeLooseObject(
		repo.gitDir,
		"commit",
		serializeCommitMessage({
			tree: repo.writeTreeFromIndex(),
			parents: [head as string, theirs],
			message,
			author: { ...committer, time: Math.floor(Date.now() / 1000), timezoneOffset: "+0000" },
		}),
	);
	repo.updateRef(repo.headBranch() ?? "HEAD", sha);
	cleanupMergeState(repo);
	return sha;
}

/** git merge --abort: hard reset to ORIG_HEAD (falling back to HEAD) and clear merge state. */
export function abortMerge(repo: GitRepository): void {
	const target = existsSync(gitDirFile(repo, "ORIG_HEAD"))
		? readFileSyncText(gitDirFile(repo, "ORIG_HEAD")).trim()
		: repo.headCommitSha();
	if (target === null || target === ZERO_SHA || !repo.hasObject(target)) {
		cleanupMergeState(repo);
		return;
	}
	hardResetTo(repo, target);
	cleanupMergeState(repo);
}

function cleanupMergeState(repo: GitRepository): void {
	for (const name of ["MERGE_HEAD", "MERGE_MSG"]) {
		const path = gitDirFile(repo, name);
		if (existsSync(path)) rmSync(path);
	}
}

function readFileSyncText(path: string): string {
	return readFileSync(path, "utf8");
}

/** Hard reset helper shared with reset/rebase/abort: point ref at sha, force worktree+index to match. */
export function hardResetTo(repo: GitRepository, sha: string): void {
	materializeTree(repo, repo.commitTree(sha));
	repo.updateRef(repo.headBranch() ?? "HEAD", sha);
}

// ---------------------------------------------------------------------------
// Cherry-pick and revert (single-commit apply through the same merge machinery)
// ---------------------------------------------------------------------------

interface ApplyOutcome {
	status: "applied" | "conflict";
	commit: string | null;
	conflicts: string[];
}

/** git cherry-pick <commit>: replay one commit onto HEAD via three-way tree merge. */
export function cherryPick(
	repo: GitRepository,
	commitSha: string,
	options: { committer?: { name: string; email: string } } = {},
): ApplyOutcome {
	const commitRaw = repo.readObject(commitSha);
	if (commitRaw === null || commitRaw.type !== "commit") throw new Error(`not a commit: ${commitSha}`);
	const commit = parseCommit(commitRaw.body);
	const head = repo.headCommitSha();
	if (head === null) throw new Error("cherry-pick needs a HEAD commit");
	const baseTree = commit.parents.length > 0 ? repo.commitTree(commit.parents[0]) : null;
	const outcome = applyThreeWay(repo, baseTree, repo.commitTree(head), commit.tree, "HEAD", commitSha.slice(0, 7));
	if (outcome.clean) {
		// Author identity and message come from the original commit; committer is us.
		const committer = committerNow(repo, options);
		const sha = writeLooseObject(
			repo.gitDir,
			"commit",
			serializeCommitMessage({
				tree: repo.writeTreeFromIndex(),
				parents: [head],
				message: commit.message,
				author: commit.author,
				committer: { ...committer, time: Math.floor(Date.now() / 1000), timezoneOffset: "+0000" },
			}),
		);
		repo.updateRef(repo.headBranch() ?? "HEAD", sha);
		repo.saveIndex(outcome.index);
		return { status: "applied", commit: sha, conflicts: [] };
	}
	writeFileSync(gitDirFile(repo, "CHERRY_PICK_HEAD"), `${commitSha}\n`);
	writeFileSync(gitDirFile(repo, "MERGE_MSG"), commit.message);
	repo.saveIndex(outcome.index);
	return { status: "conflict", commit: null, conflicts: outcome.conflicts };
}

/** git revert <commit>: inverse-apply one commit (base=commit, theirs=parent). */
export function revert(
	repo: GitRepository,
	commitSha: string,
	options: { committer?: { name: string; email: string } } = {},
): ApplyOutcome {
	const commitRaw = repo.readObject(commitSha);
	if (commitRaw === null || commitRaw.type !== "commit") throw new Error(`not a commit: ${commitSha}`);
	const commit = parseCommit(commitRaw.body);
	const head = repo.headCommitSha();
	if (head === null) throw new Error("revert needs a HEAD commit");
	const parentTree = commit.parents.length > 0 ? repo.commitTree(commit.parents[0]) : null;
	const subject = commit.message.split("\n")[0] ?? "";
	const message = `Revert "${subject}"\n\nThis reverts commit ${commitSha}.\n`;
	const outcome = applyThreeWay(repo, commit.tree, repo.commitTree(head), parentTree, "HEAD", "parent");
	if (outcome.clean) {
		const committer = committerNow(repo, options);
		const sha = writeLooseObject(
			repo.gitDir,
			"commit",
			serializeCommitMessage({
				tree: repo.writeTreeFromIndex(),
				parents: [head],
				message,
				author: commit.author,
				committer: { ...committer, time: Math.floor(Date.now() / 1000), timezoneOffset: "+0000" },
			}),
		);
		repo.updateRef(repo.headBranch() ?? "HEAD", sha);
		repo.saveIndex(outcome.index);
		return { status: "applied", commit: sha, conflicts: [] };
	}
	writeFileSync(gitDirFile(repo, "MERGE_MSG"), message);
	repo.saveIndex(outcome.index);
	return { status: "conflict", commit: null, conflicts: outcome.conflicts };
}

interface ThreeWayOutcome {
	clean: boolean;
	index: ReturnType<GitRepository["loadIndex"]>;
	conflicts: string[];
}

/** Shared plumbing: three-way between tree shas, mutating worktree+index in place. */
function applyThreeWay(
	repo: GitRepository,
	baseTreeSha: string | null,
	ourTreeSha: string,
	theirTreeSha: string | null,
	ourLabel: string,
	theirLabel: string,
): ThreeWayOutcome {
	const baseMap = baseTreeSha === null ? new Map<string, TreeFile>() : flatTree(repo, baseTreeSha);
	const ourMap = flatTree(repo, ourTreeSha);
	const theirMap = theirTreeSha === null ? new Map<string, TreeFile>() : flatTree(repo, theirTreeSha);
	const merged = mergeTrees(repo, baseMap, ourMap, theirMap, ourLabel, theirLabel);
	assertNoLocalEdits(repo, [...ourMap.keys(), ...theirMap.keys()]);
	const index = repo.loadIndex();
	applyTreeChanges(repo, ourMap, merged.files, index);
	landMergeConflicts(repo, index, merged.conflicts);
	return { clean: merged.clean, index, conflicts: merged.conflicts.map((conflict) => conflict.path) };
}
