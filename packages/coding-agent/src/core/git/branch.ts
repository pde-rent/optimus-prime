import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flatTree, headTreeFiles, sameTreeFile } from "./diff.js";
import { assertValidRefName, deleteRef, listRefNames, refExists, resolveRef } from "./refs.js";
import type { GitRepository } from "./repository.js";
import { assertNoLocalEdits, materializeTree } from "./worktree.js";

/**
 * Branch and tag lifecycle plus checkout (HEAD + index + worktree switched together).
 */

interface RefInfo {
	name: string;
	sha: string | null;
	current: boolean;
}

/** All local branches; sha is null only for a symbolic/broken entry. */
export function listBranches(repo: GitRepository): RefInfo[] {
	const current = repo.headBranch();
	const names = listRefNames(repo.gitDir, "refs/heads");
	return names.map((name) => ({
		name,
		sha: resolveRef(repo.gitDir, name),
		current: current === name,
	}));
}

export function listTags(repo: GitRepository): RefInfo[] {
	return listRefNames(repo.gitDir, "refs/tags").map((name) => ({
		name,
		sha: resolveRef(repo.gitDir, name),
		current: false,
	}));
}

export function createBranch(repo: GitRepository, name: string, startPoint = "HEAD"): string {
	const refName = `refs/heads/${name}`;
	assertValidRefName(refName);
	if (refExists(repo.gitDir, refName)) throw new Error(`branch already exists: ${name}`);
	const sha = repo.resolveRevision(startPoint);
	if (sha === null) throw new Error(`unknown revision: ${startPoint}`);
	repo.updateRef(refName, sha);
	return sha;
}

export function deleteBranch(repo: GitRepository, name: string): boolean {
	const refName = `refs/heads/${name}`;
	if (repo.headBranch() === refName) throw new Error(`cannot delete the current branch: ${name}`);
	return deleteRef(repo.gitDir, refName);
}

/**
 * git checkout <target>: switch HEAD to a branch (symbolic when the name matches a
 * local branch) or detach at the resolved commit. Worktree and index follow; local
 * edits on paths the switch touches are refused.
 */
export function checkout(repo: GitRepository, targetRefish: string): { sha: string; branch: string | null } {
	const sha = repo.resolveRevision(targetRefish);
	if (sha === null) throw new Error(`unknown revision: ${targetRefish}`);
	const branchRef = refExists(repo.gitDir, `refs/heads/${targetRefish}`) ? `refs/heads/${targetRefish}` : null;
	const before = headTreeFiles(repo);
	const after = flatTree(repo, repo.commitTree(sha));
	const changedPaths = new Set<string>();
	for (const path of new Set<string>([...before.keys(), ...after.keys()])) {
		if (!sameTreeFile(before.get(path), after.get(path))) changedPaths.add(path);
	}
	assertNoLocalEdits(repo, changedPaths, "checkout");
	materializeTree(repo, repo.commitTree(sha)); // reads the OLD head tree as its baseline, so run before moving HEAD
	writeFileSync(join(repo.gitDir, "HEAD"), branchRef === null ? `${sha}\n` : `ref: ${branchRef}\n`);
	return { sha, branch: branchRef };
}
