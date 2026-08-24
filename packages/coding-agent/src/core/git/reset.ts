import { flatTree } from "./diff.js";
import type { IndexEntry } from "./index.js";
import { entryStage } from "./index.js";
import { hardResetTo } from "./merge.js";
import type { GitRepository } from "./repository.js";

/**
 * Reset (soft/mixed/hard), single-path unstaging and ls-files listing.
 */

export type ResetMode = "soft" | "mixed" | "hard";

/**
 * git reset [--soft|--mixed|--hard] <target>: move the current ref (never HEAD
 * itself when on a branch), then optionally the index (mixed) and worktree (hard).
 */
export function reset(repo: GitRepository, targetRefish = "HEAD", mode: ResetMode = "mixed"): string {
	const sha = repo.resolveRevision(targetRefish);
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
	const treeSha = repo.commitTree(sha);
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
