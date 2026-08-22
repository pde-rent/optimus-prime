import type { Dirent } from "node:fs";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flatTree, type TreeFile } from "./diff.js";
import { parseCommit, writeLooseObject } from "./objects.js";
import { assertValidRefName, deleteRef, loadPackedRefs, refExists, resolveRef } from "./refs.js";
import type { GitRepository } from "./repository.js";
import { resolveRevision } from "./revision.js";
import { hasLocalEdits, materializeTree } from "./worktree.js";

/**
 * Branch and tag lifecycle plus checkout (HEAD + index + worktree switched together).
 */

export interface RefInfo {
	name: string;
	sha: string | null;
	current: boolean;
}

/** All local branches; sha is null only for a symbolic/broken entry. */
export function listBranches(repo: GitRepository): RefInfo[] {
	const current = repo.headBranch();
	const names = collectRefNames(repo.gitDir, "refs/heads");
	return names.map((name) => ({
		name,
		sha: resolveRef(repo.gitDir, name),
		current: current === name,
	}));
}

export function listTags(repo: GitRepository): RefInfo[] {
	return collectRefNames(repo.gitDir, "refs/tags").map((name) => ({
		name,
		sha: resolveRef(repo.gitDir, name),
		current: false,
	}));
}

function collectRefNames(gitDir: string, prefix: string): string[] {
	const names = new Set<string>(loadPackedRefs(gitDir).keys());
	const base = join(gitDir, ...prefix.split("/"));
	const walk = (dir: string, rel: string): void => {
		let items: Dirent[];
		try {
			items = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			const relName = rel ? `${rel}/${item.name}` : item.name;
			if (item.isDirectory()) walk(join(dir, item.name), relName);
			else names.add(`${prefix}/${relName}`);
		}
	};
	walk(base, "");
	return [...names].filter((name) => name.startsWith(`${prefix}/`)).sort();
}

export function createBranch(repo: GitRepository, name: string, startPoint = "HEAD"): string {
	const refName = `refs/heads/${name}`;
	assertValidRefName(refName);
	if (refExists(repo.gitDir, refName)) throw new Error(`branch already exists: ${name}`);
	const sha = resolveRevision(repo, startPoint);
	if (sha === null) throw new Error(`unknown revision: ${startPoint}`);
	repo.updateRef(refName, sha);
	return sha;
}

export function deleteBranch(repo: GitRepository, name: string): boolean {
	const refName = `refs/heads/${name}`;
	if (repo.headBranch() === refName) throw new Error(`cannot delete the current branch: ${name}`);
	return deleteRef(repo.gitDir, refName);
}

export interface CreateTagOptions {
	message?: string;
	tagger?: { name: string; email: string };
}

/** Create a lightweight tag, or an annotated one when a message is given. Returns the ref target. */
export function createTag(
	repo: GitRepository,
	name: string,
	startPoint = "HEAD",
	options: CreateTagOptions = {},
): string {
	const refName = `refs/tags/${name}`;
	assertValidRefName(refName);
	if (refExists(repo.gitDir, refName)) throw new Error(`tag already exists: ${name}`);
	const sha = resolveRevision(repo, startPoint);
	if (sha === null) throw new Error(`unknown revision: ${startPoint}`);
	if (options.message !== undefined) {
		const config = repo.config();
		const tagger = options.tagger ?? {
			name: config.get("user.name") ?? "BTR Git Client",
			email: config.get("user.email") ?? "git@btr.local",
		};
		const message = options.message.endsWith("\n") ? options.message : `${options.message}\n`;
		const body =
			"object " +
			sha +
			"\ntype commit\ntag " +
			name +
			"\ntagger " +
			tagger.name +
			" <" +
			tagger.email +
			"> " +
			Math.floor(Date.now() / 1000) +
			" +0000\n\n" +
			message;
		const tagSha = writeLooseObject(repo.gitDir, "tag", new TextEncoder().encode(body));
		repo.updateRef(refName, tagSha);
		return tagSha;
	}
	repo.updateRef(refName, sha);
	return sha;
}

export function deleteTag(repo: GitRepository, name: string): boolean {
	return deleteRef(repo.gitDir, `refs/tags/${name}`);
}

/**
 * git checkout <target>: switch HEAD to a branch (symbolic when the name matches a
 * local branch) or detach at the resolved commit. Worktree and index follow; local
 * edits on paths the switch touches are refused.
 */
export function checkout(repo: GitRepository, targetRefish: string): { sha: string; branch: string | null } {
	const sha = resolveRevision(repo, targetRefish);
	if (sha === null) throw new Error(`unknown revision: ${targetRefish}`);
	const branchRef = refExists(repo.gitDir, `refs/heads/${targetRefish}`) ? `refs/heads/${targetRefish}` : null;
	const headTree = repo.headTreeSha();
	const before = headTree === null ? new Map<string, TreeFile>() : flatTree(repo, headTree);
	const after = flatTree(repo, treeOfCommit(repo, sha));
	const changedPaths = new Set<string>();
	for (const path of new Set<string>([...before.keys(), ...after.keys()])) {
		const oldFile = before.get(path);
		const newFile = after.get(path);
		if (oldFile?.sha !== newFile?.sha || oldFile?.mode !== newFile?.mode) changedPaths.add(path);
	}
	if (hasLocalEdits(repo, changedPaths)) {
		throw new Error("Your local changes to the following files would be overwritten by checkout");
	}
	materializeTree(repo, sha); // reads the OLD head tree as its baseline, so run before moving HEAD
	writeFileSync(join(repo.gitDir, "HEAD"), branchRef === null ? `${sha}\n` : `ref: ${branchRef}\n`);
	return { sha, branch: branchRef };
}

function treeOfCommit(repo: GitRepository, sha: string): string {
	const raw = repo.readObject(sha);
	if (raw === null || raw.type !== "commit") throw new Error(`not a commit: ${sha}`);
	return parseCommit(raw.body).tree;
}
