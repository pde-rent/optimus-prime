import { isAbsolute, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { checkout, createBranch, deleteBranch, listBranches, listTags } from "../../git/branch.js";
import { diffStaged, diffWorktree } from "../../git/diff.js";
import {
	abortMerge,
	cherryPick,
	concludeMerge,
	type LogEntry,
	logCommits,
	mergeInto,
	revert,
} from "../../git/merge.js";
import { abortRebase, rebase } from "../../git/rebase.js";
import {
	cloneRepository,
	type FetchResult,
	fetchRemote,
	type PushResult,
	pullRemote,
	pushRemote,
	remoteAdd,
	remoteList,
	remoteRemove,
} from "../../git/remote.js";
import { GitRepository } from "../../git/repository.js";
import { listFiles, type ResetMode, reset, unstagePath } from "../../git/reset.js";
import { stashApply, stashDrop, stashList, stashPop, stashPush } from "../../git/stash.js";
import { throwIfAborted } from "../abortable.js";
import { resolveToCwd } from "../path-utils.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { clampInt, formatTable } from "./sysutil.js";

// ---------------------------------------------------------------------------
// Op metadata: the permission envelope per op group. The tool as a whole is
// kind "edit" (it can mutate), but permission flows and callers that want a
// finer envelope can consult GIT_OP_GROUPS: read-only groups never touch
// worktree, index or refs.
// ---------------------------------------------------------------------------

export type GitOpGroup = "inspect" | "stage" | "history" | "branch" | "remote";

export interface GitOpInfo {
	op: string;
	group: GitOpGroup;
	readOnly: boolean;
}

export const GIT_OP_GROUPS: Array<{ group: GitOpGroup; readOnly: boolean; ops: string[] }> = [
	{ group: "inspect", readOnly: true, ops: ["status", "log", "diff", "branch.list", "stash.list", "remote.list"] },
	{ group: "stage", readOnly: false, ops: ["add", "commit", "reset", "restore"] },
	{
		group: "history",
		readOnly: false,
		ops: ["merge", "cherry-pick", "revert", "rebase", "stash.push", "stash.apply", "stash.pop", "stash.drop"],
	},
	{ group: "branch", readOnly: false, ops: ["checkout", "branch.create", "branch.delete"] },
	{ group: "remote", readOnly: false, ops: ["clone", "fetch", "pull", "push", "remote.add", "remote.remove"] },
];

const READ_ONLY_OPS = new Set(["status", "log", "diff", "ls-files"]);

function _opReadOnly(op: string): boolean {
	return READ_ONLY_OPS.has(op);
}

// ---------------------------------------------------------------------------
// Schema: TypeBox discriminated union over the top-level "op" literal.
// ---------------------------------------------------------------------------

const branchSchema = Type.Object(
	{
		op: Type.Literal("branch"),
		action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("delete")], {
			description: "list (default) shows local branches; create/delete take name.",
		}),
		name: Type.Optional(Type.String({ description: "Branch name for create/delete." })),
		startPoint: Type.Optional(Type.String({ description: "Revision to create the branch at (default HEAD)." })),
		tags: Type.Optional(Type.Boolean({ description: "list also reports tags (list only, default false)." })),
	},
	{ additionalProperties: false },
);

const stashSchema = Type.Object(
	{
		op: Type.Literal("stash"),
		action: Type.Union(
			[Type.Literal("push"), Type.Literal("pop"), Type.Literal("apply"), Type.Literal("list"), Type.Literal("drop")],
			{ description: "push (default) saves and restores; pop = apply + drop." },
		),
		message: Type.Optional(Type.String({ description: "Custom message for push." })),
		nth: Type.Optional(Type.Number({ description: "Stack index for apply/pop/drop (0 = newest, default 0)." })),
	},
	{ additionalProperties: false },
);

const remoteSchema = Type.Object(
	{
		op: Type.Literal("remote"),
		action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")], {
			description: "list (default) shows configured remotes.",
		}),
		name: Type.Optional(Type.String({ description: "Remote name for add/remove." })),
		url: Type.Optional(Type.String({ description: "http(s) URL for add - the transport is smart HTTP only." })),
	},
	{ additionalProperties: false },
);

const gitSchema = Type.Union([
	Type.Object({ op: Type.Literal("status") }, { additionalProperties: false }),
	Type.Object(
		{
			op: Type.Literal("add"),
			paths: Type.Array(Type.String(), {
				description: "Files/directories to stage (relative to the repo or absolute).",
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("commit"),
			message: Type.String({ description: "Commit message (first line becomes the subject)." }),
			all: Type.Optional(
				Type.Boolean({
					description:
						"Stage modifications and deletions of tracked files first, like git commit -a (untracked files stay untracked).",
				}),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("log"),
			maxCount: Type.Optional(Type.Number({ description: "Maximum commits to show (default 20, cap 1000)." })),
			from: Type.Optional(Type.String({ description: "Start point instead of HEAD (HEAD~3, branch, sha)." })),
			oneline: Type.Optional(Type.Boolean({ description: "Compact one-line-per-commit format (default true)." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("diff"),
			staged: Type.Optional(
				Type.Boolean({ description: "Diff HEAD vs index (--cached) instead of index vs worktree." }),
			),
			contextLines: Type.Optional(Type.Number({ description: "Context lines per hunk (default 3)." })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ op: Type.Literal("ls-files") }, { additionalProperties: false }),
	Type.Object(
		{
			op: Type.Literal("checkout"),
			target: Type.String({ description: "Branch name to switch to, or any revision to detach at." }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("merge"),
			theirs: Type.Optional(
				Type.String({ description: "Branch or revision to merge (required unless abort/conclude)." }),
			),
			message: Type.Optional(Type.String({ description: "Merge commit message override." })),
			allowUnrelatedHistories: Type.Optional(
				Type.Boolean({ description: "Allow merging histories with no common ancestor." }),
			),
			conclude: Type.Optional(
				Type.Boolean({
					description: "Finish a conflicted merge after resolutions are staged (git merge --continue).",
				}),
			),
			abort: Type.Optional(Type.Boolean({ description: "Abort an in-progress merge back to ORIG_HEAD." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("rebase"),
			upstream: Type.Optional(Type.String({ description: "Upstream to replay onto (required unless abort)." })),
			abort: Type.Optional(Type.Boolean({ description: "Abort an in-progress rebase." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("reset"),
			target: Type.Optional(Type.String({ description: "Revision to reset to (default HEAD)." })),
			mode: Type.Optional(
				Type.Union([Type.Literal("soft"), Type.Literal("mixed"), Type.Literal("hard")], {
					description:
						"soft keeps index+worktree; mixed (default) resets index; hard resets both - local edits are lost.",
				}),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("restore"),
			path: Type.String({ description: "Single path to unstage (git restore --staged)." }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: Type.Literal("cherry-pick"), commit: Type.String({ description: "Commit sha to replay onto HEAD." }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: Type.Literal("revert"), commit: Type.String({ description: "Commit sha to inverse-apply onto HEAD." }) },
		{ additionalProperties: false },
	),
	branchSchema,
	stashSchema,
	remoteSchema,
	Type.Object(
		{
			op: Type.Literal("clone"),
			url: Type.String({ description: "http(s) repository URL." }),
			destDir: Type.Optional(
				Type.String({
					description: "Destination directory (default: a directory named after the repo under cwd).",
				}),
			),
			depth: Type.Optional(Type.Number({ description: "Shallow clone depth." })),
			branch: Type.Optional(Type.String({ description: "Branch to check out." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("fetch"),
			remote: Type.String({ description: "Configured remote name or http(s) URL." }),
			depth: Type.Optional(Type.Number({ description: "Deepen a shallow history to this depth." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("pull"),
			remote: Type.Optional(Type.String({ description: "Remote to pull from (default origin)." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("push"),
			remote: Type.Optional(Type.String({ description: "Remote to push to (default origin)." })),
			refspecs: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Refspecs like "main" or "main:refs/heads/main"; default: current branch.',
				}),
			),
			force: Type.Optional(Type.Boolean({ description: "Allow non-fast-forward updates (default false)." })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("init"),
			dir: Type.String({ description: "Directory to create the repository in." }),
			bare: Type.Optional(Type.Boolean({ description: "Create a bare repository (no worktree)." })),
			defaultBranch: Type.Optional(Type.String({ description: "Initial branch name (default main)." })),
		},
		{ additionalProperties: false },
	),
]);

export type GitToolInput = Static<typeof gitSchema>;

export interface GitToolDetails {
	op: string;
	group: GitOpGroup;
	readOnly: boolean;
	/** Op-specific payload: counts, shas, paths - whatever the text table summarizes. */
	data?: Record<string, string | number | boolean | null>;
}

const OUTPUT_MAX_LINES = 400;
const OUTPUT_MAX_BYTES = 20 * 1024;
const _ZERO_SHA = "0000000000000000000000000000000000000000";

function openRepo(dir: string | undefined, cwd: string): GitRepository {
	const base = dir === undefined || dir === "" ? cwd : resolveToCwd(dir, cwd);
	const repo = GitRepository.open(base);
	if (repo === null) throw new Error(`not a git repository (or any of the parent directories): ${base}`);
	return repo;
}

function identity(repo: GitRepository): { name: string; email: string } {
	const config = repo.config();
	return {
		name: config.get("user.name") ?? "Agent",
		email: config.get("user.email") ?? "agent@localhost",
	};
}

/** User-facing path -> path relative to the repo workdir. */
function workdirPath(repo: GitRepository, path: string): string {
	const absolute = resolveToCwd(path, repo.workdir);
	const rel = relative(repo.workdir, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path is outside the repository: ${path}`);
	return rel.split("\\").join("/");
}

function short(sha: string | null | undefined): string {
	return (sha ?? "").slice(0, 7);
}

function dateOf(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function emit(
	text: string,
	details: GitToolDetails,
): { content: Array<{ type: "text"; text: string }>; details: GitToolDetails } {
	const truncated = truncateHead(text.endsWith("\n") ? text : `${text}\n`, {
		maxLines: OUTPUT_MAX_LINES,
		maxBytes: OUTPUT_MAX_BYTES,
	});
	const suffix = truncated.truncated
		? `\n... output truncated (${truncated.outputLines}/${truncated.totalLines} lines, hit ${truncated.truncatedBy})\n`
		: "";
	return { content: [{ type: "text", text: truncated.content + suffix }], details };
}

function renderStatus(repo: GitRepository): { text: string; counts: Record<string, number> } {
	const head = repo.resolveHead();
	const branch = repo.headBranch();
	const statuses = [...repo.status().entries()]
		.filter(([, status]) => status !== "unmodified") // git shows nothing for clean files
		.sort(([a], [b]) => (a < b ? -1 : 1));
	const counts: Record<string, number> = {};
	for (const [, status] of statuses) counts[status] = (counts[status] ?? 0) + 1;
	const header =
		branch === null ? `HEAD detached at ${short(head.sha)}` : `On branch ${branch.replace("refs/heads/", "")}`;
	if (statuses.length === 0) return { text: `${header}\nnothing to commit, working tree clean`, counts };
	return {
		text: `${header}\n${formatTable(
			statuses.map(([path, status]) => [path, status]),
			["path", "status"],
		)}`,
		counts,
	};
}

function renderLog(entries: LogEntry[], oneline: boolean): string {
	if (oneline) return entries.map((entry) => `${short(entry.sha)} ${entry.subject}`).join("\n");
	return formatTable(
		entries.map((entry) => [short(entry.sha), entry.authorName, dateOf(entry.committerTime), entry.subject]),
		["commit", "author", "date", "subject"],
	);
}

function renderFetch(result: FetchResult): string {
	const lines = [...result.refs.entries()].map(([name, sha]) => [name, short(sha)]);
	const body = lines.length > 0 ? formatTable(lines, ["ref", "sha"]) : "(no refs advertised)";
	const shallow = result.shallowOids.length > 0 ? `\nshallow boundary: ${result.shallowOids.length} commit(s)` : "";
	return body + shallow;
}

function renderPush(result: PushResult): string {
	const rows = result.results.map((entry) => [entry.refName, entry.ok ? "ok" : "rejected", entry.reason ?? ""]);
	const body = rows.length > 0 ? formatTable(rows, ["ref", "result", "reason"]) : "(no refs updated)";
	return result.unpackOk ? body : `${body}\nunpack failed: ${result.unpackReason ?? "unknown error"}`;
}

async function executeOp(input: GitToolInput, cwd: string): Promise<{ text: string; details: GitToolDetails }> {
	switch (input.op) {
		case "status": {
			const repo = openRepo(undefined, cwd);
			const { text, counts } = renderStatus(repo);
			return { text, details: { op: input.op, group: "inspect", readOnly: true, data: counts } };
		}
		case "add": {
			const repo = openRepo(undefined, cwd);
			const paths = input.paths.map((path) => workdirPath(repo, path));
			for (const path of paths) repo.addToIndex(path);
			return {
				text: `Staged ${paths.length} path(s):\n${paths.map((path) => `  ${path}`).join("\n")}`,
				details: { op: input.op, group: "stage", readOnly: false, data: { count: paths.length } },
			};
		}
		case "restore": {
			const repo = openRepo(undefined, cwd);
			const path = workdirPath(repo, input.path);
			const removed = unstagePath(repo, path);
			return {
				text: removed ? `Unstaged ${path}` : `Path was not staged: ${path}`,
				details: { op: input.op, group: "stage", readOnly: false, data: { path, removed } },
			};
		}
		case "commit": {
			const repo = openRepo(undefined, cwd);
			if (input.all === true) {
				for (const [path, status] of repo.status()) {
					if (status === "modified" || status === "deleted") repo.addToIndex(path);
				}
			}
			const who = identity(repo);
			const sha = repo.commitIndex(input.message, who);
			const where = (repo.headBranch() ?? "detached HEAD").replace("refs/heads/", "");
			return {
				text: `[${where} ${short(sha)}] ${input.message.split("\n")[0]}\n${renderStatus(repo).text}`,
				details: { op: input.op, group: "stage", readOnly: false, data: { sha } },
			};
		}
		case "log": {
			const repo = openRepo(undefined, cwd);
			const maxCount = clampInt(input.maxCount, 20, 1, 1000);
			const entries = logCommits(repo, { maxCount, from: input.from });
			if (entries.length === 0) {
				return {
					text: "no commits yet",
					details: { op: input.op, group: "inspect", readOnly: true, data: { count: 0 } },
				};
			}
			return {
				text: renderLog(entries, input.oneline !== false),
				details: {
					op: input.op,
					group: "inspect",
					readOnly: true,
					data: { count: entries.length, tip: short(entries[0]?.sha) },
				},
			};
		}
		case "diff": {
			const repo = openRepo(undefined, cwd);
			const options = { contextLines: clampInt(input.contextLines, 3, 0, 32) };
			const diffs = input.staged === true ? diffStaged(repo, options) : diffWorktree(repo, options);
			if (diffs.length === 0) {
				return {
					text: "(no changes)",
					details: { op: input.op, group: "inspect", readOnly: true, data: { files: 0 } },
				};
			}
			return {
				text: diffs.map((file) => file.patch).join(""),
				details: {
					op: input.op,
					group: "inspect",
					readOnly: true,
					data: { files: diffs.length, binary: diffs.filter((file) => file.binary).length },
				},
			};
		}
		case "ls-files": {
			const repo = openRepo(undefined, cwd);
			const files = listFiles(repo);
			return {
				text: files.length > 0 ? files.join("\n") : "(index empty)",
				details: { op: input.op, group: "inspect", readOnly: true, data: { count: files.length } },
			};
		}
		case "checkout": {
			const repo = openRepo(undefined, cwd);
			const outcome = checkout(repo, input.target);
			const where =
				outcome.branch === null
					? `detached HEAD at ${short(outcome.sha)}`
					: `branch ${outcome.branch.replace("refs/heads/", "")}`;
			return {
				text: `Switched to ${where}`,
				details: {
					op: input.op,
					group: "branch",
					readOnly: false,
					data: { sha: outcome.sha, branch: outcome.branch },
				},
			};
		}
		case "branch": {
			const repo = openRepo(undefined, cwd);
			const action = input.action ?? "list";
			if (action === "create") {
				if (!input.name) throw new Error("branch create requires name");
				const sha = createBranch(repo, input.name, input.startPoint ?? "HEAD");
				return {
					text: `Created branch ${input.name} at ${short(sha)}`,
					details: { op: input.op, group: "branch", readOnly: false, data: { name: input.name, sha } },
				};
			}
			if (action === "delete") {
				if (!input.name) throw new Error("branch delete requires name");
				deleteBranch(repo, input.name);
				return {
					text: `Deleted branch ${input.name}`,
					details: { op: input.op, group: "branch", readOnly: false, data: { name: input.name } },
				};
			}
			const branches = listBranches(repo);
			let text = formatTable(
				branches.map((branch) => [
					(branch.current ? "* " : "  ") + branch.name.replace("refs/heads/", ""),
					short(branch.sha) || "(broken)",
				]),
				["branch", "sha"],
			);
			if (input.tags === true) {
				text +=
					"\n" +
					formatTable(
						listTags(repo).map((tag) => [tag.name, short(tag.sha)]),
						["tag", "sha"],
					);
			}
			return { text, details: { op: input.op, group: "inspect", readOnly: true, data: { count: branches.length } } };
		}

		case "merge": {
			const repo = openRepo(undefined, cwd);
			if (input.abort === true) {
				abortMerge(repo);
				return {
					text: "Merge aborted; back at ORIG_HEAD.",
					details: { op: input.op, group: "history", readOnly: false },
				};
			}
			if (input.conclude === true) {
				const sha = concludeMerge(repo, { message: input.message });
				return {
					text: `Merge concluded: ${short(sha)}`,
					details: { op: input.op, group: "history", readOnly: false, data: { sha } },
				};
			}
			if (!input.theirs) throw new Error("merge requires theirs (or abort/conclude)");
			const outcome = mergeInto(repo, input.theirs, {
				message: input.message,
				allowUnrelatedHistories: input.allowUnrelatedHistories,
			});
			const lines = [`status: ${outcome.status}`];
			if (outcome.commit) lines.push(`commit: ${short(outcome.commit)}`);
			if (outcome.conflicts.length > 0) {
				lines.push(`conflicts (${outcome.conflicts.length}) - resolve, stage, then merge with conclude=true:`);
				for (const path of outcome.conflicts) lines.push(`  both modified: ${path}`);
			}
			return {
				text: lines.join("\n"),
				details: {
					op: input.op,
					group: "history",
					readOnly: false,
					data: { status: outcome.status, commit: outcome.commit, conflicts: outcome.conflicts.length },
				},
			};
		}
		case "rebase": {
			const repo = openRepo(undefined, cwd);
			if (input.abort === true) {
				if (!abortRebase(repo)) throw new Error("no rebase in progress");
				return {
					text: "Rebase aborted; back at ORIG_HEAD.",
					details: { op: input.op, group: "history", readOnly: false },
				};
			}
			if (!input.upstream) throw new Error("rebase requires upstream (or abort)");
			const outcome = rebase(repo, input.upstream);
			const lines = [`status: ${outcome.status}`];
			if (outcome.commit) lines.push(`tip: ${short(outcome.commit)}`);
			if (outcome.stoppedAt) {
				lines.push(
					"stopped at " +
						short(outcome.stoppedAt) +
						" - resolve conflicts and abort/redo; continue is not supported",
				);
				for (const path of outcome.conflicts) lines.push(`  conflict: ${path}`);
			}
			return {
				text: lines.join("\n"),
				details: {
					op: input.op,
					group: "history",
					readOnly: false,
					data: { status: outcome.status, stoppedAt: outcome.stoppedAt },
				},
			};
		}
		case "reset": {
			const repo = openRepo(undefined, cwd);
			const mode: ResetMode = input.mode ?? "mixed";
			const sha = reset(repo, input.target ?? "HEAD", mode);
			return {
				text: `${mode} reset to ${short(sha)}`,
				details: { op: input.op, group: "stage", readOnly: false, data: { sha, mode } },
			};
		}
		case "cherry-pick": {
			const repo = openRepo(undefined, cwd);
			const outcome = cherryPick(repo, input.commit);
			const text =
				outcome.status === "applied"
					? `Cherry-picked as ${short(outcome.commit ?? "")}`
					: "Conflicts (" +
						outcome.conflicts.length +
						"):\n" +
						outcome.conflicts.map((path) => `  ${path}`).join("\n") +
						"\nresolve, stage, and commit to finish.";
			return {
				text,
				details: {
					op: input.op,
					group: "history",
					readOnly: false,
					data: { status: outcome.status, conflicts: outcome.conflicts.length },
				},
			};
		}
		case "revert": {
			const repo = openRepo(undefined, cwd);
			const outcome = revert(repo, input.commit);
			const text =
				outcome.status === "applied"
					? `Reverted as ${short(outcome.commit ?? "")}`
					: "Conflicts (" +
						outcome.conflicts.length +
						"):\n" +
						outcome.conflicts.map((path) => `  ${path}`).join("\n");
			return {
				text,
				details: {
					op: input.op,
					group: "history",
					readOnly: false,
					data: { status: outcome.status, conflicts: outcome.conflicts.length },
				},
			};
		}

		case "stash": {
			const repo = openRepo(undefined, cwd);
			const action = input.action ?? "list";
			const nth = clampInt(input.nth, 0, 0, 1e9);
			if (action === "push") {
				const sha = stashPush(repo, { message: input.message });
				return {
					text: `Saved working directory: ${stashList(repo)[0]?.message ?? short(sha)}`,
					details: { op: input.op, group: "history", readOnly: false, data: { sha } },
				};
			}
			if (action === "apply" || action === "pop") {
				const result = action === "pop" ? stashPop(repo, nth) : stashApply(repo, nth);
				const verb = action === "pop" ? "Popped" : "Applied";
				const text =
					result.conflicts.length === 0
						? `${verb} stash@{${nth}}`
						: "Conflicts (" +
							result.conflicts.length +
							"):\n" +
							result.conflicts.map((path) => `  ${path}`).join("\n");
				return {
					text,
					details: {
						op: input.op,
						group: "history",
						readOnly: false,
						data: { conflicts: result.conflicts.length },
					},
				};
			}
			if (action === "drop") {
				stashDrop(repo, nth);
				return {
					text: `Dropped stash@{${nth}}`,
					details: { op: input.op, group: "history", readOnly: false },
				};
			}
			const entries = stashList(repo);
			const text =
				entries.length === 0
					? "No stash entries."
					: formatTable(
							entries.map((entry, index) => [`stash@{${index}}`, short(entry.sha), entry.message]),
							["entry", "sha", "message"],
						);
			return { text, details: { op: input.op, group: "inspect", readOnly: true, data: { count: entries.length } } };
		}
		case "remote": {
			const repo = openRepo(undefined, cwd);
			const action = input.action ?? "list";
			if (action === "add") {
				if (!input.name || !input.url) throw new Error("remote add requires name and url");
				remoteAdd(repo, input.name, input.url);
				return {
					text: `Added remote ${input.name} -> ${input.url}`,
					details: { op: input.op, group: "remote", readOnly: false, data: { name: input.name } },
				};
			}
			if (action === "remove") {
				if (!input.name) throw new Error("remote remove requires name");
				remoteRemove(repo, input.name);
				return {
					text: `Removed remote ${input.name}`,
					details: { op: input.op, group: "remote", readOnly: false, data: { name: input.name } },
				};
			}
			const remotes = remoteList(repo);
			const text =
				remotes.length === 0
					? "(no remotes configured)"
					: formatTable(
							remotes.map((r) => [r.name, r.url]),
							["remote", "url"],
						);
			return { text, details: { op: input.op, group: "inspect", readOnly: true, data: { count: remotes.length } } };
		}
		case "clone": {
			const fallbackDest =
				input.url
					.split("/")
					.at(-1)
					?.replace(/\.git$/, "") ?? "repo";
			const destDir = resolveToCwd(input.destDir ?? fallbackDest, cwd);
			const repo = await cloneRepository(input.url, destDir, { depth: input.depth, branch: input.branch });
			return {
				text: `Cloned ${input.url} into ${destDir}\n${renderStatus(repo).text}`,
				details: { op: input.op, group: "remote", readOnly: false, data: { destDir } },
			};
		}
		case "fetch": {
			const repo = openRepo(undefined, cwd);
			const result = await fetchRemote(repo, input.remote, { depth: input.depth });
			return {
				text: renderFetch(result),
				details: {
					op: input.op,
					group: "remote",
					readOnly: false,
					data: { refCount: result.refs.size, shallow: result.shallowOids.length },
				},
			};
		}
		case "pull": {
			const repo = openRepo(undefined, cwd);
			const outcome = await pullRemote(repo, input.remote ?? "origin");
			return {
				text: `pull: ${outcome}`,
				details: { op: input.op, group: "remote", readOnly: false, data: { outcome } },
			};
		}
		case "push": {
			const repo = openRepo(undefined, cwd);
			const result = await pushRemote(repo, input.remote ?? "origin", {
				refspecs: input.refspecs,
				force: input.force,
			});
			return {
				text: renderPush(result),
				details: { op: input.op, group: "remote", readOnly: false, data: { refs: result.results.length } },
			};
		}
		case "init": {
			const dir = resolveToCwd(input.dir, cwd);
			const repo = GitRepository.init(dir, { bare: input.bare, defaultBranch: input.defaultBranch });
			return {
				text: `Initialized empty Git repository in ${repo.gitDir}`,
				details: { op: input.op, group: "remote", readOnly: false, data: { gitDir: repo.gitDir } },
			};
		}
	}
	throw new Error("unreachable git op");
}

/**
 * Run git operations against the repository without spawning git - pure
 * TypeScript, identical behavior on Windows. One tool over the full local
 * surface: status/add/commit/log/diff, branch and checkout, merge (with the
 * conflict + conclude flow), rebase, reset/restore, cherry-pick, revert, the
 * stash stack, remotes, and clone/fetch/pull/push over smart HTTP. Use it for
 * any version-control question or action in a repository; do not use it for
 * plain file reads/writes (read_file/write_file), for repos outside http(s)
 * reach (no SSH transport), or when you need git features this tool does not
 * expose (interactive rebase, submodules, worktrees) - bash is the fallback.
 * Read-only ops: status, log, diff, ls-files, branch list, stash list,
 * remote list - everything else mutates refs, index or worktree.
 *
 * Conflicts never half-finish silently: merge/rebase/cherry-pick/revert/stash
 * report each conflicting path with git's own phrasing ("Your local changes to
 * the following files would be overwritten by checkout", "fatal: not a git
 * repository") so agents can act on them exactly as they would on real git
 * output. Output is dense tables under a 400-line/20KB budget with an explicit
 * truncation marker.
 */
export function createGitToolDefinition(cwd: string): ToolDefinition<typeof gitSchema, GitToolDetails> {
	const definition: ToolDefinition<typeof gitSchema, GitToolDetails> = {
		name: "git",
		label: "git",
		description:
			'Run git operations against the repository without spawning git - pure TypeScript, identical behavior on Windows. Ops: status, add, commit (all=true stages tracked edits like commit -a), log, diff (worktree or --cached), ls-files, branch list/create/delete (+tags), checkout, merge (abort/conclude flow), rebase (abort), reset soft/mixed/hard, restore --staged, cherry-pick, revert, stash push/pop/apply/list/drop, remote add/remove/list, clone/fetch/pull/push over smart HTTP, init. Use it for version-control state and actions inside a repository; do not use it for plain file editing (write_file/edit), non-git archives, SSH remotes or credential helpers (smart HTTP only), or exotic flows like interactive rebase/submodules/worktrees (bash instead). Conflicts and refusals carry git-equivalent messages ("Your local changes to the following files would be overwritten by merge", "non-fast-forward push ... rejected", "not a git repository"). Read-only ops are status/log/diff/ls-files and the list actions; everything else mutates.',
		promptSnippet: "Run git operations (status, add, commit, branches, merge, stash, remotes) in-process",
		parameters: gitSchema,
		executionMode: "sequential",
		kind: "edit",
		read_only: false,
		async execute(
			_toolCallId,
			input: GitToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: GitToolDetails }> {
			throwIfAborted(signal);
			const { text, details } = await executeOp(input as GitToolInput, cwd);
			return emit(text, details);
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: undefined });
}

export function createGitTool(cwd: string): AgentTool<typeof gitSchema> {
	return wrapToolDefinition(createGitToolDefinition(cwd));
}
