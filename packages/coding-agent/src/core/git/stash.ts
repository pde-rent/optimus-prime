import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TreeFile } from "./diff.js";
import { flatIndex, flatTree, flatWorktree } from "./diff.js";
import { mergeTrees } from "./merge.js";
import { parseCommit, serializeTree, TREE_MODE_DIR, writeLooseObject } from "./objects.js";
import { deleteRef, writeRef } from "./refs.js";
import type { GitRepository } from "./repository.js";
import { applyTreeChanges, writeBlobToWorktree } from "./worktree.js";

/**
 * Stash: the refs/stash stack. Each entry is a worktree commit W with parents
 * [index commit I, base commit B], matching git's shape so real git can read
 * what we write and vice versa. pop = apply + drop.
 */

const STASH_REF = "refs/stash";
const STASH_LOG = join("logs", "refs", "stash");
const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface StashEntry {
	sha: string;
	/** Reflog message ("WIP on main: abc1234 subject" or a custom one). */
	message: string;
}

function stashIdentity(repo: GitRepository): { name: string; email: string; time: number; timezoneOffset: string } {
	const config = repo.config();
	return {
		name: config.get("user.name") ?? "BTR Git Client",
		email: config.get("user.email") ?? "git@btr.local",
		time: Math.floor(Date.now() / 1000),
		timezoneOffset: "+0000",
	};
}

function identLine(identity: { name: string; email: string; time: number; timezoneOffset: string }): string {
	return `${identity.name} <${identity.email}> ${identity.time} ${identity.timezoneOffset}`;
}

function serializeStashCommit(options: {
	tree: string;
	parents: string[];
	message: string;
	identity: ReturnType<typeof stashIdentity>;
}): Uint8Array {
	const ident = identLine(options.identity);
	const lines = [`tree ${options.tree}`];
	for (const parent of options.parents) lines.push(`parent ${parent}`);
	lines.push(`author ${ident}`, `committer ${ident}`);
	const message = options.message.endsWith("\n") ? options.message : `${options.message}\n`;
	return new TextEncoder().encode(`${lines.join("\n")}\n\n${message}`);
}

/** Build tree objects for an arbitrary flat path map (used for the worktree snapshot). */
export function writeTreeFromFiles(repo: GitRepository, files: Map<string, TreeFile>): string {
	const build = (prefix: string): string => {
		const direct: Array<{ mode: string; name: string; sha: string }> = [];
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
		direct.sort((a, b) => {
			const keyA = a.mode === TREE_MODE_DIR ? `${a.name}/` : a.name;
			const keyB = b.mode === TREE_MODE_DIR ? `${b.name}/` : b.name;
			return Buffer.compare(Buffer.from(keyA), Buffer.from(keyB));
		});
		return writeLooseObject(repo.gitDir, "tree", serializeTree(direct));
	};
	return build("");
}

function headSubject(repo: GitRepository): string {
	const head = repo.headCommitSha();
	if (head === null) return "(no commits yet)";
	const raw = repo.readObject(head);
	if (raw === null || raw.type !== "commit") return "";
	return (parseCommit(raw.body).message.split("\n")[0] ?? "").trim();
}

/** git stash push: save worktree+index as a stack entry, then restore HEAD state. */
export function stashPush(repo: GitRepository, options: { message?: string } = {}): string {
	const head = repo.headCommitSha();
	if (head === null) throw new Error("stash needs at least one commit on HEAD");
	const branch = repo.headBranch()?.replace("refs/heads/", "") ?? "(no branch)";
	const shortHead = head.slice(0, 7);
	const subject = headSubject(repo);
	const indexTree = repo.writeTreeFromIndex();
	// Worktree snapshot over tracked paths only (untracked files stay put, like default git).
	const trackedPaths = new Set(flatIndex(repo.loadIndex().entries).keys());
	const content = flatWorktree(repo);
	const worktreeMap = new Map<string, TreeFile>();
	for (const path of trackedPaths) {
		const bytes = content.get(path);
		if (bytes === undefined) continue; // deleted in worktree
		worktreeMap.set(path, { mode: modeOf(repo, path), sha: repo.hashBlob(bytes) });
	}
	const worktreeTree = writeTreeFromFiles(repo, worktreeMap);
	const identity = stashIdentity(repo);
	const indexSha = writeLooseObject(
		repo.gitDir,
		"commit",
		serializeStashCommit({
			tree: indexTree,
			parents: [head],
			message: `index on ${branch}: ${shortHead} ${subject}`,
			identity,
		}),
	);
	const customMessage = options.message
		? `On ${branch}: ${options.message}`
		: `WIP on ${branch}: ${shortHead} ${subject}`;
	const stashSha = writeLooseObject(
		repo.gitDir,
		"commit",
		serializeStashCommit({
			tree: worktreeTree,
			parents: [indexSha, head],
			message: customMessage,
			identity,
		}),
	);
	appendStashReflog(repo, stashSha, customMessage);
	writeRef(repo.gitDir, STASH_REF, stashSha);
	// Restore HEAD state across tracked paths (worktree AND index), like git stash.
	const before = new Map<string, TreeFile>();
	for (const path of trackedPaths) {
		if (worktreeMap.has(path)) before.set(path, worktreeMap.get(path) as TreeFile);
	}
	const headTree = repo.headTreeSha();
	const target = headTree === null ? new Map<string, TreeFile>() : flatTree(repo, headTree);
	const index = repo.loadIndex();
	applyTreeChanges(repo, before, target, index);
	index.entries = [];
	for (const [path, file] of [...target].sort()) index.add(repo.makeIndexEntry(path, file.sha));
	repo.saveIndex(index);
	return stashSha;
}

function modeOf(repo: GitRepository, relPath: string): string {
	try {
		const stats = lstatSafe(join(repo.workdir, relPath));
		if (stats?.isSymbolicLink()) return "120000";
		if (stats?.isFile() && Number(stats.mode) & 0o100) return "100755";
	} catch {
		// fall through
	}
	return "100644";
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function appendStashReflog(repo: GitRepository, newSha: string, message: string): void {
	const logPath = join(repo.gitDir, STASH_LOG);
	mkdirSync(dirname(logPath), { recursive: true });
	const old = readRawStashTip(repo);
	const line = `${old} ${newSha} ${identLine(stashIdentity(repo))}\t${message}\n`;
	writeFileSync(logPath, readTextIfExists(logPath) + line);
}

function readRawStashTip(repo: GitRepository): string {
	return repo.resolveRef(STASH_REF) ?? ZERO_SHA;
}

function readTextIfExists(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Newest-first stack listing, mirroring git stash list order. */
export function stashList(repo: GitRepository): StashEntry[] {
	const text = readTextIfExists(join(repo.gitDir, STASH_LOG));
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf("\t");
			const parts = line.slice(0, tab).split(" ");
			return { sha: parts[1] ?? "", message: line.slice(tab + 1) };
		})
		.reverse();
}

export interface StashApplyResult {
	conflicts: string[];
}

/** git stash apply [--index ignored]: three-way merge of the entry onto current HEAD/worktree. */
export function stashApply(repo: GitRepository, nth = 0): StashApplyResult {
	const entries = stashList(repo);
	const entry = entries[nth];
	if (!entry) throw new Error(`no stash entry ${nth}`);
	const raw = repo.readObject(entry.sha);
	if (raw === null || raw.type !== "commit") throw new Error(`corrupt stash entry: ${entry.sha}`);
	const stashCommit = parseCommit(raw.body);
	const baseSha = stashCommit.parents[1];
	const head = repo.headCommitSha();
	if (head === null) throw new Error("stash apply needs a HEAD commit");
	const baseMap = flatTree(repo, treeOfCommit(repo, baseSha));
	const ourMap = flatTree(repo, treeOfCommit(repo, head));
	const theirMap = flatTree(repo, stashCommit.tree);
	const merged = mergeTrees(repo, baseMap, ourMap, theirMap, "Updated upstream", "Stashed changes");
	const index = repo.loadIndex();
	const touched = applyTreeChanges(repo, ourMap, merged.files, index);
	for (const conflict of merged.conflicts) {
		index.remove(conflict.path);
		for (const [stageText, file] of Object.entries(conflict.stages)) {
			const stageEntry = repo.makeIndexEntry(conflict.path, (file as TreeFile).sha);
			stageEntry.flags = (Buffer.byteLength(conflict.path) & 0xfff) | (Number(stageText) << 12);
			index.add(stageEntry);
		}
		if (conflict.worktree) writeBlobToWorktree(repo, conflict.path, conflict.worktree.sha, conflict.worktree.mode);
		else if (existsSync(join(repo.workdir, conflict.path))) rmSync(join(repo.workdir, conflict.path));
	}
	// git stash apply leaves restored changes UNSTAGED: undo the index side for clean touches.
	const headMap = ourMap;
	for (const path of touched) {
		const headFile = headMap.get(path);
		index.remove(path);
		if (headFile) index.add(repo.makeIndexEntry(path, headFile.sha));
	}
	repo.saveIndex(index);
	return { conflicts: merged.conflicts.map((conflict) => conflict.path) };
}

export function stashPop(repo: GitRepository, nth = 0): StashApplyResult {
	const result = stashApply(repo, nth);
	if (result.conflicts.length > 0) return result; // git keeps the entry when conflicts remain
	stashDrop(repo, nth);
	return result;
}

/** Remove entry n from the stack (rewrites refs/stash and its reflog). */
export function stashDrop(repo: GitRepository, nth = 0): boolean {
	const entries = stashList(repo);
	if (!entries[nth]) throw new Error(`no stash entry ${nth}`);
	entries.splice(nth, 1);
	const logPath = join(repo.gitDir, STASH_LOG);
	const lines = readTextIfExists(logPath).split("\n").filter(Boolean);
	// reflog is oldest-first on disk; drop the corresponding (n-th from the end) line.
	lines.splice(lines.length - 1 - nth, 1);
	if (entries.length === 0) {
		deleteRef(repo.gitDir, STASH_REF);
		rmSync(logPath, { force: true });
		return true;
	}
	const newTip = entries[0].sha;
	writeRef(repo.gitDir, STASH_REF, newTip);
	writeFileSync(logPath, `${lines.join("\n")}\n`);
	return true;
}

// -- tiny local aliases so the flow above stays readable --

function treeOfCommit(repo: GitRepository, sha: string): string {
	const raw = repo.readObject(sha);
	if (raw === null || raw.type !== "commit") throw new Error(`not a commit: ${sha}`);
	return parseCommit(raw.body).tree;
}
