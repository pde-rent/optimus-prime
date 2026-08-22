import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Ref storage: loose refs under .git/<ref>, packed-refs fallback, HEAD resolution.
 * Spec: gitrevisions(7), gitrepos documentation; packed-refs v1 format.
 */

const MAX_SYMREF_DEPTH = 10;

/** Parse .git/packed-refs into name -> sha (peeled "^" lines are skipped). */
export function loadPackedRefs(gitDir: string): Map<string, string> {
	const refs = new Map<string, string>();
	let text: string;
	try {
		text = readFileSync(join(gitDir, "packed-refs"), "utf8");
	} catch {
		return refs;
	}
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const space = line.indexOf(" ");
		refs.set(line.slice(space + 1), line.slice(0, space));
	}
	return refs;
}

function looseRefPath(gitDir: string, refName: string): string {
	return join(gitDir, ...refName.split("/"));
}

/** Raw content of a ref file without following symbolic refs; falls back to packed-refs. */
export function readRawRef(gitDir: string, refName: string): string | null {
	try {
		return readFileSync(looseRefPath(gitDir, refName), "utf8").trim();
	} catch {
		// fall through to packed-refs
	}
	return loadPackedRefs(gitDir).get(refName) ?? null;
}

/** Follow a symbolic-ref chain ("ref: ...") to a sha; null when the ref is absent/broken. */
export function resolveRef(gitDir: string, refName: string): string | null {
	let current = refName;
	for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
		const raw = readRawRef(gitDir, current);
		if (raw === null) return null;
		if (raw.startsWith("ref: ")) {
			current = raw.slice("ref: ".length);
			continue;
		}
		return raw;
	}
	throw new Error(`symbolic ref chain too deep at ${refName}`);
}

/** The ref HEAD points at (e.g. "refs/heads/main"), or null when detached. */
export function headRefName(gitDir: string): string | null {
	const raw = readRawRef(gitDir, "HEAD");
	if (raw === null) throw new Error("HEAD is missing");
	return raw.startsWith("ref: ") ? raw.slice("ref: ".length) : null;
}

export interface HeadResolution {
	sha: string | null;
	/** true when HEAD holds a sha directly rather than a branch name. */
	detached: boolean;
}

export function resolveHead(gitDir: string): HeadResolution {
	const headRef = headRefName(gitDir);
	if (headRef === null) return { sha: resolveRef(gitDir, "HEAD"), detached: true };
	return { sha: resolveRef(gitDir, headRef), detached: false };
}

const REF_NAME_FORBIDDEN = /[~^:?*[\]|\s]/;

export function assertValidRefName(refName: string): void {
	if (!refName || refName.includes("..") || refName.includes("//") || REF_NAME_FORBIDDEN.test(refName)) {
		throw new Error(`invalid ref name: ${refName}`);
	}
}

/** Write a loose ref file (creating parent directories as needed). */
export function writeRef(gitDir: string, refName: string, sha: string): void {
	assertValidRefName(refName);
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid object id: ${sha}`);
	const path = looseRefPath(gitDir, refName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${sha}\n`);
}

/** Delete a ref from both loose and packed storage. Returns whether anything existed. */
export function deleteRef(gitDir: string, refName: string): boolean {
	assertValidRefName(refName);
	let existed = false;
	const loosePath = looseRefPath(gitDir, refName);
	if (existsSync(loosePath)) {
		rmSync(loosePath);
		existed = true;
	}
	const packed = loadPackedRefs(gitDir);
	if (packed.delete(refName)) {
		existed = true;
		savePackedRefs(gitDir, packed);
	}
	return existed;
}

export function savePackedRefs(gitDir: string, refs: Map<string, string>): void {
	if (refs.size === 0) {
		rmSync(join(gitDir, "packed-refs"), { force: true });
		return;
	}
	const names = [...refs.keys()].sort();
	const body = `# pack-refs with: peeled fully-peeled sorted \n${names.map((name) => `${refs.get(name)} ${name}\n`).join("")}`;
	writeFileSync(join(gitDir, "packed-refs"), body);
}

export function refExists(gitDir: string, refName: string): boolean {
	return existsSync(looseRefPath(gitDir, refName)) || loadPackedRefs(gitDir).has(refName);
}
