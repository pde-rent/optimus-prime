import { type Dirent, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { IgnoreMatcher } from "../../../utils/ignore-matcher.js";
import { toPosixPath } from "../../../utils/shared.js";
import { addIgnoreRules } from "../../ignore-rules.js";

/** Directory names never descended into by the native file tools. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

/** Bytes inspected from a file head when sniffing for binary content. */
const BINARY_SNIFF_BYTES = 8192;

export interface WalkedEntry {
	/** Absolute path of the entry. */
	absPath: string;
	/** Path relative to the walk root, using forward slashes on every platform. */
	relPath: string;
	/** True for regular files, false for directories. */
	isFile: boolean;
}

export interface WalkOptions {
	/** Gitignore-style glob a file's relative path must match to be visited. */
	include?: string;
	/** Gitignore-style glob excluding files whose relative path matches. */
	exclude?: string;
}

/**
 * True when the head of the buffer contains a NUL byte, the usual signal that
 * the file is binary rather than text.
 */
export function looksLikeBinary(buffer: Buffer): boolean {
	const head = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, buffer.length));
	return head.includes(0);
}

/** Match one gitignore-style glob against a forward-slash relative path. */
function globMatches(glob: string, relPosixPath: string): boolean {
	const matcher: IgnoreMatcher = new IgnoreMatcher().add(glob);
	return matcher.ignores(relPosixPath);
}

function passesGlobs(relPosixPath: string, options: WalkOptions): boolean {
	if (options.include && !globMatches(options.include, relPosixPath)) {
		return false;
	}
	if (options.exclude && globMatches(options.exclude, relPosixPath)) {
		return false;
	}
	return true;
}

/**
 * Walk the tree under `rootAbs` depth-first, skipping `node_modules` and
 * `.git`, honouring .gitignore/.ignore/.fdignore rules found along the way,
 * and applying the include/exclude globs to every visited file. Returns files
 * and directories in walk order.
 */
export function walkTree(rootAbs: string, options: WalkOptions = {}): WalkedEntry[] {
	const entries: WalkedEntry[] = [];
	const ignore: IgnoreMatcher = new IgnoreMatcher();
	addIgnoreRules(ignore, rootAbs, rootAbs);

	const visit = (dirAbs: string, dirRel: string): void => {
		let dirents: Dirent[];
		try {
			dirents = readdirSync(dirAbs, { withFileTypes: true });
		} catch {
			// Unreadable directory (permissions, race): skip rather than fail the walk.
			return;
		}

		for (const dirent of dirents) {
			if (SKIP_DIR_NAMES.has(dirent.name)) continue;
			const childRel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;
			const childAbs = join(dirAbs, dirent.name);

			let stats: Stats;
			try {
				stats = statSync(childAbs);
			} catch {
				continue; // Broken symlink or vanished entry.
			}

			if (stats.isDirectory()) {
				if (ignore.ignores(`${childRel}/`)) continue;
				addIgnoreRules(ignore, childAbs, rootAbs);
				visit(childAbs, childRel);
				continue;
			}
			if (!stats.isFile() || ignore.ignores(childRel) || !passesGlobs(childRel, options)) {
				continue;
			}
			entries.push({ absPath: childAbs, relPath: toPosixPath(childRel), isFile: true });
		}
	};

	visit(rootAbs, "");
	return entries;
}

/** Walk only regular files under `rootAbs`, applying include/exclude globs. */
export function walkFiles(rootAbs: string, options: WalkOptions = {}): WalkedEntry[] {
	return walkTree(rootAbs, options).filter((entry) => entry.isFile);
}

/** Resolve + stat a search root; missing/broken paths fail with the shared native-tool message. */
export function statSearchRoot(rootPath: string, displayPath: string): Stats {
	try {
		return statSync(rootPath);
	} catch (error: unknown) {
		const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
		throw new Error(`Could not search path: ${displayPath}. Error code: ${code}.`);
	}
}
