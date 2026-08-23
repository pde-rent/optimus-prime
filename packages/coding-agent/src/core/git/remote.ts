import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parseConfigText } from "./config.js";
import { parseCommit, parseTree, TREE_MODE_DIR, TREE_MODE_EXEC, TREE_MODE_SYMLINK } from "./objects.js";
import type { PackableObject } from "./pack-write.js";
import { buildPackBuffer, scanPack, writePackFiles } from "./pack-write.js";
import { GitRepository } from "./repository.js";
import {
	buildReceivePackRequest,
	discoverRefs,
	type PushCommand,
	postReceivePack,
	postUploadPack,
	RECEIVE_PACK_SERVICE,
	type RemoteCredentials,
	resolveRemoteAuth,
	UPLOAD_PACK_SERVICE,
	ZERO_OID,
} from "./transport-http.js";

/**
 * High-level remote operations over smart HTTP: persisted remote config,
 * ls-remote, clone, fetch (incl. shallow), pull with a merge seam, and push
 * with fast-forward enforcement and report-status handling.
 */

const AGENT = "agent=pi-git/1";

// -- remote config ------------------------------------------------------------

export interface RemoteInfo {
	name: string;
	url: string;
}

/** Remote subsections are enumerated from the raw config text (GitConfig has no section lister). */
function localConfigEntries(repo: GitRepository) {
	try {
		return parseConfigText(readFileSync(join(repo.gitDir, "config"), "utf8"));
	} catch {
		return [];
	}
}

export function remoteList(repo: GitRepository): RemoteInfo[] {
	const config = repo.config();
	const names = new Set<string>();
	for (const entry of localConfigEntries(repo)) {
		if (entry.section === "remote" && entry.subsection) names.add(entry.subsection);
	}
	return [...names].map((name) => ({ name, url: config.get(`remote.${name}.url`) ?? "" }));
}

export function remoteAdd(repo: GitRepository, name: string, url: string): void {
	if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid remote name: ${name}`);
	if (!/^https?:\/\//.test(url)) throw new Error(`only http(s) remotes are supported, got: ${url}`);
	const config = repo.config();
	config.set(`remote.${name}.url`, url);
	config.set(`remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`);
	config.save();
}

export function remoteRemove(repo: GitRepository, name: string): void {
	const existed = remoteList(repo).some((remote) => remote.name === name);
	if (!existed) throw new Error(`no such remote: ${name}`);
	const config = repo.config();
	config.removeSection("remote", name);
	config.save();
}

export function remoteUrl(repo: GitRepository, name: string): string | undefined {
	return repo.config().get(`remote.${name}.url`);
}

/** Resolve either a configured remote name or a literal http(s) URL. */
export function resolveRemoteSpec(repo: GitRepository, remoteNameOrUrl: string): string {
	if (/^https?:\/\//.test(remoteNameOrUrl)) return remoteNameOrUrl;
	const configured = remoteUrl(repo, remoteNameOrUrl);
	if (!configured) throw new Error(`unknown remote: ${remoteNameOrUrl}`);
	return configured;
}

// -- shared helpers -----------------------------------------------------------

interface LocalRefSource {
	name: string;
	sha: string;
}

/** Enumerate all local refs (loose under refs/ plus packed-refs). */
export function listLocalRefs(repo: GitRepository): LocalRefSource[] {
	const refs: LocalRefSource[] = [];
	const refsDir = join(repo.gitDir, "refs");
	const visit = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) visit(path);
			else {
				const refName = relative(repo.gitDir, path).split("\\").join("/");
				const sha = readFileSync(path, "utf8").trim();
				if (/^[0-9a-f]{40}$/.test(sha)) refs.push({ name: refName, sha });
			}
		}
	};
	visit(refsDir);
	try {
		const packed = readFileSync(join(repo.gitDir, "packed-refs"), "utf8");
		for (const line of packed.split("\n")) {
			if (!line || line.startsWith("#") || line.startsWith("^")) continue;
			const space = line.indexOf(" ");
			refs.push({ name: line.slice(space + 1), sha: line.slice(0, space) });
		}
	} catch {
		// no packed-refs
	}
	return refs;
}

/** Bounded ancestry walk from ref tips; used as the "have" set during negotiation. */
function negotiateHaves(repo: GitRepository, maxCommits = 128): string[] {
	const seen = new Set<string>();
	const queue: string[] = [];
	for (const ref of listLocalRefs(repo)) {
		if (!seen.has(ref.sha)) {
			seen.add(ref.sha);
			queue.push(ref.sha);
		}
	}
	const haves: string[] = [];
	while (queue.length > 0 && haves.length < maxCommits) {
		const sha = queue.shift()!;
		haves.push(sha);
		const raw = repo.readObject(sha);
		if (!raw || raw.type !== "commit") continue;
		for (const parent of parseCommit(raw.body).parents) {
			if (!seen.has(parent)) {
				seen.add(parent);
				queue.push(parent);
			}
		}
	}
	return haves;
}

/** Is ancestor fully reachable from descendant? Bounded plain-parent walk. */
export function isAncestor(repo: GitRepository, ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return true;
	const seen = new Set<string>();
	const queue = [descendant];
	while (queue.length > 0) {
		const sha = queue.pop()!;
		if (sha === ancestor) return true;
		if (seen.has(sha)) continue;
		seen.add(sha);
		const raw = repo.readObject(sha);
		if (!raw || raw.type !== "commit") continue;
		queue.push(...parseCommit(raw.body).parents);
		if (seen.size > 200_000) throw new Error("isAncestor walk exceeded 200k commits");
	}
	return false;
}

function advertisedHeadTarget(advertisement: { capabilities: Set<string>; refs: Map<string, string> }): string | null {
	for (const capability of advertisement.capabilities) {
		const match = /^symref=HEAD:(.+)$/.exec(capability);
		if (match && advertisement.refs.has(match[1])) return match[1];
	}
	return null;
}

// -- fetch --------------------------------------------------------------------

export interface FetchOptions {
	depth?: number;
	credentials?: RemoteCredentials;
	onProgress?: (text: string) => void;
	/** Advertised ref names to fetch; default: every head and tag. */
	refs?: string[];
	/**
	 * Where each advertised ref lands locally; return undefined to skip.
	 * Default: tracking layout refs/remotes/<remote>/<head>, tags verbatim.
	 */
	mapRef?: (refName: string) => string | undefined;
}

export interface FetchResult {
	refs: Map<string, string>;
	packChecksum: string | null;
	shallowOids: string[];
}

async function fetchFromUrl(repo: GitRepository, url: string, options: FetchOptions): Promise<FetchResult> {
	const auth = resolveRemoteAuth(url, options.credentials);
	const advertisement = await discoverRefs(auth.url, UPLOAD_PACK_SERVICE, auth);

	const selected = [...advertisement.refs.entries()].filter(([name]) => {
		if (options.refs) return options.refs.includes(name);
		return name === "HEAD" || name.startsWith("refs/heads/") || name.startsWith("refs/tags/");
	});

	const wants: string[] = [];
	for (const [, sha] of selected) if (!repo.hasObject(sha) && !wants.includes(sha)) wants.push(sha);

	let checksum: string | null = null;
	let shallowOids: string[] = [];
	if (wants.length > 0) {
		const capabilities = ["side-band-64k", "ofs-delta", "include-tag", AGENT].join(" ");
		const result = await postUploadPack(
			auth.url,
			{ wants, haves: negotiateHaves(repo), capabilities, depth: options.depth },
			auth,
			{ onProgress: options.onProgress },
		);
		if (!result.pack) throw new Error("server acknowledged want-list but sent no packfile");
		scanPack(result.pack); // validates trailer checksum, deltas, and entry walk
		checksum = writePackFiles(repo.gitDir, result.pack);
		repo.refreshObjectStore(); // make the new pack visible to repo.readObject
		shallowOids = applyShallowState(repo.gitDir, result.shallow, result.unshallow);
	} else if (options.depth !== undefined) {
		shallowOids = loadShallow(repo.gitDir);
	}

	for (const [refName, sha] of selected) {
		if (refName === "HEAD") continue;
		const target = options.mapRef?.(refName);
		if (target) repo.updateRef(target, sha);
	}
	// include-tag: the server sends annotated tags pointing at fetched objects;
	// record those tag refs locally even when they were not explicitly wanted.
	for (const [tagRef, tagOid] of advertisement.refs) {
		if (!tagRef.startsWith("refs/tags/") || selected.some(([name]) => name === tagRef)) continue;
		const peeledTarget = advertisement.peeled.get(tagRef) ?? tagOid;
		if (repo.hasObject(peeledTarget)) repo.updateRef(tagRef, tagOid);
	}
	writeFetchHead(repo.gitDir, selected, auth.url);
	return { refs: advertisement.refs, packChecksum: checksum, shallowOids };
}

export async function fetchRemote(
	repo: GitRepository,
	remoteNameOrUrl: string,
	options: FetchOptions = {},
): Promise<FetchResult> {
	const url = resolveRemoteSpec(repo, remoteNameOrUrl);
	const remoteName = /^https?:\/\//.test(remoteNameOrUrl) ? "origin" : remoteNameOrUrl;
	const mapRef =
		options.mapRef ??
		((refName: string): string | undefined => {
			if (refName.startsWith("refs/tags/")) return refName;
			if (refName.startsWith("refs/heads/")) {
				return `refs/remotes/${remoteName}/${refName.slice("refs/heads/".length)}`;
			}
			return undefined;
		});
	return fetchFromUrl(repo, url, { ...options, mapRef });
}

function shortName(refName: string): string {
	return refName.replace(/^refs\/(heads|tags|remotes)\//, "");
}

function writeFetchHead(gitDir: string, selected: Array<[string, string]>, url: string): void {
	const currentBranch = readCurrentBranch(gitDir);
	const lines = selected
		.filter(([refName]) => refName !== "HEAD")
		.map(([refName, sha]) => {
			const kind = refName.startsWith("refs/tags/")
				? `tag '${shortName(refName)}'`
				: `branch '${shortName(refName)}'`;
			const isMerged = currentBranch !== null && refName === `refs/heads/${currentBranch}`;
			return `${sha}\t${isMerged ? "" : "not-for-merge"}\t${kind} of ${url}`;
		});
	writeFileSync(join(gitDir, "FETCH_HEAD"), `${lines.join("\n")}\n`);
}

function readCurrentBranch(gitDir: string): string | null {
	try {
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
	} catch {
		return null;
	}
}

// -- shallow ------------------------------------------------------------------

function loadShallow(gitDir: string): string[] {
	try {
		return readFileSync(join(gitDir, "shallow"), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function applyShallowState(gitDir: string, shallow: string[], unshallow: string[]): string[] {
	if (shallow.length === 0 && unshallow.length === 0) return loadShallow(gitDir);
	const state = new Set(loadShallow(gitDir));
	for (const oid of shallow) state.add(oid);
	for (const oid of unshallow) state.delete(oid);
	const lines = [...state].sort();
	if (lines.length > 0) writeFileSync(join(gitDir, "shallow"), `${lines.join("\n")}\n`);
	else rmSync(join(gitDir, "shallow"), { force: true });
	return lines;
}

// -- clone --------------------------------------------------------------------

export interface CloneOptions {
	depth?: number;
	branch?: string;
	remoteName?: string;
	credentials?: RemoteCredentials;
	onProgress?: (text: string) => void;
}

/** Clone over smart HTTP: init, fetch (optionally shallow), set HEAD, checkout. */
export async function cloneRepository(
	url: string,
	destDir: string,
	options: CloneOptions = {},
): Promise<GitRepository> {
	const remoteName = options.remoteName ?? "origin";
	const auth = resolveRemoteAuth(url, options.credentials);
	const advertisement = await discoverRefs(auth.url, UPLOAD_PACK_SERVICE, auth);
	const headTarget = advertisedHeadTarget(advertisement);
	const branch = options.branch ?? (headTarget ? headTarget.slice("refs/heads/".length) : "main");

	const repo = GitRepository.init(destDir, { defaultBranch: branch });
	if (advertisement.refs.size > 0) {
		const mapRef = (refName: string): string | undefined => {
			if (refName.startsWith("refs/tags/")) return refName;
			if (refName.startsWith("refs/heads/")) {
				const short = refName.slice("refs/heads/".length);
				return short === branch ? refName : `refs/remotes/${remoteName}/${short}`;
			}
			return undefined;
		};
		await fetchFromUrl(repo, url, {
			depth: options.depth,
			credentials: options.credentials,
			onProgress: options.onProgress,
			mapRef,
		});
		remoteAdd(repo, remoteName, auth.url);
		checkoutWorktree(repo);
	}
	return repo;
}

// -- checkout (minimal: trees -> worktree + stage-0 index) --------------------

/** Materialize HEAD's tree into the worktree and rebuild the stage-0 index. */
export function checkoutWorktree(repo: GitRepository): void {
	const treeSha = repo.headTreeSha();
	if (treeSha === null) return;
	const walk = (sha: string, prefix: string): void => {
		const raw = repo.readObject(sha);
		if (!raw || raw.type !== "tree") throw new Error(`tree ${sha} missing during checkout`);
		for (const entry of parseTree(raw.body)) {
			const path = prefix + entry.name;
			if (entry.mode === TREE_MODE_DIR) {
				walk(entry.sha, `${path}/`);
				continue;
			}
			const object = repo.readObject(entry.sha);
			if (!object || object.type !== "blob") throw new Error(`blob ${entry.sha} missing during checkout (${path})`);
			const absolute = join(repo.workdir, path);
			mkdirSync(join(absolute, ".."), { recursive: true });
			if (entry.mode === TREE_MODE_SYMLINK) {
				rmSync(absolute, { force: true });
				symlinkSync(new TextDecoder().decode(object.body), absolute);
			} else {
				writeFileSync(absolute, object.body);
				if (entry.mode === TREE_MODE_EXEC) chmodSync(absolute, 0o755);
			}
		}
	};
	const previousPaths = new Set(repo.loadIndex().entries.map((entry) => entry.path));
	walk(treeSha, "");
	// Drop tracked files that no longer exist in the target tree.
	const kept = new Set((repo.flatHeadTree() ?? new Map<string, string>()).keys());
	for (const path of previousPaths) {
		if (kept.has(path)) continue;
		const absolute = join(repo.workdir, path);
		if (!existsSync(absolute)) continue;
		rmSync(absolute, { force: true });
		let parent = join(absolute, "..");
		while (parent.startsWith(repo.workdir)) {
			try {
				if (readdirSync(parent).length > 0) break;
				rmdirSync(parent);
			} catch {
				break;
			}
			parent = join(parent, "..");
		}
	}
	const index = repo.loadIndex();
	index.entries = [];
	const files = repo.flatHeadTree();
	if (files) for (const [path, blobSha] of files) index.add(repo.makeIndexEntry(path, blobSha));
	repo.saveIndex(index);
}

// -- pull ---------------------------------------------------------------------

export type PullOutcome = "fast-forward" | "up-to-date" | "merged";

/** Hook point for real merges; called instead of throwing when histories diverged. */
export type MergeSeam = (context: {
	repo: GitRepository;
	fetchedTip: string;
	refToUpdate: string;
	upstreamRef: string;
}) => "merged" | undefined;

export interface PullOptions extends FetchOptions {
	onMerge?: MergeSeam;
}

/**
 * Fetch, then fast-forward the current branch when possible. Divergent
 * histories go to the onMerge seam; without one, pull refuses (the merge
 * itself lives elsewhere).
 */
export async function pullRemote(
	repo: GitRepository,
	remoteNameOrUrl: string,
	options: PullOptions = {},
): Promise<PullOutcome> {
	const remoteName = /^https?:\/\//.test(remoteNameOrUrl) ? "origin" : remoteNameOrUrl;
	await fetchRemote(repo, remoteNameOrUrl, options);
	const branch = repo.headBranch()?.slice("refs/heads/".length) ?? null;
	if (!branch) throw new Error("pull requires a branch (detached HEAD)");
	const upstreamRef = `refs/remotes/${remoteName}/${branch}`;
	const fetchedTip = repo.resolveRef(upstreamRef);
	if (!fetchedTip) throw new Error(`no upstream branch found at ${upstreamRef}`);
	const refToUpdate = `refs/heads/${branch}`;
	const head = repo.resolveRef(refToUpdate);
	if (head === fetchedTip) return "up-to-date";
	if (head === null || isAncestor(repo, head, fetchedTip)) {
		repo.updateRef(refToUpdate, fetchedTip);
		checkoutWorktree(repo);
		return "fast-forward";
	}
	if (options.onMerge) {
		options.onMerge({ repo, fetchedTip, refToUpdate, upstreamRef });
		return "merged";
	}
	throw new Error(`${branch} and ${upstreamRef} diverged; merge required (no onMerge hook provided)`);
}

// -- push ---------------------------------------------------------------------

export interface PushOptions {
	refspecs?: string[];
	force?: boolean;
	credentials?: RemoteCredentials;
	onProgress?: (text: string) => void;
}

export interface PushRefResult {
	refName: string;
	ok: boolean;
	reason?: string;
}

export interface PushResult {
	unpackOk: boolean;
	unpackReason?: string;
	results: PushRefResult[];
}

/**
 * Push refspecs ("branch", "src:dst"; empty src deletes dst) over smart HTTP.
 * Non-fast-forward updates are rejected client-side unless force. Sends a
 * delta-compressed pack of everything the remote lacks and applies the
 * server's report-status.
 */
export async function pushRemote(
	repo: GitRepository,
	remoteNameOrUrl: string,
	options: PushOptions = {},
): Promise<PushResult> {
	const url = resolveRemoteSpec(repo, remoteNameOrUrl);
	const auth = resolveRemoteAuth(url, options.credentials);
	const advertisement = await discoverRefs(auth.url, RECEIVE_PACK_SERVICE, auth);

	const commands: PushCommand[] = [];
	const specs = options.refspecs ?? [defaultPushRefspec(repo)];
	for (const spec of specs) {
		const [source, destinationRaw] = spec.split(":");
		const destination = destinationRaw || (source.startsWith("refs/") ? source : `refs/heads/${source}`);
		if (source === "") {
			if (!advertisement.capabilities.has("delete-refs")) throw new Error("remote does not advertise delete-refs");
			const oldOid = advertisement.refs.get(destination);
			if (!oldOid) throw new Error(`cannot delete nonexistent remote ref ${destination}`);
			commands.push({ oldOid, newOid: ZERO_OID, refName: destination });
			continue;
		}
		const fullSource = source.startsWith("refs/") ? source : `refs/heads/${source}`;
		const newOid = source === "HEAD" ? repo.headCommitSha() : repo.resolveRef(fullSource);
		if (!newOid) throw new Error(`unknown local ref: ${source}`);
		const oldOid = advertisement.refs.get(destination) ?? ZERO_OID;
		if (oldOid !== ZERO_OID && newOid !== oldOid && !options.force && !isAncestor(repo, oldOid, newOid)) {
			throw new Error(`non-fast-forward push to ${destination} rejected (remote has ${oldOid}); use force`);
		}
		commands.push({ oldOid, newOid, refName: destination });
	}
	if (commands.length === 0) return { unpackOk: true, results: [] };

	const tips = commands.filter((c) => c.newOid !== ZERO_OID).map((c) => c.newOid);
	const borderOids = [...new Set([...advertisement.refs.values(), ...advertisement.peeled.values()])];
	const objects = collectMissingObjects(repo, tips, borderOids);
	const built = buildPackBuffer(objects);
	scanPack(built.pack); // self-check before sending
	const capabilities = ["report-status", "delete-refs", "ofs-delta", AGENT].join(" ");
	const request = buildReceivePackRequest(commands, built.pack, capabilities);
	const report = await postReceivePack(auth.url, request, auth, { onProgress: options.onProgress });

	const results: PushRefResult[] = report.commands.map((entry) => ({
		refName: entry.refName,
		ok: entry.ok,
		reason: entry.reason,
	}));
	for (const command of commands) {
		if (!results.some((r) => r.refName === command.refName)) {
			results.push({
				refName: command.refName,
				ok: false,
				reason: report.unpackOk ? "no status returned" : report.unpackReason,
			});
		}
	}
	if (!report.unpackOk) throw new Error(`push unpack failed: ${report.unpackReason ?? "unpack failed"}`);
	return { unpackOk: report.unpackOk, unpackReason: report.unpackReason, results };
}

function defaultPushRefspec(repo: GitRepository): string {
	const branch = repo.headBranch();
	if (!branch) throw new Error("push requires a branch (detached HEAD); pass refspecs explicitly");
	return branch.slice("refs/heads/".length);
}

/**
 * Every object reachable from tips (commits, their trees/blobs, annotated
 * tags) except what the remote already advertises. Walking stops at border
 * commits, so shared history is never resent.
 */
function collectMissingObjects(repo: GitRepository, tips: string[], borderOids: string[]): PackableObject[] {
	const borders = new Set(borderOids);
	const objects = new Map<string, PackableObject>();
	const add = (sha: string): PackableObject | null => {
		const existing = objects.get(sha);
		if (existing) return existing;
		if (borders.has(sha)) return null;
		const raw = repo.readObject(sha);
		if (!raw) throw new Error(`object ${sha} missing while building push pack`);
		const entry: PackableObject = { type: raw.type, body: raw.body, sha };
		objects.set(sha, entry);
		return entry;
	};
	const walkTree = (sha: string): void => {
		const entry = add(sha);
		if (!entry || entry.type !== "tree") return;
		for (const node of parseTree(entry.body)) {
			if (node.mode === TREE_MODE_DIR) walkTree(node.sha);
			else add(node.sha);
		}
	};
	const queue = [...tips];
	while (queue.length > 0) {
		const sha = queue.pop()!;
		if (objects.has(sha) || borders.has(sha)) continue;
		const raw = repo.readObject(sha);
		if (!raw) throw new Error(`object ${sha} missing while building push pack`);
		if (raw.type === "tag") {
			add(sha);
			queue.push(parseTagTarget(raw.body));
			continue;
		}
		if (raw.type !== "commit") {
			add(sha);
			continue;
		}
		add(sha);
		const commit = parseCommit(raw.body);
		walkTree(commit.tree);
		queue.push(...commit.parents);
	}
	return [...objects.values()];
}

function parseTagTarget(body: Uint8Array): string {
	const match = /^object ([0-9a-f]{40})/m.exec(new TextDecoder().decode(body));
	if (!match) throw new Error("malformed tag object");
	return match[1];
}
