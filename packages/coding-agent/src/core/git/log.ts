import type { GitRepository } from "./repository.js";

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

export interface LogOptions {
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

export function readLogEntry(repo: GitRepository, sha: string): LogEntry {
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

/** git log --oneline line: "<abbreviated-sha> <subject>". */
export function formatOneline(entry: LogEntry, abbrevLength = 7): string {
	return `${entry.sha.slice(0, abbrevLength)} ${entry.subject}`;
}
