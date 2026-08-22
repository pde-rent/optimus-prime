import { join } from "node:path";
import ignoreFactory from "../../utils/ignore-matcher.js";
import { addIgnoreRules } from "../ignore-rules.js";
import { flatTree } from "./diff.js";
import type { IndexEntry } from "./index.js";
import { entryStage } from "./index.js";
import { hardResetTo } from "./merge.js";
import { parseCommit } from "./objects.js";
import type { GitRepository } from "./repository.js";
import { resolveRevision } from "./revision.js";

/**
 * Reset (soft/mixed/hard), single-path unstaging, ls-files listing and gitignore
 * queries (matching reuses the existing shared matcher - no second implementation).
 */

export type ResetMode = "soft" | "mixed" | "hard";

/**
 * git reset [--soft|--mixed|--hard] <target>: move the current ref (never HEAD
 * itself when on a branch), then optionally the index (mixed) and worktree (hard).
 */
export function reset(repo: GitRepository, targetRefish = "HEAD", mode: ResetMode = "mixed"): string {
	const sha = resolveRevision(repo, targetRefish);
	if (sha === null) throw new Error(`unknown revision: ${targetRefish}`);
	repo.updateRef("ORIG_HEAD", repo.headCommitSha() ?? "0000000000000000000000000000000000000000");
	if (mode === "hard") {
		hardResetTo(repo, sha);
		return sha;
	}
	if (mode === "soft") {
		repo.updateRef(repo.headBranch() ?? "HEAD", sha);
		return sha;
	}
	// mixed: index matches the target tree; worktree untouched.
	const treeSha = treeOfCommit(repo, sha);
	const files = flatTree(repo, treeSha);
	const index = repo.loadIndex();
	index.entries = [];
	index.treeExtension = null;
	for (const [path, file] of [...files].sort()) index.add(syntheticEntry(path, file));
	repo.saveIndex(index);
	repo.updateRef(repo.headBranch() ?? "HEAD", sha);
	return sha;
}

/** git restore --staged <path>: take one path's index state back to HEAD (or drop it). */
export function unstagePath(repo: GitRepository, path: string): boolean {
	const headFiles = repo.flatHeadTree() ?? new Map<string, string>();
	const index = repo.loadIndex();
	const removed = index.remove(path);
	if (!headFiles.has(path)) {
		repo.saveIndex(index);
		return removed;
	}
	// HEAD still has it: keep the entry pointing at the HEAD blob so it reads as unstaged-modified.
	index.add(syntheticEntry(path, { mode: modeForHeadEntry(repo, path), sha: headFiles.get(path) as string }));
	repo.saveIndex(index);
	return true;
}

function modeForHeadEntry(repo: GitRepository, path: string): string {
	const treeSha = repo.headTreeSha();
	if (treeSha === null) return "100644";
	return flatTree(repo, treeSha).get(path)?.mode ?? "100644";
}

/** Index entry without worktree stat data (reset does not touch the worktree). */
function syntheticEntry(path: string, file: { mode: string; sha: string }): IndexEntry {
	const byteLength = Buffer.byteLength(path);
	return {
		ctimeSeconds: 0,
		ctimeNanoseconds: 0,
		mtimeSeconds: 0,
		mtimeNanoseconds: 0,
		dev: 0,
		ino: 0,
		mode: Number.parseInt(file.mode, 8),
		uid: 0,
		gid: 0,
		fileSize: 0,
		sha: file.sha,
		flags: Math.min(byteLength, 0xfff),
		extendedFlags: 0,
		path,
	};
}

/** git ls-files: sorted stage-0 index paths. */
export function listFiles(repo: GitRepository): string[] {
	return repo
		.loadIndex()
		.entries.filter((entry) => entryStage(entry) === 0)
		.map((entry) => entry.path)
		.sort();
}

/** True when the worktree-relative path is excluded by .gitignore rules at any level. */
export function isIgnored(repo: GitRepository, relPath: string): boolean {
	const matcher = ignoreFactory();
	const segments = relPath.split("/");
	for (let i = 0; i < segments.length; i++) {
		addIgnoreRules(matcher, join(repo.workdir, ...segments.slice(0, i)), repo.workdir);
	}
	addIgnoreRules(matcher, repo.workdir, repo.workdir);
	return matcher.ignores(relPath);
}

function treeOfCommit(repo: GitRepository, sha: string): string {
	const raw = repo.readObject(sha);
	if (raw === null || raw.type !== "commit") throw new Error(`not a commit: ${sha}`);
	return parseCommit(raw.body).tree;
}
