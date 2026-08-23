import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GitConfig } from "./config.js";
import { flatIndex, flatTree, readWorktreeBytes, type TreeFile, writeTreeFromFiles } from "./diff.js";
import type { IndexEntry } from "./index.js";
import { entryStage, GitIndex } from "./index.js";
import type { GitObjectType, ParsedCommit, RawObject } from "./objects.js";
import { hashRawObject, parseCommit, readLooseObject, serializeCommit, writeLooseObject } from "./objects.js";
import { PackReader } from "./pack-read.js";
import { headRefName, refExists, resolveHead, resolveRef, writeRef } from "./refs.js";

// ---------------------------------------------------------------------------
// Git-style exclusive lockfile protocol (spec §3.5): create "<path>.lock" with
// O_CREAT|O_EXCL, write, fsync, rename onto the target. A fresh lock held by
// someone else refuses after a short retry; a stale lock (older than
// LOCK_STALE_MS) is taken over, matching git's practice for crashed writers.
// Readers never look at the lock file.
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 100;

export class LockBusyError extends Error {
	constructor(readonly lockPath: string) {
		super(`could not acquire ${lockPath}: locked by another process`);
	}
}

function lockAgeMs(path: string): number {
	return Date.now() - statSync(path).mtimeMs;
}

/**
 * Run fn() while holding "<path>.lock"; its return value is passed through.
 * A competing fresh lock gets one short retry window before refusing.
 */
function withLock<T>(targetPath: string, fn: () => T): T {
	const lockPath = `${targetPath}.lock`;
	if (!existsSync(dirname(lockPath))) mkdirSync(dirname(lockPath), { recursive: true });
	for (;;) {
		let fd: number;
		try {
			fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
		} catch {
			if (!existsSync(lockPath)) throw new Error(`cannot create lock ${lockPath}`);
			if (lockAgeMs(lockPath) > LOCK_STALE_MS) {
				unlinkSync(lockPath); // crashed writer; take over
				continue;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
			throw new LockBusyError(lockPath);
		}
		try {
			fsyncSync(fd);
			return fn();
		} finally {
			closeSync(fd);
			unlinkSync(lockPath);
		}
	}
}

/** Serialize bytes to targetPath under the git lock protocol (write temp, fsync, rename). */
function writeFileLocked(targetPath: string, data: Uint8Array): void {
	withLock(targetPath, () => {
		const tmp = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, targetPath);
	});
}

/**
 * A working repository handle: object database (loose + packs), refs, index,
 * commit plumbing and a HEAD-vs-index-vs-worktree status matrix.
 */

export type FileStatus = "unmodified" | "staged" | "modified" | "untracked" | "deleted";

export interface CommitSpec {
	tree: string;
	parents: string[];
	message: string;
	author: GitSignatureLike;
	committer?: GitSignatureLike;
}

export interface GitSignatureLike {
	name: string;
	email: string;
	/** Unix seconds; defaults to now. */
	time?: number;
	/** e.g. "+0200"; defaults to UTC. */
	timezoneOffset?: string;
}

const DEFAULT_CONFIG = [
	"[core]",
	"	repositoryformatversion = 0",
	"	filemode = true",
	"	bare = false",
	"	logallrefupdates = true",
].join("\n");

export class GitRepository {
	private packReaders: PackReader[] | null = null;

	private constructor(
		readonly workdir: string,
		readonly gitDir: string,
	) {}

	/** Walk up from startDir until a .git directory/file is found. Returns null outside a repo. */
	static open(startDir: string): GitRepository | null {
		let current = resolve(startDir);
		for (;;) {
			const dotGit = join(current, ".git");
			if (!existsSync(dotGit)) {
				const parent = dirname(current);
				if (parent === current) return null;
				current = parent;
				continue;
			}
			if (lstatSync(dotGit).isDirectory()) return new GitRepository(current, dotGit);
			const pointer = readFileSync(dotGit, "utf8").trim();
			if (!pointer.startsWith("gitdir:")) throw new Error(`malformed .git file: ${pointer}`);
			return new GitRepository(current, resolve(current, pointer.slice("gitdir:".length).trim()));
		}
	}

	static init(dir: string, options?: { bare?: boolean; defaultBranch?: string }): GitRepository {
		const bare = options?.bare ?? false;
		const branch = options?.defaultBranch ?? "main";
		const gitDir = bare ? resolve(dir) : join(resolve(dir), ".git");
		if (existsSync(join(gitDir, "HEAD"))) throw new Error(`repository already exists at ${gitDir}`);
		for (const sub of ["objects/info", "objects/pack", "refs/heads", "refs/tags"]) {
			mkdirSync(join(gitDir, sub), { recursive: true });
		}
		writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
		writeFileSync(join(gitDir, "config"), `${DEFAULT_CONFIG.replace("bare = false", `bare = ${String(bare)}`)}\n`);
		writeFileSync(
			join(gitDir, "description"),
			"Unnamed repository; edit this file 'description' to name the repository.\n",
		);
		return new GitRepository(bare ? gitDir : dirname(gitDir), gitDir);
	}

	// -- Object database ------------------------------------------------------

	readObject(sha: string): RawObject | null {
		const loose = readLooseObject(this.gitDir, sha);
		if (loose) return loose;
		if (this.packReaders === null) this.packReaders = this.loadPacks();
		for (const reader of this.packReaders) {
			const packed = reader.read(sha);
			if (packed) return packed;
		}
		return null;
	}

	objectType(sha: string): GitObjectType | null {
		return this.readObject(sha)?.type ?? null;
	}

	hasObject(sha: string): boolean {
		return this.readObject(sha) !== null;
	}

	/** All object ids in the store (loose + packed), optionally filtered. */
	listObjectIds(filter?: (id: string) => boolean): string[] {
		const ids: string[] = [];
		const objectsDir = join(this.gitDir, "objects");
		for (const bucket of listDirs(objectsDir)) {
			if (!/^[0-9a-f]{2}$/.test(bucket)) continue;
			for (const rest of readdirSync(join(objectsDir, bucket))) {
				if (/^[0-9a-f]{38}$/.test(rest)) ids.push(bucket + rest);
			}
		}
		if (this.packReaders === null) this.packReaders = this.loadPacks();
		for (const reader of this.packReaders) {
			ids.push(...reader.objectIds());
		}
		return filter === undefined ? ids : ids.filter(filter);
	}

	/** Drop cached pack readers so freshly written/fetched packs become visible (used by network ops). */
	refreshObjectStore(): void {
		this.packReaders = null;
	}

	private loadPacks(): PackReader[] {
		const packDir = join(this.gitDir, "objects", "pack");
		if (!existsSync(packDir)) return [];
		const readers: PackReader[] = [];
		for (const name of readdirSync(packDir)) {
			if (name.endsWith(".pack")) readers.push(PackReader.open(join(packDir, name)));
		}
		return readers;
	}

	hashBlob(data: Uint8Array | string): string {
		return hashRawObject("blob", encodeMaybeString(data));
	}

	writeBlob(data: Uint8Array | string): string {
		return writeLooseObject(this.gitDir, "blob", encodeMaybeString(data));
	}

	// -- Refs -----------------------------------------------------------------

	headBranch(): string | null {
		return headRefName(this.gitDir);
	}

	resolveHead(): { sha: string | null; detached: boolean } {
		return resolveHead(this.gitDir);
	}

	resolveRef(refName: string): string | null {
		return resolveRef(this.gitDir, refName);
	}

	updateRef(refName: string, sha: string): void {
		writeRef(this.gitDir, refName, sha);
	}

	// -- Index ----------------------------------------------------------------

	loadIndex(): GitIndex {
		try {
			return GitIndex.parse(readFileSync(join(this.gitDir, "index")));
		} catch {
			return new GitIndex();
		}
	}

	saveIndex(index: GitIndex): void {
		writeFileLocked(join(this.gitDir, "index"), index.write());
	}

	/** Build an index entry from a worktree file's stat data plus an already-computed blob sha. */
	makeIndexEntry(relPath: string, sha: string): IndexEntry {
		const stats = lstatSync(join(this.workdir, relPath));
		const mode = stats.isSymbolicLink() ? MODE_SYMLINK : stats.isFile() && stats.mode & 0o100 ? MODE_EXEC : MODE_FILE;
		const pathLength = Buffer.byteLength(relPath, "utf8");
		if (pathLength >= 0xfff) throw new Error(`path too long for index v2: ${relPath}`);
		assertSafeIndexPath(relPath);
		return {
			ctimeSeconds: Math.floor(stats.ctimeMs / 1000),
			ctimeNanoseconds: (stats.ctimeMs % 1000) * 1e6,
			mtimeSeconds: Math.floor(stats.mtimeMs / 1000),
			mtimeNanoseconds: (stats.mtimeMs % 1000) * 1e6,
			dev: stats.dev,
			ino: stats.ino,
			mode,
			uid: stats.uid,
			gid: stats.gid,
			fileSize: stats.size,
			sha,
			flags: pathLength,
			extendedFlags: 0,
			path: relPath,
		};
	}

	/**
	 * Index entry for a conflicted stage (1/2/3): uses worktree stat data when
	 * the file exists; modify/delete conflicts leave no worktree file, so those
	 * entries carry zeroed stat data like git does.
	 */
	makeStageIndexEntry(relPath: string, sha: string, stage: number): IndexEntry {
		const pathLength = Buffer.byteLength(relPath);
		if (pathLength >= 0xfff) throw new Error(`path too long for index v2: ${relPath}`);
		assertSafeIndexPath(relPath);
		let entry: IndexEntry;
		try {
			entry = this.makeIndexEntry(relPath, sha);
		} catch {
			entry = {
				ctimeSeconds: 0,
				ctimeNanoseconds: 0,
				mtimeSeconds: 0,
				mtimeNanoseconds: 0,
				dev: 0,
				ino: 0,
				mode: MODE_FILE,
				uid: 0,
				gid: 0,
				fileSize: 0,
				sha,
				flags: Math.min(pathLength, 0xfff),
				extendedFlags: 0,
				path: relPath,
			};
		}
		entry.flags = (Buffer.byteLength(relPath) & 0xfff) | (stage << 12);
		return entry;
	}

	/** Hash a worktree file, store its blob loose, and upsert its stage-0 index entry. */
	addToIndex(relPath: string): void {
		const content = readWorktreeBytes(this.workdir, relPath);
		const index = this.loadIndex();
		index.add(this.makeIndexEntry(relPath, writeLooseObject(this.gitDir, "blob", content)));
		this.saveIndex(index);
	}

	removeFromIndex(relPath: string): boolean {
		const index = this.loadIndex();
		if (!index.remove(relPath)) return false;
		this.saveIndex(index);
		return true;
	}

	// -- Commits ---------------------------------------------------------------

	/** Write a commit object and point the current branch (or HEAD when detached) at it. */
	commit(spec: CommitSpec): string {
		const time = spec.author.time ?? Math.floor(Date.now() / 1000);
		const author = normalizeSignature(spec.author, time);
		const committer = spec.committer ? normalizeSignature(spec.committer, time) : author;
		const sha = writeLooseObject(
			this.gitDir,
			"commit",
			serializeCommit({ tree: spec.tree, parents: spec.parents, author, committer, message: spec.message }),
		);
		writeRef(this.gitDir, headRefName(this.gitDir) ?? "HEAD", sha);
		return sha;
	}

	headCommitSha(): string | null {
		return this.resolveHead().sha;
	}

	headTreeSha(): string | null {
		const head = this.headCommitSha();
		return head === null ? null : this.parseCommitAt(head).tree;
	}

	/** Parse the commit object at sha; throws when the object is absent or not a commit. */
	parseCommitAt(sha: string): ParsedCommit {
		const raw = this.readObject(sha);
		if (raw === null || raw.type !== "commit") throw new Error(`not a commit: ${sha}`);
		return parseCommit(raw.body);
	}

	/** Tree sha of the commit object at sha. */
	commitTree(sha: string): string {
		return this.parseCommitAt(sha).tree;
	}

	/** Flatten HEAD's tree into path -> blob sha. Returns null before the first commit. */
	flatHeadTree(): Map<string, string> | null {
		const treeSha = this.headTreeSha();
		if (treeSha === null) return null;
		const files = new Map<string, string>();
		for (const [path, file] of flatTree(this, treeSha)) files.set(path, file.sha);
		return files;
	}

	/** Write tree objects covering all stage-0 index entries; returns the root tree sha. */
	writeTreeFromIndex(): string {
		const files = new Map<string, TreeFile>();
		for (const entry of this.loadIndex().entries) {
			if (entryStage(entry) !== 0) continue;
			files.set(entry.path, { mode: entry.mode.toString(8), sha: entry.sha });
		}
		return writeTreeFromFiles(this, files);
	}

	/** Stage everything currently in the index as one commit on top of HEAD. */
	commitIndex(message: string, author: GitSignatureLike): string {
		const parent = this.headCommitSha();
		return this.commit({
			tree: this.writeTreeFromIndex(),
			parents: parent === null ? [] : [parent],
			message,
			author,
		});
	}

	// -- Status ---------------------------------------------------------------

	/**
	 * Classify every known path. Precedence: worktree divergence wins over staged
	 * divergence, so a file differing from both HEAD and index reports "modified".
	 * Staged deletions report "staged"; unstaged deletions report "deleted".
	 */
	status(): Map<string, FileStatus> {
		const statuses = new Map<string, FileStatus>();
		const headFiles = this.flatHeadTree() ?? new Map<string, string>();
		const indexFiles = flatIndex(this.loadIndex().entries);
		const worktreeFiles = this.listWorktreeFiles();
		const paths = new Set<string>([...headFiles.keys(), ...indexFiles.keys(), ...worktreeFiles]);
		for (const path of paths) {
			const headSha = headFiles.get(path);
			const entry = indexFiles.get(path);
			const inWorktree = worktreeFiles.includes(path);
			if (!entry) {
				statuses.set(path, !headSha && inWorktree ? "untracked" : "staged");
				continue;
			}
			if (!inWorktree) {
				statuses.set(path, "deleted");
				continue;
			}
			const worktreeSha = hashRawObject("blob", readWorktreeBytes(this.workdir, path));
			if (!headSha || headSha !== entry.sha) {
				statuses.set(path, worktreeSha === entry.sha ? "staged" : "modified");
			} else if (worktreeSha !== entry.sha) {
				statuses.set(path, "modified");
			} else {
				statuses.set(path, "unmodified");
			}
		}
		return statuses;
	}

	listWorktreeFiles(): string[] {
		const files: string[] = [];
		const visit = (dir: string): void => {
			for (const name of readdirSync(dir)) {
				if (name === ".git") continue;
				const absolute = join(dir, name);
				const stats = lstatSync(absolute);
				if (stats.isDirectory()) visit(absolute);
				else if (stats.isFile()) files.push(relative(this.workdir, absolute).split("\\").join("/"));
			}
		};
		visit(this.workdir);
		return files.sort();
	}

	/**
	 * Revision resolution for the shapes agents actually type: HEAD, HEAD~n / ^n,
	 * branch and tag names, full and abbreviated object ids. Not general
	 * gitrevisions (no ranges, no ":path").
	 */
	resolveRevision(spec: string): string | null {
		let current = spec;
		for (;;) {
			const suffixMatch = /^(.*?)([~^])(\d+)$/.exec(current);
			if (!suffixMatch) break;
			current = suffixMatch[1];
		}
		let sha = this.resolveBase(current);
		if (sha === null) return null;
		// Apply ~n / ^n suffixes left to right on the original text.
		const rest = spec.slice(current.length);
		for (const [, operator, countText] of rest.matchAll(/([~^])(\d+)/g)) {
			const count = Number(countText);
			for (let i = 0; i < count; i++) {
				const raw = this.readObject(sha);
				if (raw === null || raw.type !== "commit") return null;
				const commit = parseCommit(raw.body);
				if (commit.parents.length === 0) return null;
				sha = commit.parents[operator === "~" ? 0 : Math.min(count - 1, commit.parents.length - 1)];
				if (operator === "^") break;
			}
		}
		return sha;
	}

	private resolveBase(name: string): string | null {
		if (/^[0-9a-f]{40}$/.test(name)) return this.hasObject(name) ? name : null;
		if (
			name === "HEAD" ||
			refExists(this.gitDir, `refs/heads/${name}`) ||
			refExists(this.gitDir, `refs/tags/${name}`)
		) {
			return this.resolveRef(name === "HEAD" ? "HEAD" : this.candidateRefName(name));
		}
		if (/^[0-9a-f]{4,39}$/.test(name)) {
			const found = this.expandShortSha(name);
			if (found) return found;
		}
		return null;
	}

	private candidateRefName(name: string): string {
		return refExists(this.gitDir, `refs/heads/${name}`) ? `refs/heads/${name}` : `refs/tags/${name}`;
	}

	/** Scan the loose + packed object store for the unique object with this abbreviated sha. */
	private expandShortSha(prefix: string): string | null {
		const matches = this.listObjectIds((id) => id.startsWith(prefix));
		return matches.length === 1 ? matches[0] : null;
	}

	config(): GitConfig {
		return GitConfig.loadStack(join(this.gitDir, "config"), [globalConfigPath()]);
	}
}

const MODE_FILE = 0o100644;
const MODE_EXEC = 0o100755;
const MODE_SYMLINK = 0o120000;

function encodeMaybeString(data: Uint8Array | string): Uint8Array {
	return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function normalizeSignature(sig: GitSignatureLike, fallbackTime: number) {
	return {
		name: sig.name,
		email: sig.email,
		time: sig.time ?? fallbackTime,
		timezoneOffset: sig.timezoneOffset ?? "+0000",
	};
}

/** Reject index paths that could escape the worktree (isomorphic-git UnsafeFilepathError). */
function assertSafeIndexPath(path: string): void {
	if (path.length < 1 || path.startsWith("/") || path.split("/").includes("..")) {
		throw new Error(`unsafe index path: ${path}`);
	}
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function globalConfigPath(): string {
	const override = process.env.GIT_CONFIG_GLOBAL;
	if (override) return override;
	const home = process.env.HOME ?? process.env.USERPROFILE;
	return home ? join(home, ".gitconfig") : ".gitconfig";
}
