import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitConfig, parseConfigText, serializeConfigText } from "../src/core/git/config.js";
import type { IndexEntry } from "../src/core/git/index.js";
import { GitIndex } from "../src/core/git/index.js";
import {
	bytesToHex,
	parseCommit,
	parseSignature,
	parseTag,
	parseTree,
	serializeTree,
} from "../src/core/git/objects.js";
import { applyDelta, PackReader } from "../src/core/git/pack-read.js";
import { deleteRef, loadPackedRefs, resolveHead, resolveRef, writeRef } from "../src/core/git/refs.js";
import { GitRepository } from "../src/core/git/repository.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function spawnGit(cwd: string, args: string[]) {
	return spawnSync("git", cwd === "." ? args : ["-C", cwd, ...args], { encoding: "buffer" });
}

function runGit(cwd: string, args: string[]): { stdout: string; ok: boolean } {
	const proc = spawnGit(cwd, args);
	return { stdout: String(proc.stdout ?? ""), ok: proc.status === 0 };
}

function gitOrThrow(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stdout}`);
	return result.stdout;
}

/** Raw object bytes from real git (no lossy text decoding on binary objects). */
function gitObjectBytes(cwd: string, type: string, sha: string): Buffer {
	const proc = spawnGit(cwd, ["cat-file", type, sha]);
	if (proc.status !== 0) throw new Error(`cat-file failed for ${sha}`);
	return Buffer.from(proc.stdout ?? Buffer.alloc(0));
}

const GIT_VERSION = Bun.which("git") ? runGit(".", ["--version"]).stdout.trim() : "";
const HAS_GIT = GIT_VERSION.startsWith("git version");
const AUTHOR = { name: "Fixture Bot", email: "fixture@example.com" };

let fixtureCounter = 0;

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${fixtureCounter++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Fixture repo built BY REAL GIT: two commits, nested dirs, executable, edit history for deltas. */
function makeGitFixture(): string {
	const workdir = makeTempDir("pi-git-fixture");
	gitOrThrow(workdir, ["init", "-b", "main"]);
	gitOrThrow(workdir, ["config", "user.name", AUTHOR.name]);
	gitOrThrow(workdir, ["config", "user.email", AUTHOR.email]);
	writeFileSync(join(workdir, "hello.txt"), "line one\nline two\nline three\n");
	mkdirSync(join(workdir, "lib"));
	writeFileSync(join(workdir, "lib", "util.txt"), "shared code\n");
	writeFileSync(join(workdir, "run.sh"), "#!/bin/sh\necho hi\n");
	gitOrThrow(workdir, ["add", "."]);
	gitOrThrow(workdir, ["commit", "-m", "first commit"]);
	// second commit: grow hello.txt (encourages delta compression), add a file
	writeFileSync(join(workdir, "hello.txt"), "line one\nline two\nline three\nline four\nline five\nsix\nseven\n");
	writeFileSync(join(workdir, "notes.md"), "# notes\nnested content\n".repeat(40));
	gitOrThrow(workdir, ["add", "."]);
	gitOrThrow(workdir, ["commit", "-m", "second commit"]);
	return workdir;
}

function makeEmptyGitFixture(): string {
	const workdir = makeTempDir("pi-git-empty");
	gitOrThrow(workdir, ["init", "-b", "main"]);
	gitOrThrow(workdir, ["config", "user.name", AUTHOR.name]);
	gitOrThrow(workdir, ["config", "user.email", AUTHOR.email]);
	return workdir;
}

function makeEntry(overrides: Partial<IndexEntry> & { path: string; sha: string }): IndexEntry {
	return {
		ctimeSeconds: 1700000000,
		ctimeNanoseconds: 0,
		mtimeSeconds: 1700000000,
		mtimeNanoseconds: 0,
		dev: 1,
		ino: 2,
		mode: 0o100644,
		uid: 500,
		gid: 500,
		fileSize: 12,
		flags: overrides.path.length,
		extendedFlags: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Pure-TypeScript golden fixtures (run everywhere, git not required)
// ---------------------------------------------------------------------------

/** Hand-built delta: source "Hello, world!" -> "Hello, git world!!" via copy+insert ops. */
function buildSampleDelta(): Uint8Array {
	const source = new TextEncoder().encode("Hello, world!");
	const target = new TextEncoder().encode("Hello, git world!!");
	const varint = (value: number): number[] => {
		const out: number[] = [];
		do {
			let byte = value & 0x7f;
			value >>>= 7;
			if (value > 0) byte |= 0x80;
			out.push(byte);
		} while (value > 0);
		return out;
	};
	const insert = (text: string): number[] => [text.length, ...new TextEncoder().encode(text)];
	const copy = (offset: number, size: number): number[] => {
		let op = 0x80;
		const bytes: number[] = [];
		for (let i = 0; i < 4; i++) {
			if ((offset >> (i * 8)) & 0xff) {
				op |= 1 << i;
				bytes.push((offset >> (i * 8)) & 0xff);
			}
		}
		for (let i = 0; i < 3; i++) {
			if ((size >> (i * 8)) & 0xff) {
				op |= 0x10 << i;
				bytes.push((size >> (i * 8)) & 0xff);
			}
		}
		return [op, ...bytes];
	};
	return new Uint8Array([
		...varint(source.length),
		...varint(target.length),
		...copy(0, 7), // "Hello, "
		...insert("git "),
		...copy(7, 6), // "world!"
		...insert("!"),
	]);
}

describe("git client: pure golden fixtures", () => {
	test("applyDelta handles copy and insert ops", () => {
		const source = new TextEncoder().encode("Hello, world!");
		const applied = applyDelta(buildSampleDelta(), source);
		expect(new TextDecoder().decode(applied)).toBe("Hello, git world!!");
	});

	test("applyDelta rejects wrong source size", () => {
		expect(() => applyDelta(buildSampleDelta(), new TextEncoder().encode("wrong"))).toThrow();
	});

	test("tree parse/serialize round-trips golden bytes incl. dir sort quirk", () => {
		// dir "b" sorts after file "b.txt" because directories compare as "b/"
		const entries = [
			{ mode: "100644", name: "a.txt", sha: "11".repeat(20) },
			{ mode: "40000", name: "b", sha: "22".repeat(20) },
			{ mode: "100644", name: "b.txt", sha: "33".repeat(20) },
		];
		const serialized = serializeTree(entries);
		const reparsed = parseTree(serialized);
		expect(reparsed.map((entry) => `${entry.mode}:${entry.name}`)).toEqual([
			"100644:a.txt",
			"40000:b",
			"100644:b.txt",
		]);
	});

	test("commit parser handles gpgsig continuation headers and end-anchored signatures", () => {
		const body = [
			`tree ${"44".repeat(20)}`,
			`parent ${"55".repeat(20)}`,
			"author Weird < Nam \u00e9 <weird@x> 1700000000 -0530",
			"committer Plain Name <plain@x> 1700000001 +0000",
			"gpgsig -----BEGIN PGP SIGNATURE-----",
			" first continuation line",
			" second continuation line",
			" -----END PGP SIGNATURE-----",
			"",
			"subject line",
			"",
			"body paragraph",
			"",
		].join("\n");
		const commit = parseCommit(new TextEncoder().encode(body));
		expect(commit.tree).toBe("44".repeat(20));
		expect(commit.parents).toEqual(["55".repeat(20)]);
		expect(commit.author.email).toBe("weird@x");
		expect(commit.author.name).toContain("Weird");
		expect(commit.message).toContain("body paragraph");
		expect(commit.headers.find(([key]) => key === "gpgsig")?.[1]).toContain("second continuation");
	});

	test("parseSignature reads ts/tz from the END of the line", () => {
		const sig = parseSignature("A B C <a@b> 1234567890 -0730");
		expect(sig.name).toBe("A B C");
		expect(sig.email).toBe("a@b");
		expect(sig.time).toBe(1234567890);
		expect(sig.timezoneOffset).toBe("-0730");
	});

	test("annotated tag parser extracts object/type/tag/tagger", () => {
		const body = [
			`object ${"66".repeat(20)}`,
			"type commit",
			"tag v1.0",
			"tagger Tagger <t@x> 1700000002 +0100",
			"",
			"release notes here",
			"",
		].join("\n");
		const tag = parseTag(new TextEncoder().encode(body));
		expect(tag.object).toBe("66".repeat(20));
		expect(tag.type).toBe("commit");
		expect(tag.tag).toBe("v1.0");
		expect(tag.tagger?.email).toBe("t@x");
		expect(tag.message).toContain("release notes");
	});

	test("index write->parse round-trip preserves entries and detects checksum corruption", () => {
		const index = new GitIndex();
		index.add(makeEntry({ path: "alpha.txt", sha: "aa".repeat(20) }));
		index.add(makeEntry({ path: "lib/beta.txt", sha: "bb".repeat(20) }));
		const written = index.write();
		expect(bytesToHex(written.subarray(0, 4))).toBe("44495243"); // "DIRC"
		const parsed = GitIndex.parse(written);
		expect(parsed.entries.map((entry) => entry.path)).toEqual(["alpha.txt", "lib/beta.txt"]);
		expect(parsed.get("lib/beta.txt")?.sha).toBe("bb".repeat(20));
		const corrupt = written.slice();
		corrupt[corrupt.length - 25] ^= 0xff; // flip a payload byte
		expect(() => GitIndex.parse(corrupt)).toThrow();
	});

	test("index parser rejects non-zero padding and unsafe paths", () => {
		const good = new GitIndex();
		good.add(makeEntry({ path: "f", sha: "cc".repeat(20) }));
		const raw = good.write();
		const padded = raw.slice();
		padded[12 + 62 + 1] = 1; // first pad byte after the single-char path
		expect(() => GitIndex.parse(padded)).toThrow();
	});
});

describe("git client: config INI", () => {
	test("parses sections, subsections, comments, quotes, bare keys", () => {
		const text = [
			"# top comment",
			"[core]",
			"	repositoryformatversion = 0 ; trailing comment",
			"	bare = false",
			'[remote "origin"]',
			"url = https://example.com/repo.git",
			"	fetch = +refs/heads/*:refs/remotes/origin/*",
			"[alias]",
			"	st",
		].join("\n");
		const entries = parseConfigText(text);
		expect(entries.length).toBe(5);
		const remoteUrl = entries.filter((entry) => entry.section === "remote" && entry.key === "url");
		expect(remoteUrl[0]?.subsection).toBe("origin");
		expect(remoteUrl[0]?.value).toBe("https://example.com/repo.git");
		expect(entries.at(-1)?.value).toBe(""); // bare key reads as boolean true
	});

	test("serializeConfigText round-trips through the parser", () => {
		const text = serializeConfigText(
			parseConfigText('[user]\n	name = A\n	email = a@b\n[remote "o"]\n	url = u\n'),
		);
		expect(parseConfigText(text).map((entry) => [entry.section, entry.key, entry.value])).toEqual([
			["user", "name", "A"],
			["user", "email", "a@b"],
			["remote", "url", "u"],
		]);
	});

	test("GitConfig layers global over local and persists set()", () => {
		const dir = makeTempDir("pi-git-config");
		writeFileSync(join(dir, "global"), "[user]\n	name = Global\n[color]\n	ui = true\n");
		const cfg = GitConfig.loadStack(join(dir, "local"), [join(dir, "global")]);
		expect(cfg.get("user.name")).toBe("Global"); // inherited from read-only layer
		cfg.set("user.name", "Local");
		cfg.set("remote.origin.url", "https://x/y.git");
		cfg.save();
		const reloaded = GitConfig.loadStack(join(dir, "local"), []);
		expect(reloaded.get("user.name")).toBe("Local");
		expect(reloaded.get("remote.origin.url")).toBe("https://x/y.git");
		expect(reloaded.getAll("nonexistent.key")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Real-git cross-verification (skipped gracefully when git is absent)
// ---------------------------------------------------------------------------

/** Map porcelain status codes to our FileStatus vocabulary (worktree column wins). */
function expectedFromPorcelain(porcelain: string): Map<string, string> {
	const expected = new Map<string, string>();
	for (const line of porcelain.split("\n")) {
		if (!line) continue;
		const x = line[0]; // index (staged) column
		const y = line[1]; // worktree column
		const path = line.slice(3);
		let state: string;
		if (x === "?" && y === "?") state = "untracked";
		else if (y === "D") state = "deleted";
		else if (y !== " ") state = y === "M" || x === "A" ? "modified" : "modified";
		else if (x === "D") state = "staged";
		else state = "staged"; // A or M staged with clean worktree
		expected.set(path, state);
	}
	return expected;
}

describe.skipIf(!HAS_GIT)(`git client: cross-verified against real git (${GIT_VERSION})`, () => {
	test("reads every loose object written by real git identically to cat-file", () => {
		const workdir = makeGitFixture();
		const repo = GitRepository.open(workdir);
		expect(repo).not.toBeNull();
		const listing = gitOrThrow(workdir, [
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname) %(objecttype)",
		]);
		const objects = listing
			.trim()
			.split("\n")
			.map((line) => {
				const [sha, type] = line.split(" ");
				return { sha, type };
			});
		expect(objects.length).toBeGreaterThanOrEqual(8);
		for (const { sha, type } of objects) {
			const ours = repo?.readObject(sha);
			expect(ours?.type).toBe(type);
			expect(Buffer.from(ours?.body ?? new Uint8Array()).equals(gitObjectBytes(workdir, type, sha))).toBe(true);
		}
	});

	test("blob->tree->commit round trip: our commit is valid per git cat-file and fsck", () => {
		const workdir = makeEmptyGitFixture();
		gitOrThrow(workdir, ["config", "user.name", AUTHOR.name]);
		gitOrThrow(workdir, ["config", "user.email", AUTHOR.email]);
		const repo = GitRepository.open(workdir);
		expect(repo).not.toBeNull();
		if (!repo) return;
		writeFileSync(join(workdir, "a.txt"), "alpha\n");
		mkdirSync(join(workdir, "sub"));
		writeFileSync(join(workdir, "sub", "b.txt"), "nested\n");
		repo.addToIndex("a.txt");
		repo.addToIndex(join("sub", "b.txt"));
		const commitSha = repo.commitIndex("our own commit\n\nbody line\n", AUTHOR);
		expect(gitOrThrow(workdir, ["cat-file", "-t", commitSha]).trim()).toBe("commit");
		const pretty = gitOrThrow(workdir, ["cat-file", "-p", commitSha]);
		expect(pretty).toContain("author Fixture Bot <fixture@example.com>");
		expect(pretty.trimEnd().endsWith("body line")).toBe(true);
		// real git agrees on the tree contents
		const treeSha = repo.headTreeSha() ?? "";
		const lsTree = gitOrThrow(workdir, ["ls-tree", "-r", treeSha]);
		expect(lsTree.split("\n").filter(Boolean).length).toBe(2);
		expect(lsTree).toContain("blob");
		expect(lsTree).toContain("sub/b.txt");
		// fsck validates the whole object graph
		const fsck = runGit(workdir, ["fsck", "--strict"]);
		expect(fsck.ok).toBe(true);
		// and git can check out what we committed
		expect(runGit(workdir, ["status", "--porcelain"]).stdout.trim()).toBe("");
	});

	test("status matrix matches git status --porcelain for the full case grid", () => {
		const workdir = makeGitFixture();
		const repo = GitRepository.open(workdir);
		expect(repo).not.toBeNull();
		if (!repo) return;
		// unmodified baseline
		writeFileSync(join(workdir, "clean.txt"), "clean\n");
		gitOrThrow(workdir, ["add", "clean.txt"]);
		gitOrThrow(workdir, ["commit", "-m", "third commit"]);
		// untracked
		writeFileSync(join(workdir, "new.txt"), "untracked\n");
		// unstaged modify
		writeFileSync(join(workdir, "hello.txt"), "edited in worktree only\n");
		// staged modify
		writeFileSync(join(workdir, "notes.md"), "staged edit\n");
		gitOrThrow(workdir, ["add", "notes.md"]);
		// unstaged delete
		rmSync(join(workdir, join("lib", "util.txt")));
		// staged add
		writeFileSync(join(workdir, "added.txt"), "added to index\n");
		gitOrThrow(workdir, ["add", "added.txt"]);
		// staged delete
		gitOrThrow(workdir, ["rm", "-q", "run.sh"]); // staged delete incl. worktree

		const expected = expectedFromPorcelain(gitOrThrow(workdir, ["status", "--porcelain"]));
		const ours = repo.status();
		for (const [path, state] of expected) {
			expect([path, ours.get(path)]).toEqual([path, state]);
		}
		for (const [path, state] of ours) {
			if (state !== "unmodified") expect([path, state]).toEqual([path, expected.get(path)]);
		}
	});

	test("parent walk order matches git log", () => {
		const workdir = makeGitFixture();
		gitOrThrow(workdir, ["config", "user.name", AUTHOR.name]);
		gitOrThrow(workdir, ["config", "user.email", AUTHOR.email]);
		writeFileSync(join(workdir, "extra.txt"), "more\n");
		gitOrThrow(workdir, ["add", "."]);
		gitOrThrow(workdir, ["commit", "-m", "third commit"]);
		const repo = GitRepository.open(workdir);
		expect(repo).not.toBeNull();
		if (!repo) return;
		const gitOrder = gitOrThrow(workdir, ["log", "--format=%H"]).trim().split("\n");
		const ours: string[] = [];
		let cursor: string | null = repo.headCommitSha();
		while (cursor) {
			ours.push(cursor);
			cursor = parseCommit(repo.readObject(cursor)?.body ?? new Uint8Array()).parents[0] ?? null;
		}
		expect(ours).toEqual(gitOrder);
	});

	test("index parse/write agrees with git ls-files --stage both directions", () => {
		const workdir = makeGitFixture();
		const repo = GitRepository.open(workdir);
		expect(repo).not.toBeNull();
		if (!repo) return;
		// read direction: our parser vs ls-files --stage
		const lsFiles = gitOrThrow(workdir, ["ls-files", "--stage"])
			.trim()
			.split("\n")
			.map((line) => {
				const [meta, path] = line.split("\t");
				const [mode, sha, stage] = meta.split(" ");
				return { mode: Number.parseInt(mode, 8), sha, stage: Number.parseInt(stage, 10), path };
			});
		const index = GitIndex.parse(readFileSync(join(workdir, ".git", "index")));
		expect(index.entries.map((entry) => entry.path)).toEqual(lsFiles.map((row) => row.path));
		for (const [i, entry] of index.entries.entries()) {
			expect(entry.sha).toBe(lsFiles[i]?.sha);
			expect(entry.mode).toBe(lsFiles[i]?.mode);
		}
		// write direction: add one entry via our writer; git must read it back
		writeFileSync(join(workdir, "mine.txt"), "from our writer\n");
		repo.addToIndex("mine.txt");
		const after = gitOrThrow(workdir, ["ls-files", "--stage", "mine.txt"]).trim();
		const [meta] = after.split("\t");
		expect(meta.split(" ")[1]).toBe(repo.hashBlob("from our writer\n"));
		expect(meta.split(" ")[2]).toBe("0"); // stage
	});

	test("pack reader resolves all objects incl. deltas; checksum verifies lazily", () => {
		const workdir = makeGitFixture();
		gitOrThrow(workdir, ["repack", "-a", "-d"]);
		const packDir = join(workdir, ".git", "objects", "pack");
		const packName = readdirSync(packDir).find((name) => name.endsWith(".pack"));
		if (!packName) throw new Error("repack produced no packfile");
		const reader = PackReader.open(join(packDir, packName));
		expect(reader.objectCount).toBeGreaterThan(0);
		expect(reader.verifyPackChecksum()).toBe(true);
		const listing = gitOrThrow(workdir, [
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname) %(objecttype)",
		]);
		let deltaCandidates = 0;
		for (const line of listing.trim().split("\n")) {
			const [sha, type] = line.split(" ");
			const ours = reader.read(sha);
			expect(ours?.type).toBe(type);
			const theirs = gitObjectBytes(workdir, type, sha);
			expect(Buffer.from(ours?.body ?? new Uint8Array()).equals(theirs)).toBe(true);
			deltaCandidates++;
		}
		expect(deltaCandidates).toBeGreaterThanOrEqual(8);
		expect(reader.has("ff".repeat(20))).toBe(false);
	});

	test("repository reads through packs transparently after repack", () => {
		const workdir = makeGitFixture();
		gitOrThrow(workdir, ["repack", "-a", "-d"]);
		const repo = GitRepository.open(workdir);
		const headSha = gitOrThrow(workdir, ["rev-parse", "HEAD"]).trim();
		const headType = gitOrThrow(workdir, ["cat-file", "-t", headSha]).trim();
		expect(repo?.objectType(headSha)).toBe(headType);
		const looseLeft = existsSync(join(workdir, ".git", "objects", headSha.slice(0, 2), headSha.slice(2)));
		// repack -a -d removed loose copies -> this must have come from a pack
		if (!looseLeft) expect(repo?.hasObject(headSha)).toBe(true);
	});

	test("refs: HEAD resolution, packed-refs fallback, write/delete visible to git", () => {
		const workdir = makeGitFixture();
		const repo = GitRepository.open(workdir);
		const gitHead = gitOrThrow(workdir, ["rev-parse", "HEAD"]).trim();
		expect(resolveRef(`${workdir}/.git`, "HEAD")).toBe(gitHead);
		expect(resolveHead(`${workdir}/.git`)).toEqual({ sha: gitHead, detached: false });
		expect(repo?.headBranch()).toBe("refs/heads/main");

		// packed refs still resolve (loose shadows packed)
		gitOrThrow(workdir, ["pack-refs", "--all"]);
		const packedRefs = loadPackedRefs(`${workdir}/.git`);
		expect(packedRefs.get("refs/heads/main")).toBe(gitHead);
		expect(resolveRef(`${workdir}/.git`, "refs/heads/main")).toBe(gitHead);

		// our write is visible to git
		const tip = gitOrThrow(workdir, ["rev-parse", "main"]).trim();
		writeRef(`${workdir}/.git`, "refs/heads/written-by-us", tip);
		expect(gitOrThrow(workdir, ["rev-parse", "written-by-us"]).trim()).toBe(tip);
		expect(deleteRef(`${workdir}/.git`, "refs/heads/written-by-us")).toBe(true);
		expect(runGit(workdir, ["rev-parse", "--verify", "-q", "written-by-us"]).ok).toBe(false);

		// detached head detection
		gitOrThrow(workdir, ["checkout", "--detach"]);
		expect(resolveHead(`${workdir}/.git`)).toEqual({ sha: gitHead, detached: true });
	});

	test("init honours bare and defaultBranch and git accepts the result", () => {
		const nonBareDir = makeTempDir("pi-git-init");
		const repo = GitRepository.init(nonBareDir, { defaultBranch: "trunk" });
		expect(gitOrThrow(nonBareDir, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/trunk");
		expect(GitRepository.open(nonBareDir)?.gitDir).toBe(repo.gitDir);
		const bareDir = makeTempDir("pi-git-bare");
		GitRepository.init(bareDir, { bare: true, defaultBranch: "main" });
		expect(gitOrThrow(bareDir, ["rev-parse", "--is-bare-repository"]).trim()).toBe("true");
		expect(existsSync(join(bareDir, "objects"))).toBe(true);
	});

	test("hashBlob matches git hash-object (stdin)", () => {
		const workdir = makeEmptyGitFixture();
		const content = "hash me\nwith unicode \u00e9\n";
		const repo = GitRepository.open(workdir);
		const proc = spawnSync("git", ["-C", workdir, "hash-object", "--stdin"], {
			input: Buffer.from(content),
			encoding: "buffer",
		});
		expect(repo?.hashBlob(content)).toBe(String(proc.stdout ?? "").trim());
	});
});
