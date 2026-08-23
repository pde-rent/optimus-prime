import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TreeFile } from "./diff.js";
import { commitParents, flatTree } from "./diff.js";
import { allAncestors, committerNow, hardResetTo, isAncestor, landMergeConflicts, mergeTrees } from "./merge.js";
import { type parseCommit, serializeCommit, writeLooseObject } from "./objects.js";
import type { GitRepository } from "./repository.js";
import { applyTreeChanges, hasLocalEdits } from "./worktree.js";

/**
 * Linear rebase (git rebase <upstream>): replay the first-parent range upstream..HEAD
 * onto upstream using the shared merge machinery. Abort support persists ORIG_HEAD plus
 * a small state file; continue/reword/interactive are out of scope.
 */

const STATE_FILE = "rebase-in-progress";

export type RebaseStatus = "up-to-date" | "fast-forward" | "rebased" | "conflict";

export interface RebaseOutcome {
	status: RebaseStatus;
	commit: string | null;
	/** When stopped mid-replay: the original commit being applied. */
	stoppedAt: string | null;
	conflicts: string[];
}

interface ReplayStep {
	sha: string;
	parents: string[];
	tree: string;
	author: ReturnType<typeof parseCommit>["author"];
	committer: ReturnType<typeof parseCommit>["committer"];
	message: string;
}

/** First-parent commits reachable from head but not from upstream, oldest first. */
function collectReplayRange(repo: GitRepository, head: string, upstreamAncestors: Set<string>): ReplayStep[] {
	const shas: string[] = [];
	let current: string | null = head;
	while (current !== null && !upstreamAncestors.has(current)) {
		shas.push(current);
		current = commitParents(repo, current)[0] ?? null;
	}
	return shas.reverse().map((sha) => describeCommit(repo, sha));
}

function describeCommit(repo: GitRepository, sha: string): ReplayStep {
	const commit = repo.parseCommitAt(sha);
	return {
		sha,
		parents: commit.parents,
		tree: commit.tree,
		author: commit.author,
		committer: commit.committer,
		message: commit.message,
	};
}

function replayCommitter(
	repo: GitRepository,
	options: { committer?: { name: string; email: string } },
): { name: string; email: string; time: number; timezoneOffset: string } {
	return { ...committerNow(repo, options), time: Math.floor(Date.now() / 1000), timezoneOffset: "+0000" };
}

export function rebase(
	repo: GitRepository,
	upstreamRefish: string,
	options: { committer?: { name: string; email: string } } = {},
): RebaseOutcome {
	if (existsSync(join(repo.gitDir, STATE_FILE))) {
		throw new Error("a rebase is already in progress");
	}
	const upstream = repo.resolveRevision(upstreamRefish);
	if (upstream === null) throw new Error(`unknown revision: ${upstreamRefish}`);
	const head = repo.headCommitSha();
	if (head === null) throw new Error("rebase needs a HEAD commit");
	if (isAncestor(repo, upstream, head)) {
		return { status: "up-to-date", commit: head, stoppedAt: null, conflicts: [] };
	}
	if (isAncestor(repo, head, upstream)) {
		hardResetTo(repo, upstream);
		return { status: "fast-forward", commit: upstream, stoppedAt: null, conflicts: [] };
	}
	const replay = collectReplayRange(repo, head, allAncestors(repo, upstream));
	repo.updateRef("ORIG_HEAD", head);
	writeFileSync(join(repo.gitDir, STATE_FILE), JSON.stringify({ origHead: head }));
	let tip = upstream;
	for (const step of replay) {
		const baseTree = step.parents.length > 0 ? repo.commitTree(step.parents[0]) : null;
		const ourMap = flatTree(repo, repo.commitTree(tip));
		const outcome = threeWayApply(repo, baseTree, ourMap, repo.commitTree(step.tree));
		if (!outcome.clean) {
			repo.saveIndex(outcome.index);
			return { status: "conflict", commit: null, stoppedAt: step.sha, conflicts: outcome.conflicts };
		}
		tip = writeLooseObject(
			repo.gitDir,
			"commit",
			serializeCommit({
				tree: repo.writeTreeFromIndex(),
				parents: [tip],
				message: step.message,
				author: step.author,
				committer: replayCommitter(repo, options),
			}),
		);
		repo.saveIndex(outcome.index);
	}
	repo.updateRef(repo.headBranch() ?? "HEAD", tip);
	rmSync(join(repo.gitDir, STATE_FILE), { force: true });
	return { status: "rebased", commit: tip, stoppedAt: null, conflicts: [] };
}

/** git rebase --abort: restore branch, index and worktree from ORIG_HEAD. */
export function abortRebase(repo: GitRepository): boolean {
	const statePath = join(repo.gitDir, STATE_FILE);
	if (!existsSync(statePath)) return false;
	const state = JSON.parse(readFileSync(statePath, "utf8")) as { origHead: string };
	hardResetTo(repo, state.origHead);
	rmSync(statePath, { force: true });
	return true;
}

interface ThreeWayLocal {
	clean: boolean;
	index: ReturnType<GitRepository["loadIndex"]>;
	conflicts: string[];
}

function threeWayApply(
	repo: GitRepository,
	baseTreeSha: string | null,
	ourMap: Map<string, TreeFile>,
	theirTreeSha: string,
): ThreeWayLocal {
	const baseMap = baseTreeSha === null ? new Map<string, TreeFile>() : flatTree(repo, baseTreeSha);
	const theirMap = flatTree(repo, theirTreeSha);
	const paths = new Set<string>([...ourMap.keys(), ...theirMap.keys()]);
	if (hasLocalEdits(repo, paths)) throw new Error("local changes would be overwritten by rebase"); // distinct wording on purpose
	const merged = mergeTrees(repo, baseMap, ourMap, theirMap, "HEAD", "UPSTREAM");
	const index = repo.loadIndex();
	applyTreeChanges(repo, ourMap, merged.files, index);
	landMergeConflicts(repo, index, merged.conflicts);
	return { clean: merged.clean, index, conflicts: merged.conflicts.map((conflict) => conflict.path) };
}
