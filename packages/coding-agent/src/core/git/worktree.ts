import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blobBytes, flatTree, type TreeFile } from "./diff.js";
import type { GitIndex } from "./index.js";
import { hashRawObject } from "./objects.js";
import type { GitRepository } from "./repository.js";

/**
 * Worktree/index materialisation shared by checkout, merge, rebase, revert and stash:
 * apply tree-level changes to disk and to the dircache in one place.
 */

/** True when any of these paths differ between worktree and index (uncommitted local edits). */
export function hasLocalEdits(repo: GitRepository, paths: Iterable<string>): boolean {
	for (const path of paths) {
		const absolute = join(repo.workdir, path);
		if (!existsSync(absolute)) return true;
		const onDisk = new Uint8Array(readFileSync(absolute));
		const entry = repo.loadIndex().get(path);
		if (!entry) continue;
		if (hashRawObject("blob", onDisk) !== entry.sha) return true;
	}
	return false;
}

/** Write one blob into the worktree with its mode (exec bit / symlink honoured). */
export function writeBlobToWorktree(repo: GitRepository, relPath: string, sha: string, mode: string): void {
	const absolute = join(repo.workdir, relPath);
	mkdirSync(dirname(absolute), { recursive: true });
	if (existsSync(absolute)) unlinkSync(absolute);
	if (mode === "120000") {
		symlinkSync(new TextDecoder().decode(blobBytes(repo, sha)), absolute);
		return;
	}
	writeFileSync(absolute, blobBytes(repo, sha), { mode: mode === "100755" ? 0o755 : 0o644 });
}

/**
 * Apply the difference between two tree snapshots to worktree and index.
 * Only touched paths are rewritten. Caller owns saving the index.
 * Returns the sorted list of touched paths.
 */
export function applyTreeChanges(
	repo: GitRepository,
	beforeFiles: Map<string, TreeFile>,
	afterFiles: Map<string, TreeFile>,
	index: GitIndex,
): string[] {
	const paths = new Set<string>([...beforeFiles.keys(), ...afterFiles.keys()]);
	const touched: string[] = [];
	for (const path of [...paths].sort()) {
		const before = beforeFiles.get(path) ?? null;
		const after = afterFiles.get(path) ?? null;
		if (before?.sha === after?.sha && before?.mode === after?.mode) continue;
		touched.push(path);
		const absolute = join(repo.workdir, path);
		if (existsSync(absolute)) {
			const isDir = statSync(absolute).isDirectory();
			// A file replaced by a directory (or vice versa), or a plain removal, clears the old shape.
			if (after === null || isDir !== (after.mode === "40000")) rmSync(absolute, { recursive: true });
		}
		if (after === null) {
			index.remove(path);
			continue;
		}
		writeBlobToWorktree(repo, path, after.sha, after.mode);
		index.add(repo.makeIndexEntry(path, after.sha));
	}
	return touched;
}

/**
 * Make the worktree and index exactly match a tree (full checkout; safety checks are
 * the caller's job). The index is rebuilt from scratch, dropping stale entries.
 */
export function materializeTree(repo: GitRepository, treeSha: string | null): void {
	const target: Map<string, TreeFile> = treeSha === null ? new Map() : flatTree(repo, treeSha);
	const headTreeSha = repo.headTreeSha();
	const current: Map<string, TreeFile> = headTreeSha === null ? new Map() : flatTree(repo, headTreeSha);
	const index = repo.loadIndex();
	applyTreeChanges(repo, current, target, index);
	// Rebuild the index wholesale so entries absent from both trees cannot linger.
	index.entries = [];
	for (const [path, file] of [...target].sort()) {
		index.add(repo.makeIndexEntry(path, file.sha));
	}
	repo.saveIndex(index);
}
