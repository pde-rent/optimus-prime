import { describe, expect, test } from "bun:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	cloneRepository,
	fetchRemote,
	pullRemote,
	pushRemote,
	remoteAdd,
	remoteList,
	remoteRemove,
	resolveRemoteSpec,
} from "../src/core/git/remote.js";
import { GitRepository } from "../src/core/git/repository.js";
import { encodePktLine, GitHttpError, PktLineReader } from "../src/core/git/transport-http.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GIT_VERSION = Bun.which("git") ? spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim() : "";
const HAS_GIT = GIT_VERSION.startsWith("git version");

let fixtureCounter = 0;
function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${fixtureCounter++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Async on purpose: bun test runs the server in this same process, and a
 * synchronous subprocess would block the event loop the server needs.
 */
async function gitRun(cwd: string, args: string[]): Promise<{ stdout: string; status: number }> {
	try {
		const { stdout } = await promisify(execFile)("git", ["-C", cwd, ...args], {
			encoding: "buffer",
			maxBuffer: 1 << 28,
		});
		return { stdout: stdout.toString(), status: 0 };
	} catch (error) {
		const failure = error as { code?: number | string; stderr?: Buffer };
		const status = typeof failure.code === "number" ? failure.code : 1;
		return { stdout: failure.stderr?.toString() ?? "", status };
	}
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
	const result = await gitRun(cwd, args);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stdout}`);
	return result.stdout;
}

const AUTHOR_CONFIG = ["-c", "user.name=Fixture Bot", "-c", "user.email=fixture@example.com"];

interface GitHttpServer {
	url: string;
	close: () => void;
	requireAuth: (credentials: { user: string; pass: string } | null) => void;
}

/** git http-backend behind a tiny Bun.serve CGI wrapper: real smart HTTP, no deps, no network. */
function serveGitHttp(projectRoot: string): GitHttpServer {
	let expectedAuth: { user: string; pass: string } | null = null;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
			if (expectedAuth) {
				// Accept either user:pass or the GIT_TOKEN style x-access-token:<token>.
				const accepted = [
					`Basic ${btoa(`${expectedAuth.user}:${expectedAuth.pass}`)}`,
					`Basic ${btoa(`x-access-token:${expectedAuth.pass}`)}`,
				];
				if (!accepted.includes(request.headers.get("Authorization") ?? "")) {
					return new Response("auth required", {
						status: 401,
						headers: { "WWW-Authenticate": 'Basic realm="git"' },
					});
				}
			}
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
			const exitCode = await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
			let split = -1;
			for (let i = 0; i + 4 <= raw.length; i++) {
				if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
					split = i;
					break;
				}
			}
			if (split === -1 || exitCode !== 0) return new Response(`cgi failure: ${exitCode}`, { status: 502 });
			const headerText = new TextDecoder().decode(raw.subarray(0, split));
			const status = /^Status:\s*(\d+)/m.exec(headerText)?.[1] ?? "200";
			const headers = new Headers();
			for (const line of headerText.split("\r\n")) {
				const colon = line.indexOf(":");
				if (colon > 0 && !/^Status$/i.test(line.slice(0, colon))) {
					headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
				}
			}
			headers.set("connection", "close");
			return new Response(raw.subarray(split + 4), { status: Number(status), headers });
		},
	});
	return {
		url: `http://localhost:${server.port}`,
		close: () => server.stop(true),
		requireAuth: (credentials) => {
			expectedAuth = credentials;
		},
	};
}

/** Origin repo built by real git: nested dirs, executable, deletion history, branch, annotated tag. */
async function makeOrigin(
	root: string,
	name: string,
	baseUrl: string,
): Promise<{ url: string; barePath: string; seed: string }> {
	const seed = join(root, `${name}-seed`);
	mkdirSync(seed, { recursive: true });
	await gitOrThrow(seed, ["init", "-b", "main"]);
	await gitOrThrow(seed, [...AUTHOR_CONFIG, "config", "user.name", "Fixture Bot"]);
	await gitOrThrow(seed, [...AUTHOR_CONFIG, "config", "user.email", "fixture@example.com"]);
	writeFileSync(join(seed, "hello.txt"), "line one\nline two\nline three\n");
	mkdirSync(join(seed, "lib"));
	writeFileSync(join(seed, "lib", "util.txt"), "shared code\nshared more\n");
	writeFileSync(join(seed, "run.sh"), "#!/bin/sh\necho hi\n");
	chmodSync(join(seed, "run.sh"), 0o755);
	writeFileSync(join(seed, "docs.md"), "# doc\n".repeat(50));
	await gitOrThrow(seed, ["add", "."]);
	await gitOrThrow(seed, [...AUTHOR_CONFIG, "commit", "-m", "first commit"]);
	writeFileSync(join(seed, "hello.txt"), "line one\nline two\nline three\nline four\n");
	writeFileSync(join(seed, "docs.md"), `${"# doc\n".repeat(50)}tail\n`);
	rmSync(join(seed, "lib", "util.txt"));
	await gitOrThrow(seed, ["add", "."]);
	await gitOrThrow(seed, [...AUTHOR_CONFIG, "commit", "-m", "second commit"]);
	await gitOrThrow(seed, ["tag", "-a", "v1.0", "-m", "release one"]);
	await gitOrThrow(seed, ["branch", "feature"]);
	const barePath = join(root, `${name}.git`);
	await gitOrThrow(root, ["clone", "--bare", seed, barePath]);
	await gitOrThrow(barePath, ["config", "http.receivepack", "true"]);
	return { url: `${baseUrl}/${name}.git`, barePath, seed };
}

function worktreeSnapshot(dir: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	const visit = (current: string): void => {
		for (const name of readdirSync(current)) {
			if (name === ".git") continue;
			const path = join(current, name);
			if (statSync(path).isDirectory()) visit(path);
			else files.set(path.slice(dir.length + 1), readFileSync(path));
		}
	};
	visit(dir);
	return files;
}

// ---------------------------------------------------------------------------
// Pure transport helpers
// ---------------------------------------------------------------------------

describe("smart http transport: pkt-line framing", () => {
	test("encode/read round-trip incl flush detection", () => {
		const bytes = new Uint8Array([
			...encodePktLine("want 0123456789012345678901234567890123456789\n"),
			...encodePktLine("done\n"),
			...new TextEncoder().encode("0000"),
		]);
		const reader = new PktLineReader(bytes);
		expect(new TextDecoder().decode(reader.next()!)).toBe("want 0123456789012345678901234567890123456789\n");
		expect(new TextDecoder().decode(reader.next()!)).toBe("done\n");
		expect(reader.next()).toBeNull(); // flush
		expect(reader.next()).toBeUndefined(); // exhausted
	});

	test("binary payloads survive framing", () => {
		const payload = new Uint8Array(300);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		payload.set(new TextEncoder().encode("001e"), 0); // lookalike length prefix inside data
		const reader = new PktLineReader(
			new Uint8Array([...encodePktLine(payload), ...new TextEncoder().encode("0000")]),
		);
		expect(Buffer.from(reader.next()!)).toEqual(Buffer.from(payload));
		expect(reader.next()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// End-to-end over a local real git http-backend
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_GIT)(`git client phase 3: network (${GIT_VERSION})`, () => {
	const root = makeTempDir("pi-gitnet");
	const server = serveGitHttp(root);

	test("clone: worktree, refs and objects match a real-git clone byte-for-byte", async () => {
		const origin = await makeOrigin(root, "origin-clone", server.url);
		const oursDir = join(root, "clone-ours");
		const theirsDir = join(root, "clone-theirs");

		await gitOrThrow(root, ["clone", "--no-local", origin.url, theirsDir]);
		const repo = await cloneRepository(origin.url, oursDir);

		const oursFiles = worktreeSnapshot(oursDir);
		const theirsFiles = worktreeSnapshot(theirsDir);
		expect([...oursFiles.keys()].sort()).toEqual([...theirsFiles.keys()].sort());
		for (const [path, bytes] of oursFiles) expect(theirsFiles.get(path)!).toEqual(bytes);

		expect((await gitOrThrow(oursDir, ["symbolic-ref", "HEAD"])).trim()).toBe(
			(await gitOrThrow(theirsDir, ["symbolic-ref", "HEAD"])).trim(),
		);
		expect((await gitOrThrow(oursDir, ["rev-parse", "HEAD"])).trim()).toBe(
			(await gitOrThrow(theirsDir, ["rev-parse", "HEAD"])).trim(),
		);
		expect((await gitOrThrow(oursDir, ["rev-parse", "v1.0"])).trim()).toBe(
			(await gitOrThrow(theirsDir, ["rev-parse", "v1.0"])).trim(),
		);
		expect((await gitOrThrow(oursDir, ["rev-parse", "refs/remotes/origin/feature"])).trim()).toBe(
			(await gitOrThrow(theirsDir, ["rev-parse", "refs/remotes/origin/feature"])).trim(),
		);

		const listObjects = async (dir: string) =>
			(await gitOrThrow(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]))
				.trim()
				.split("\n")
				.sort();
		expect(await listObjects(oursDir)).toEqual(await listObjects(theirsDir));

		expect(statSync(join(oursDir, "run.sh")).mode & 0o111).toBeTruthy();
		const statuses = [...repo.status().values()];
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.every((s) => s === "unmodified")).toBe(true);
		expect(repo.config().get("remote.origin.url")).toBe(origin.url);
	});

	test("shallow clone --depth 1: shallow grafts recorded, parents absent, tree complete", async () => {
		const origin = await makeOrigin(root, "origin-shallow", server.url);
		const dir = join(root, "clone-shallow");
		const mainTip = (await gitOrThrow(origin.barePath, ["rev-parse", "main"])).trim();
		const parentSha = (await gitOrThrow(origin.barePath, ["rev-parse", `${mainTip}^`])).trim();
		const repo = await cloneRepository(origin.url, dir, { depth: 1 });

		const shallowOids = readFileSync(join(dir, ".git", "shallow"), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(shallowOids).toContain(mainTip);
		expect(repo.resolveRef("refs/heads/main")).toBe(mainTip);
		expect(repo.hasObject(parentSha)).toBe(false);
		expect(readFileSync(join(dir, "hello.txt"), "utf8")).toContain("line four");
		expect((await gitRun(dir, ["fsck", "--strict"])).status).toBe(0);
	});

	test("fetch: no pack when up to date, pack + tracking ref when ahead; FETCH_HEAD format", async () => {
		const origin = await makeOrigin(root, "origin-fetch", server.url);
		const dir = join(root, "clone-fetch");
		const repo = await cloneRepository(origin.url, dir);
		const packsBefore = readdirSync(join(dir, ".git", "objects", "pack")).length;

		const upToDate = await fetchRemote(repo, "origin");
		expect(upToDate.packChecksum).toBeNull();
		expect(readdirSync(join(dir, ".git", "objects", "pack")).length).toBe(packsBefore);

		writeFileSync(join(origin.seed, "increment.txt"), "fetched later\n");
		await gitOrThrow(origin.seed, ["add", "."]);
		await gitOrThrow(origin.seed, [...AUTHOR_CONFIG, "commit", "-m", "third commit"]);
		await gitOrThrow(origin.seed, ["push", origin.barePath, "main"]);

		const after = await fetchRemote(repo, "origin");
		expect(after.packChecksum).not.toBeNull();
		expect((await gitOrThrow(dir, ["rev-parse", "refs/remotes/origin/main"])).trim()).toBe(
			(await gitOrThrow(origin.seed, ["rev-parse", "main"])).trim(),
		);
		const fetchHead = readFileSync(join(dir, ".git", "FETCH_HEAD"), "utf8");
		expect(fetchHead).toMatch(/^[0-9a-f]{40}\tnot-for-merge\tbranch 'feature' of /m);
		expect(fetchHead).toMatch(/^[0-9a-f]{40}\t\tbranch 'main' of /m);
	});

	test("include-tag delivers annotated tags pointing at fetched history", async () => {
		const origin = await makeOrigin(root, "origin-inctag", server.url);
		const dir = join(root, "clone-inctag");
		const repo = await cloneRepository(origin.url, dir);

		// Drop all local tags, then ask only for the head branch. include-tag
		// should still bring the annotated tag across and record its ref.
		rmSync(join(dir, ".git", "refs", "tags"), { recursive: true, force: true });
		repo.refreshObjectStore();
		expect(repo.resolveRef("refs/tags/v1.0")).toBeNull();

		await fetchRemote(repo, "origin", { refs: ["HEAD", "refs/heads/main"] });
		expect(repo.resolveRef("refs/tags/v1.0")).toBe(
			(await gitOrThrow(origin.barePath, ["rev-parse", "refs/tags/v1.0"])).trim(),
		);
	});

	test("pull fast-forwards the branch and refreshes worktree + index", async () => {
		const origin = await makeOrigin(root, "origin-pull", server.url);
		const dir = join(root, "clone-pull");
		const repo = await cloneRepository(origin.url, dir);

		writeFileSync(join(origin.seed, "pullme.txt"), "pull target\n");
		rmSync(join(origin.seed, "hello.txt"));
		await gitOrThrow(origin.seed, ["add", "."]);
		await gitOrThrow(origin.seed, [...AUTHOR_CONFIG, "commit", "-m", "pull target commit"]);
		await gitOrThrow(origin.seed, ["push", origin.barePath, "main"]);

		expect(await pullRemote(repo, "origin")).toBe("fast-forward");
		expect(readFileSync(join(dir, "pullme.txt"), "utf8")).toBe("pull target\n");
		expect(existsSync(join(dir, "hello.txt"))).toBe(false); // removed upstream -> removed locally
		expect(await pullRemote(repo, "origin")).toBe("up-to-date");
		const statuses = [...repo.status().values()];
		expect(statuses.every((s) => s === "unmodified")).toBe(true);
	});

	test("pull refuses diverged histories without an onMerge seam and delegates with one", async () => {
		const origin = await makeOrigin(root, "origin-diverged", server.url);
		const dir = join(root, "clone-diverged");
		const repo = await cloneRepository(origin.url, dir);

		writeFileSync(join(dir, "local.txt"), "local change\n");
		repo.addToIndex("local.txt");
		repo.commitIndex("local commit", { name: "Fixture Bot", email: "fixture@example.com" });

		writeFileSync(join(origin.seed, "upstream.txt"), "upstream change\n");
		await gitOrThrow(origin.seed, ["add", "."]);
		await gitOrThrow(origin.seed, [...AUTHOR_CONFIG, "commit", "-m", "upstream commit"]);
		await gitOrThrow(origin.seed, ["push", origin.barePath, "main"]);

		await expect(pullRemote(repo, "origin")).rejects.toThrow(/diverged|merge required/i);

		let seamFetchedTip = "";
		const outcome = await pullRemote(repo, "origin", {
			onMerge: ({ fetchedTip }) => {
				seamFetchedTip = fetchedTip;
				return "merged";
			},
		});
		expect(outcome).toBe("merged");
		expect(seamFetchedTip).toBe((await gitOrThrow(origin.barePath, ["rev-parse", "main"])).trim());
	});

	test("push: our-client commit -> push -> fresh real-git clone sees identical content", async () => {
		const origin = await makeOrigin(root, "origin-push", server.url);
		const dir = join(root, "clone-push");
		const repo = await cloneRepository(origin.url, dir);

		writeFileSync(join(dir, "pushed.txt"), "written by pi\n".repeat(100));
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "nested", "deep.txt"), "deep content\n");
		repo.addToIndex("pushed.txt");
		repo.addToIndex(join("nested", "deep.txt"));
		repo.commitIndex("pi-authored commit", { name: "Fixture Bot", email: "fixture@example.com" });

		const result = await pushRemote(repo, "origin");
		expect(result.unpackOk).toBe(true);
		expect(result.results).toEqual([{ refName: "refs/heads/main", ok: true }]);

		expect((await gitRun(origin.barePath, ["fsck", "--strict"])).status).toBe(0);
		const verifyClone = join(root, "verify-after-push");
		await gitOrThrow(root, ["clone", "--no-local", origin.url, verifyClone]);
		expect(readFileSync(join(verifyClone, "pushed.txt"), "utf8")).toBe("written by pi\n".repeat(100));
		expect(readFileSync(join(verifyClone, "nested", "deep.txt"), "utf8")).toBe("deep content\n");
		expect(await gitOrThrow(verifyClone, ["log", "--oneline", "-1"])).toContain("pi-authored commit");

		const second = await cloneRepository(origin.url, join(root, "clone-push-second"));
		expect(second.headCommitSha()).toBe(repo.headCommitSha());
	});

	test("push rejects non-fast-forward without force and succeeds with it", async () => {
		const origin = await makeOrigin(root, "origin-nonff", server.url);
		const dir = join(root, "clone-nonff");
		const repo = await cloneRepository(origin.url, dir);
		const remoteTipBefore = (await gitOrThrow(origin.barePath, ["rev-parse", "main"])).trim();

		await gitOrThrow(dir, ["reset", "--hard", "HEAD~1"]); // rewrite local history
		writeFileSync(join(dir, "rewritten.txt"), "rewritten history\n");
		repo.addToIndex("rewritten.txt");
		repo.commitIndex("rewritten commit", { name: "Fixture Bot", email: "fixture@example.com" });

		await expect(pushRemote(repo, "origin")).rejects.toThrow(/non-fast-forward/i);
		expect((await gitOrThrow(origin.barePath, ["rev-parse", "main"])).trim()).toBe(remoteTipBefore);

		const forced = await pushRemote(repo, "origin", { force: true });
		expect(forced.results[0].ok).toBe(true);
		expect((await gitOrThrow(origin.barePath, ["rev-parse", "main"])).trim()).toBe(repo.headCommitSha()!);
		expect((await gitRun(origin.barePath, ["fsck"])).status).toBe(0);
	});

	test("push deletes a remote ref via delete-refs", async () => {
		const origin = await makeOrigin(root, "origin-delete", server.url);
		const dir = join(root, "clone-delete");
		const repo = await cloneRepository(origin.url, dir);
		const result = await pushRemote(repo, "origin", { refspecs: [":refs/heads/feature"] });
		expect(result.results).toEqual([{ refName: "refs/heads/feature", ok: true }]);
		expect((await gitRun(origin.barePath, ["rev-parse", "--verify", "-q", "refs/heads/feature"])).status).not.toBe(0);
	});

	test("remote add/remove/list persist through GitConfig and stay git-compatible", async () => {
		const dir = join(root, "remote-config");
		const repo = GitRepository.init(dir);
		remoteAdd(repo, "upstream", `${server.url}/anything.git`);
		remoteAdd(repo, "mirror", "https://example.com/mirror.git");
		expect(
			remoteList(repo)
				.map((r) => r.name)
				.sort(),
		).toEqual(["mirror", "upstream"]);
		expect((await gitOrThrow(dir, ["config", "remote.upstream.url"])).trim()).toBe(`${server.url}/anything.git`);
		expect(resolveRemoteSpec(repo, "upstream")).toBe(`${server.url}/anything.git`);

		remoteRemove(repo, "mirror");
		expect(remoteList(repo).map((r) => r.name)).toEqual(["upstream"]);
		expect(() => remoteRemove(repo, "mirror")).toThrow(/no such remote/);
	});

	test("token auth: GIT_TOKEN sent as Basic x-access-token; URL creds override; anonymous 401", async () => {
		server.requireAuth({ user: "bot", pass: "secret" });
		try {
			const origin = await makeOrigin(root, "origin-auth", server.url);
			await expect(cloneRepository(origin.url, join(root, "clone-anon"))).rejects.toBeInstanceOf(GitHttpError);

			const withCreds = await cloneRepository(
				origin.url.replace("://", "://bot:secret@"),
				join(root, "clone-urlcreds"),
			);
			expect(withCreds.config().get("remote.origin.url")).not.toContain("bot:secret"); // stripped from stored URL
			expect(withCreds.headCommitSha()).not.toBeNull();

			process.env.GIT_TOKEN = "secret";
			try {
				const withToken = await cloneRepository(origin.url, join(root, "clone-token"));
				expect(withToken.headCommitSha()).not.toBeNull();
			} finally {
				delete process.env.GIT_TOKEN;
			}
		} finally {
			server.requireAuth(null);
		}
	});
});
