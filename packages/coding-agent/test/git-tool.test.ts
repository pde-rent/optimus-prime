import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitToolDetails } from "../src/core/tools/native/git.js";
import { createGitToolDefinition } from "../src/core/tools/native/git.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let fixtureCounter = 0;
function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${fixtureCounter++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface RunResult {
	content: Array<{ type: "text"; text: string }>;
	details: GitToolDetails;
}

async function runGitTool(input: Record<string, unknown>, cwd: string): Promise<RunResult> {
	const definition = createGitToolDefinition(cwd);
	const ctx = { cwd } as Parameters<typeof definition.execute>[4];
	const result = (await definition.execute("test-call", input as never, undefined, undefined, ctx)) as RunResult;
	return result;
}

/** Commit helper straight through the tool: write file, stage, commit. */
async function seedCommit(cwd: string, file: string, content: string, message: string): Promise<string> {
	writeFileSync(join(cwd, file), content);
	await runGitTool({ op: "add", paths: [file] }, cwd);
	const result = await runGitTool({ op: "commit", message }, cwd);
	return String(result.details.data?.sha ?? "");
}

const GIT_VERSION = Bun.which("git") ? "" : "";
void GIT_VERSION;

// ---------------------------------------------------------------------------
// Local ops
// ---------------------------------------------------------------------------

describe("git tool", () => {
	test("init creates a repository and status reports a clean tree", async () => {
		const dir = makeTempDir("git-tool-init");
		const result = await runGitTool({ op: "init", dir }, join(dir, ".."));
		expect(result.details.op).toBe("init");
		expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);

		const status = await runGitTool({ op: "status" }, dir);
		expect(status.details.readOnly).toBe(true);
		expect(status.content[0].text).toContain("On branch main");
		expect(status.content[0].text).toContain("working tree clean");

		const again = runGitTool({ op: "init", dir }, join(dir, ".."));
		await expect(again).rejects.toThrow(/already exists/);
	});

	test("add + commit + log + ls-files round-trip", async () => {
		const cwd = makeTempDir("git-tool-basic");
		await runGitTool({ op: "init", dir: "." }, cwd);
		writeFileSync(join(cwd, "a.txt"), "one\n");
		await runGitTool({ op: "add", paths: ["a.txt"] }, cwd);
		const staged = await runGitTool({ op: "diff", staged: true }, cwd);
		expect(staged.content[0].text).toContain("+one");

		const commit = await runGitTool({ op: "commit", message: "first commit\n\nbody line" }, cwd);
		const sha = String(commit.details.data?.sha ?? "");
		expect(sha).toMatch(/^[0-9a-f]{40}$/);

		const log = await runGitTool({ op: "log" }, cwd);
		expect(log.content[0].text).toContain(sha.slice(0, 7));
		expect(log.content[0].text).toContain("first commit");

		const tableLog = await runGitTool({ op: "log", oneline: false, maxCount: 5 }, cwd);
		expect(tableLog.content[0].text).toContain("author");
		expect(tableLog.content[0].text).toContain("subject");

		const files = await runGitTool({ op: "ls-files" }, cwd);
		expect(files.content[0].text.trim()).toBe("a.txt");
	});

	test("status classifies untracked/staged/modified/deleted", async () => {
		const cwd = makeTempDir("git-tool-status");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "tracked.txt", "v1\n", "base");
		writeFileSync(join(cwd, "new.txt"), "untracked\n");
		const status = await runGitTool({ op: "status" }, cwd);
		expect(status.content[0].text).toContain("new.txt");
		expect(status.content[0].text).toContain("untracked");
	});

	test("diff worktree vs staged vs empty", async () => {
		const cwd = makeTempDir("git-tool-diff");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "f.txt", "line one\nline two\n", "base");
		const empty = await runGitTool({ op: "diff" }, cwd);
		expect(empty.content[0].text.trim()).toBe("(no changes)");

		writeFileSync(join(cwd, "f.txt"), "line one\nCHANGED\n");
		const worktree = await runGitTool({ op: "diff", contextLines: 1 }, cwd);
		expect(worktree.content[0].text).toContain("-line two");
		expect(worktree.content[0].text).toContain("+CHANGED");
		expect(worktree.content[0].text).toContain("diff --git a/f.txt b/f.txt");

		await runGitTool({ op: "add", paths: ["f.txt"] }, cwd);
		const unstaged = await runGitTool({ op: "diff" }, cwd);
		expect(unstaged.content[0].text.trim()).toBe("(no changes)");
		const staged = await runGitTool({ op: "diff", staged: true }, cwd);
		expect(staged.content[0].text).toContain("+CHANGED");
	});

	test("restore unstages a single path", async () => {
		const cwd = makeTempDir("git-tool-restore");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "f.txt", "v1\n", "base");
		writeFileSync(join(cwd, "f.txt"), "v2\n");
		await runGitTool({ op: "add", paths: ["f.txt"] }, cwd);
		const restored = await runGitTool({ op: "restore", path: "f.txt" }, cwd);
		expect(restored.content[0].text).toContain("Unstaged f.txt");
		const staged = await runGitTool({ op: "diff", staged: true }, cwd);
		expect(staged.content[0].text.trim()).toBe("(no changes)");
	});

	test("branch create/list/delete and checkout", async () => {
		const cwd = makeTempDir("git-tool-branch");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "base.txt", "base\n", "base");

		const created = await runGitTool({ op: "branch", action: "create", name: "feature" }, cwd);
		expect(created.content[0].text).toContain("Created branch feature");

		const list = await runGitTool({ op: "branch" }, cwd);
		expect(list.content[0].text).toContain("* main");
		expect(list.content[0].text).toContain("feature");

		const checkout = await runGitTool({ op: "checkout", target: "main" }, cwd);
		expect(checkout.content[0].text).toContain("Switched to branch main");
		const detached = await runGitTool({ op: "checkout", target: "HEAD~0" }, cwd);
		expect(detached.content[0].text).toContain("detached HEAD at");

		await runGitTool({ op: "checkout", target: "main" }, cwd);
		const deleted = await runGitTool({ op: "branch", action: "delete", name: "feature" }, cwd);
		expect(deleted.content[0].text).toContain("Deleted branch feature");
		const afterDelete = await runGitTool({ op: "branch", action: "list", tags: true }, cwd);
		expect(afterDelete.content[0].text).not.toContain("feature");
	});

	test("merge: fast-forward, clean three-way, conflict + conclude, abort", async () => {
		const cwd = makeTempDir("git-tool-merge");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "shared.txt", "base\n", "base");
		await runGitTool({ op: "branch", action: "create", name: "topic" }, cwd);

		// merging an ancestor reports up-to-date
		const uptoDate = await runGitTool({ op: "merge", theirs: "topic" }, cwd);
		expect(uptoDate.content[0].text).toContain("status: up-to-date");

		// main moves ahead; from the stale topic branch, merging main is a fast-forward
		await seedCommit(cwd, "main-only.txt", "main\n", "main advance");
		await runGitTool({ op: "checkout", target: "topic" }, cwd);
		const ff = await runGitTool({ op: "merge", theirs: "main" }, cwd);
		expect(ff.content[0].text).toContain("status: fast-forward");

		// back on main, commit there, then merge topic (which also advanced) -> clean three-way
		await runGitTool({ op: "checkout", target: "main" }, cwd);
		await seedCommit(cwd, "topic.txt", "topic\n", "topic work");
		await runGitTool({ op: "checkout", target: "topic" }, cwd);
		await seedCommit(cwd, "main2.txt", "more main\n", "main work 2");
		const threeWay = await runGitTool({ op: "merge", theirs: "main" }, cwd);
		expect(threeWay.content[0].text).toContain("status: merged");

		// conflicting edit on the same file across main and topic
		await runGitTool({ op: "checkout", target: "main" }, cwd);
		await seedCommit(cwd, "conflict.txt", "main version\n", "main side");
		await runGitTool({ op: "checkout", target: "topic" }, cwd);
		await seedCommit(cwd, "conflict.txt", "topic version\n", "topic side");
		await runGitTool({ op: "checkout", target: "main" }, cwd);
		const conflict = await runGitTool({ op: "merge", theirs: "topic" }, cwd);
		expect(conflict.details.data?.conflicts).toBe(1);
		expect(conflict.content[0].text).toContain("conflict.txt");
		const aborted = await runGitTool({ op: "merge", abort: true }, cwd);
		expect(aborted.content[0].text).toContain("Merge aborted");
	});

	test("rebase replays commits and abort restores", async () => {
		const cwd = makeTempDir("git-tool-rebase");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "f.txt", "one\n", "one");
		await runGitTool({ op: "branch", action: "create", name: "dev" }, cwd);
		await seedCommit(cwd, "main.txt", "main\n", "main commit");
		await runGitTool({ op: "checkout", target: "dev" }, cwd);
		await seedCommit(cwd, "dev.txt", "dev\n", "dev commit");

		const rebased = await runGitTool({ op: "rebase", upstream: "main" }, cwd);
		expect(rebased.content[0].text).toContain("status: rebased");
		const log = await runGitTool({ op: "log" }, cwd);
		expect(log.content[0].text).toContain("dev commit");
		expect(log.content[0].text).toContain("main commit");

		// up-to-date case
		const again = await runGitTool({ op: "rebase", upstream: "main" }, cwd);
		expect(again.content[0].text).toContain("up-to-date");
	});

	test("reset soft/mixed/hard and unknown revision errors", async () => {
		const cwd = makeTempDir("git-tool-reset");
		await runGitTool({ op: "init", dir: "." }, cwd);
		const first = await seedCommit(cwd, "f.txt", "v1\n", "first");
		await seedCommit(cwd, "g.txt", "v2\n", "second");

		const soft = await runGitTool({ op: "reset", target: String(first), mode: "soft" }, cwd);
		expect(soft.content[0].text).toContain("soft reset to");
		let staged = await runGitTool({ op: "diff", staged: true }, cwd);
		expect(staged.content[0].text).toContain("+v2");

		const mixed = await runGitTool({ op: "reset", target: String(first), mode: "mixed" }, cwd);
		expect(mixed.content[0].text).toContain("mixed reset to");
		staged = await runGitTool({ op: "diff", staged: true }, cwd);
		expect(staged.content[0].text.trim()).toBe("(no changes)");
		// mixed reset unstages the second commit's file back to untracked (git parity)
		const status = await runGitTool({ op: "status" }, cwd);
		expect(status.content[0].text).toContain("g.txt");
		expect(status.content[0].text).toContain("untracked");

		const hard = await runGitTool({ op: "reset", target: String(first), mode: "hard" }, cwd);
		expect(hard.content[0].text).toContain("hard reset to");
		// g.txt was already untracked after the mixed reset - reset --hard keeps untracked files (git parity)
		expect(existsSync(join(cwd, "g.txt"))).toBe(true);

		const unknown = runGitTool({ op: "reset", target: "no-such-ref" }, cwd);
		await expect(unknown).rejects.toThrow(/unknown revision/);
	});

	test("cherry-pick and revert", async () => {
		const cwd = makeTempDir("git-tool-cherry");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "base.txt", "base\n", "base");
		await runGitTool({ op: "branch", action: "create", name: "side" }, cwd);
		const picked = await seedCommit(cwd, "picked.txt", "pick me\n", "the pick");
		await runGitTool({ op: "checkout", target: "side" }, cwd);
		await seedCommit(cwd, "side.txt", "side\n", "side commit");

		const cherry = await runGitTool({ op: "cherry-pick", commit: picked }, cwd);
		expect(cherry.content[0].text).toContain("Cherry-picked");
		expect(existsSync(join(cwd, "picked.txt"))).toBe(true);

		const revert = await runGitTool({ op: "revert", commit: picked }, cwd);
		expect(revert.content[0].text).toContain("Reverted");
	});

	test("stash push/list/apply/pop/drop", async () => {
		const cwd = makeTempDir("git-tool-stash");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "f.txt", "v1\n", "base");

		writeFileSync(join(cwd, "f.txt"), "v2 dirty\n");
		const pushed = await runGitTool({ op: "stash", action: "push", message: "wip" }, cwd);
		expect(pushed.content[0].text).toContain("Saved working directory");
		let status = await runGitTool({ op: "status" }, cwd);
		expect(status.content[0].text).toContain("working tree clean");

		const list = await runGitTool({ op: "stash", action: "list" }, cwd);
		expect(list.content[0].text).toContain("wip");

		const applied = await runGitTool({ op: "stash", action: "apply" }, cwd);
		expect(applied.content[0].text).toContain("Applied stash@{0}");
		status = await runGitTool({ op: "status" }, cwd);
		expect(status.content[0].text).toContain("modified");

		const popped = await runGitTool({ op: "stash", action: "pop" }, cwd);
		expect(popped.content[0].text).toContain("Popped stash@{0}");
		const empty = await runGitTool({ op: "stash", action: "list" }, cwd);
		expect(empty.content[0].text.trim()).toBe("No stash entries.");
	});

	test("cherry-pick and revert", async () => {
		const cwd = makeTempDir("git-tool-cherry");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "base.txt", "base\n", "base");
		await runGitTool({ op: "branch", action: "create", name: "side" }, cwd);
		const picked = await seedCommit(cwd, "picked.txt", "pick me\n", "the pick");
		await runGitTool({ op: "checkout", target: "side" }, cwd);
		await seedCommit(cwd, "side.txt", "side\n", "side commit");

		const cherry = await runGitTool({ op: "cherry-pick", commit: picked }, cwd);
		expect(cherry.content[0].text).toContain("Cherry-picked");
		expect(existsSync(join(cwd, "picked.txt"))).toBe(true);

		const revert = await runGitTool({ op: "revert", commit: picked }, cwd);
		expect(revert.content[0].text).toContain("Reverted");
	});

	test("stash push/list/apply/pop/drop", async () => {
		const cwd = makeTempDir("git-tool-stash");
		await runGitTool({ op: "init", dir: "." }, cwd);
		await seedCommit(cwd, "f.txt", "v1\n", "base");

		writeFileSync(join(cwd, "f.txt"), "v2 dirty\n");
		const pushed = await runGitTool({ op: "stash", action: "push", message: "wip" }, cwd);
		expect(pushed.content[0].text).toContain("Saved working directory");
		let status = await runGitTool({ op: "status" }, cwd);
		expect(status.content[0].text).toContain("working tree clean");

		const list = await runGitTool({ op: "stash", action: "list" }, cwd);
		expect(list.content[0].text).toContain("wip");

		const applied = await runGitTool({ op: "stash", action: "apply" }, cwd);
		expect(applied.content[0].text).toContain("Applied stash@{0}");
		status = await runGitTool({ op: "status" }, cwd);
		expect(status.content[0].text).toContain("modified");

		const popped = await runGitTool({ op: "stash", action: "pop" }, cwd);
		expect(popped.content[0].text).toContain("Popped stash@{0}");
		const empty = await runGitTool({ op: "stash", action: "list" }, cwd);
		expect(empty.content[0].text.trim()).toBe("No stash entries.");
	});

	// -- remotes + smart HTTP (real git http-backend; skipped without git) ------

	const GIT_VERSION = Bun.which("git");

	function spawnGitHttp(projectRoot: string): { url: string; close: () => void } {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
				const env: Record<string, string> = {
					GIT_PROJECT_ROOT: projectRoot,
					GIT_HTTP_EXPORT_ALL: "1",
					PATH_INFO: url.pathname,
					REQUEST_METHOD: request.method,
					QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
					CONTENT_TYPE: request.headers.get("content-type") ?? "",
					REMOTE_ADDR: "127.0.0.1",
					GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
				};
				if (body) env.CONTENT_LENGTH = String(body.length);
				const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
				if (body) child.stdin.write(body);
				child.stdin.end();
				const raw = new Uint8Array(await new Response(child.stdout).arrayBuffer());
				await new Response(child.stderr).text();
				let split = -1;
				for (let i = 0; i + 4 <= raw.length; i++) {
					if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
						split = i;
						break;
					}
				}
				if (split === -1) return new Response("cgi failure", { status: 502 });
				const headerText = new TextDecoder().decode(raw.subarray(0, split));
				const headers = new Headers({ connection: "close" });
				for (const line of headerText.split("\r\n")) {
					const colon = line.indexOf(":");
					if (colon > 0 && !/^Status$/i.test(line.slice(0, colon))) {
						headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
					}
				}
				return new Response(raw.subarray(split + 4), {
					status: Number(/^Status:\s*(\d+)/m.exec(headerText)?.[1] ?? "200"),
					headers,
				});
			},
		});
		return { url: `http://localhost:${server.port}`, close: () => server.stop(true) };
	}

	test("remote add/list/remove", async () => {
		const cwd = makeTempDir("git-tool-remote");
		await runGitTool({ op: "init", dir: "." }, cwd);
		const empty = await runGitTool({ op: "remote" }, cwd);
		expect(empty.content[0].text.trim()).toBe("(no remotes configured)");
		await runGitTool({ op: "remote", action: "add", name: "origin", url: "https://example.com/repo.git" }, cwd);
		const list = await runGitTool({ op: "remote" }, cwd);
		expect(list.content[0].text).toContain("origin");
		expect(list.content[0].text).toContain("https://example.com/repo.git");
		await runGitTool({ op: "remote", action: "remove", name: "origin" }, cwd);
		const after = await runGitTool({ op: "remote" }, cwd);
		expect(after.content[0].text.trim()).toBe("(no remotes configured)");
	});

	test("clone/fetch/pull/push over local git http-backend", async () => {
		if (!GIT_VERSION) return; // requires real git for http-backend and fixture setup
		const { execFileSync } = await import("node:child_process");
		const root = makeTempDir("git-tool-http-root");
		const seedWork = join(root, "seed");
		mkdirSync(seedWork, { recursive: true });
		const g = (args: string[], cwd: string) =>
			execFileSync("git", ["-C", cwd, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args], {
				encoding: "utf8",
			});
		g(["init", "-b", "main"], seedWork);
		writeFileSync(join(seedWork, "hello.txt"), "from seed\n");
		g(["add", "."], seedWork);
		g(["commit", "-m", "seed commit"], seedWork);
		execFileSync("git", ["clone", "--bare", seedWork, join(root, "server.git")], { encoding: "utf8" });
		// anonymous push needs an explicit opt-in on the bare repo
		execFileSync("git", ["-C", join(root, "server.git"), "config", "http.receivepack", "true"], {
			encoding: "utf8",
		});

		const server = spawnGitHttp(root);
		try {
			const cloneDir = makeTempDir("git-tool-clone-dest");
			const cloneDirParent = join(cloneDir, "..");
			rmSync(cloneDir, { recursive: true, force: true }); // clone creates it fresh under its parent
			const cloned = await runGitTool(
				{ op: "clone", url: `${server.url}/server.git`, destDir: cloneDir },
				cloneDirParent,
			);
			expect(cloned.content[0].text).toContain("On branch main");
			expect(existsSync(join(cloneDir, "hello.txt"))).toBe(true);

			// commit in the clone, push it up
			await seedCommit(cloneDir, "tool.txt", "pushed by tool\n", "tool push");
			const push = await runGitTool({ op: "push" }, cloneDir);
			expect(push.content[0].text).toContain("refs/heads/main");
			expect(push.content[0].text).toContain("ok");

			// a second clone sees the pushed ref via fetch+pull
			const secondDir = makeTempDir("git-tool-second");
			await runGitTool({ op: "init", dir: "." }, secondDir);
			await runGitTool({ op: "remote", action: "add", name: "origin", url: `${server.url}/server.git` }, secondDir);
			const list = await runGitTool({ op: "remote" }, secondDir);
			expect(list.content[0].text).toContain("origin");
			const fetch = await runGitTool({ op: "fetch", remote: "origin" }, secondDir);
			expect(fetch.content[0].text).toContain("refs/heads/main");
			const pull = await runGitTool({ op: "pull", remote: "origin" }, secondDir);
			expect(pull.content[0].text).toContain("fast-forward");
			expect(existsSync(join(secondDir, "hello.txt"))).toBe(true);
			expect(existsSync(join(secondDir, "tool.txt"))).toBe(true);

			// up-to-date pull
			const again = await runGitTool({ op: "pull", remote: "origin" }, secondDir);
			expect(again.content[0].text).toContain("up-to-date");
		} finally {
			server.close();
		}
	});

	test("errors carry git-equivalent phrasing", async () => {
		const outside = makeTempDir("git-tool-outside");
		const notARepo = runGitTool({ op: "status" }, outside);
		await expect(notARepo).rejects.toThrow(/not a git repository/);
	});
});
