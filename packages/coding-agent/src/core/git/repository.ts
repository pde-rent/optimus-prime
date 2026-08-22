import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GitConfig } from "./config.js";
import type { IndexEntry } from "./index.js";
import { entryStage, GitIndex } from "./index.js";
import { writeFileLocked } from "./lock.js";
import type { GitObjectType, GitTreeEntry, RawObject } from "./objects.js";
import {
	hashRawObject,
	parseCommit,
	parseTree,
	readLooseObject,
	serializeCommit,
	serializeTree,
	TREE_MODE_DIR,
	writeLooseObject,
} from "./objects.js";
import { PackReader } from "./pack-read.js";
import { headRefName, resolveHead, resolveRef, writeRef } from "./refs.js";

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

function _signatureLine(sig: GitSignatureLike): string {
	const time = sig.time ?? Math.floor(Date.now() / 1000);
	const tz = sig.timezoneOffset ?? "+0000";
	return `${sig.name} <${sig.email}> ${time} ${tz}`;
}

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
		if (head === null) return null;
		const raw = this.readObject(head);
		if (raw === null) throw new Error(`HEAD commit ${head} not found in object store`);
		return parseCommit(raw.body).tree;
	}

	/** Flatten HEAD's tree into path -> blob sha. Returns null before the first commit. */
	flatHeadTree(): Map<string, string> | null {
		const treeSha = this.headTreeSha();
		if (treeSha === null) return null;
		const files = new Map<string, string>();
		const walk = (sha: string, prefix: string): void => {
			const raw = this.readObject(sha);
			if (raw === null || raw.type !== "tree") throw new Error(`tree ${sha} not found`);
			for (const entry of parseTree(raw.body)) {
				const path = prefix + entry.name;
				if (entry.mode === TREE_MODE_DIR) walk(entry.sha, `${path}/`);
				else files.set(path, entry.sha);
			}
		};
		walk(treeSha, "");
		return files;
	}

	/** Write tree objects covering all stage-0 index entries; returns the root tree sha. */
	writeTreeFromIndex(): string {
		const stageZero = this.loadIndex().entries.filter((entry) => entryStage(entry) === 0);
		return this.writeTreeLevel(stageZero, "");
	}

	private writeTreeLevel(entries: IndexEntry[], prefix: string): string {
		const direct = new Map<string, IndexEntry>();
		const subtrees = new Map<string, IndexEntry[]>();
		for (const entry of entries) {
			const rest = entry.path.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) direct.set(rest, entry);
			else subtrees.set(rest.slice(0, slash), [...(subtrees.get(rest.slice(0, slash)) ?? []), entry]);
		}
		const treeEntries: GitTreeEntry[] = [...direct].map(([name, entry]) => ({
			mode: entry.mode.toString(8),
			name,
			sha: entry.sha,
		}));
		for (const [dir, children] of subtrees) {
			treeEntries.push({
				mode: TREE_MODE_DIR,
				name: dir,
				sha: this.writeTreeLevel(children, `${prefix + dir}/`),
			});
		}
		treeEntries.sort(compareTreeEntries);
		return writeLooseObject(this.gitDir, "tree", serializeTree(treeEntries));
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
		const indexFiles = new Map<string, IndexEntry>();
		for (const entry of this.loadIndex().entries) {
			if (entryStage(entry) === 0) indexFiles.set(entry.path, entry);
		}
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

/** Read file content for hashing/indexing; symlinks contribute their target text. */
function readWorktreeBytes(workdir: string, relPath: string): Uint8Array {
	const absolute = join(workdir, relPath);
	if (lstatSync(absolute).isSymbolicLink()) {
		return new TextEncoder().encode(readFileSync(absolute, "latin1"));
	}
	return new Uint8Array(readFileSync(absolute));
}

/** Tree sort order compares directory names as if suffixed with "/" (spec §5). */
function compareTreeEntries(a: GitTreeEntry, b: GitTreeEntry): number {
	const aKey = a.mode === TREE_MODE_DIR ? `${a.name}/` : a.name;
	const bKey = b.mode === TREE_MODE_DIR ? `${b.name}/` : b.name;
	return Buffer.compare(Buffer.from(aKey), Buffer.from(bKey));
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
