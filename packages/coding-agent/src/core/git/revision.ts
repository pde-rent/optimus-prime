import { parseCommit } from "./objects.js";
import { refExists } from "./refs.js";
import type { GitRepository } from "./repository.js";

/**
 * Revision resolution for the shapes agents actually type: HEAD, HEAD~n / ^n, branch and tag
 * names, full and abbreviated object ids. Not general gitrevisions (no ranges, no ":path").
 */
export function resolveRevision(repo: GitRepository, spec: string): string | null {
	let current = spec;
	for (;;) {
		const suffixMatch = /^(.*?)([~^])(\d+)$/.exec(current);
		if (!suffixMatch) break;
		current = suffixMatch[1];
	}
	let sha = resolveBase(repo, current);
	if (sha === null) return null;
	// Apply ~n / ^n suffixes left to right on the original text.
	const rest = spec.slice(current.length);
	for (const [, operator, countText] of rest.matchAll(/([~^])(\d+)/g)) {
		const count = Number(countText);
		for (let i = 0; i < count; i++) {
			const raw = repo.readObject(sha);
			if (raw === null || raw.type !== "commit") return null;
			const commit = parseCommit(raw.body);
			if (commit.parents.length === 0) return null;
			sha = commit.parents[operator === "~" ? 0 : Math.min(count - 1, commit.parents.length - 1)];
			if (operator === "^") break;
		}
	}
	return sha;
}

function resolveBase(repo: GitRepository, name: string): string | null {
	if (/^[0-9a-f]{40}$/.test(name)) return repo.hasObject(name) ? name : null;
	if (name === "HEAD" || refExists(repo.gitDir, `refs/heads/${name}`) || refExists(repo.gitDir, `refs/tags/${name}`)) {
		return repo.resolveRef(name === "HEAD" ? "HEAD" : candidateRefName(repo, name));
	}
	if (/^[0-9a-f]{4,39}$/.test(name)) {
		const found = expandShortSha(repo, name);
		if (found) return found;
	}
	return null;
}

function candidateRefName(repo: GitRepository, name: string): string {
	return refExists(repo.gitDir, `refs/heads/${name}`) ? `refs/heads/${name}` : `refs/tags/${name}`;
}

/** Scan the loose + packed object store for the unique object with this abbreviated sha. */
function expandShortSha(repo: GitRepository, prefix: string): string | null {
	const matches = repo.listObjectIds((id) => id.startsWith(prefix));
	if (matches.length !== 1) return null;
	return matches[0];
}
