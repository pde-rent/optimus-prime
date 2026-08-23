import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * Loose object storage: zlib-compressed "<type> <size>\0<body>" under
 * .git/objects/<2-hex>/<38-hex>, plus parsers for tree and commit/tag payloads.
 * Spec: https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
 */

export type GitObjectType = "blob" | "tree" | "commit" | "tag";

/** Pack object type numbers (pack format v2). */
export const PACK_TYPE_NAMES: Record<number, GitObjectType> = {
	1: "commit",
	2: "tree",
	3: "blob",
	4: "tag",
};

export interface RawObject {
	type: GitObjectType;
	body: Uint8Array;
}

export function sha1Hex(...parts: Uint8Array[]): string {
	const hasher = createHash("sha1");
	for (const part of parts) {
		hasher.update(part);
	}
	return hasher.digest("hex");
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function ascii(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function objectHeader(type: GitObjectType, body: Uint8Array): Uint8Array {
	return ascii(`${type} ${body.length}\0`);
}

export function hashRawObject(type: GitObjectType, body: Uint8Array): string {
	return sha1Hex(objectHeader(type, body), body);
}

export function serializeLooseObject(type: GitObjectType, body: Uint8Array): Uint8Array {
	return deflateSync(concatBytes(objectHeader(type, body), body));
}

export function looseObjectPath(gitDir: string, sha: string): string {
	return join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
}

/** Read one loose object; returns null when absent. Verifies the stored checksum. */
export function readLooseObject(gitDir: string, sha: string): RawObject | null {
	let compressed: Buffer;
	try {
		compressed = readFileSync(looseObjectPath(gitDir, sha));
	} catch {
		return null;
	}
	const plain = inflateSync(compressed);
	const nul = plain.indexOf(0);
	if (nul < 0) throw new Error(`malformed loose object ${sha}: missing header terminator`);
	const header = plain.subarray(0, nul).toString("latin1");
	const space = header.indexOf(" ");
	const type = header.slice(0, space) as GitObjectType;
	if (!["blob", "tree", "commit", "tag"].includes(type)) {
		throw new Error(`malformed loose object ${sha}: unknown type ${type}`);
	}
	const declaredSize = Number(header.slice(space + 1));
	const body = plain.subarray(nul + 1);
	if (body.length !== declaredSize) {
		throw new Error(`corrupt loose object ${sha}: size ${declaredSize} != ${body.length}`);
	}
	const actual = hashRawObject(type, body);
	if (actual !== sha) throw new Error(`corrupt loose object: hashed ${actual}, expected ${sha}`);
	return { type, body };
}

/** Write a loose object (content-addressed; no-op if already present). Returns its sha. */
export function writeLooseObject(gitDir: string, type: GitObjectType, body: Uint8Array): string {
	const sha = hashRawObject(type, body);
	const path = looseObjectPath(gitDir, sha);
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		// Write-then-rename so a crash never leaves a partial object.
		const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tmp, serializeLooseObject(type, body));
		renameSync(tmp, path);
	}
	return sha;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface GitTreeEntry {
	/** ASCII mode without leading zeros, e.g. "100644", "40000", "160000". */
	mode: string;
	name: string;
	sha: string;
}

export const TREE_MODE_EXEC = "100755";
export const TREE_MODE_SYMLINK = "120000";
export const TREE_MODE_DIR = "40000";

/** Parse tree payload bytes: repeated "<mode> <name>\0<20-byte binary sha>". */
export function parseTree(body: Uint8Array): GitTreeEntry[] {
	const entries: GitTreeEntry[] = [];
	let at = 0;
	while (at < body.length) {
		const space = body.indexOf(0x20, at);
		const nul = body.indexOf(0x00, space + 1);
		if (space < 0 || nul < 0 || nul + 21 > body.length) {
			throw new Error("corrupt tree entry");
		}
		const mode = Buffer.from(body.subarray(at, space)).toString("ascii");
		const name = new TextDecoder().decode(body.subarray(space + 1, nul));
		const sha = bytesToHex(body.subarray(nul + 1, nul + 21));
		entries.push({ mode, name, sha });
		at = nul + 21;
	}
	return entries;
}

export function serializeTree(entries: GitTreeEntry[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		parts.push(ascii(`${entry.mode} ${entry.name}\0`), hexToBytes(entry.sha));
	}
	return concatBytes(...parts);
}

const HEX_ALPHABET = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 0xf];
	return out;
}

export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error(`bad hex: ${hex}`);
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// ---------------------------------------------------------------------------
// Commits and tags
// ---------------------------------------------------------------------------

export interface GitSignature {
	name: string;
	email: string;
	/** Unix seconds. */
	time: number;
	/** e.g. "+0200". */
	timezoneOffset: string;
}

export function formatSignature(sig: GitSignature): string {
	return `${sig.name} <${sig.email}> ${sig.time} ${sig.timezoneOffset}`;
}

export function parseSignature(line: string): GitSignature {
	const match = /^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(line.trim());
	if (!match) throw new Error(`malformed signature line: ${line}`);
	return { name: match[1], email: match[2], time: Number(match[3]), timezoneOffset: match[4] };
}

interface ParsedHeaders {
	headers: Array<[key: string, value: string]>;
	message: string;
}

/** Split "key value" header lines (with space-indented continuations) from the message. */
export function parseHeaders(payload: Uint8Array): ParsedHeaders {
	const text = new TextDecoder().decode(payload);
	const split = text.indexOf("\n\n");
	const headText = split === -1 ? text : text.slice(0, split);
	const message = split === -1 ? "" : text.slice(split + 2);
	const headers: Array<[string, string]> = [];
	for (const line of headText.split("\n")) {
		if (line.startsWith(" ") && headers.length > 0) {
			const previous = headers[headers.length - 1];
			previous[1] += `\n${line.slice(1)}`;
		} else {
			const space = line.indexOf(" ");
			headers.push([line.slice(0, space), line.slice(space + 1)]);
		}
	}
	return { headers, message };
}

export interface ParsedCommit {
	tree: string;
	parents: string[];
	author: GitSignature;
	committer: GitSignature;
	headers: Array<[key: string, value: string]>;
	message: string;
}

export function parseCommit(body: Uint8Array): ParsedCommit {
	const { headers, message } = parseHeaders(body);
	let tree: string | undefined;
	const parents: string[] = [];
	let author: GitSignature | undefined;
	let committer: GitSignature | undefined;
	for (const [key, value] of headers) {
		if (key === "tree") tree = value;
		else if (key === "parent") parents.push(value);
		else if (key === "author") author = parseSignature(value);
		else if (key === "committer") committer = parseSignature(value);
	}
	if (!tree || !author || !committer) throw new Error("commit missing tree/author/committer");
	return { tree, parents, author, committer, headers, message };
}

export function serializeCommit(options: {
	tree: string;
	parents: string[];
	author: GitSignature;
	committer?: GitSignature;
	message: string;
}): Uint8Array {
	const lines = [`tree ${options.tree}`];
	for (const parent of options.parents) lines.push(`parent ${parent}`);
	lines.push(`author ${formatSignature(options.author)}`);
	lines.push(`committer ${formatSignature(options.committer ?? options.author)}`);
	return concatBytes(ascii(`${lines.join("\n")}\n\n`), ascii(options.message), ascii("\n"));
}

export interface ParsedTag {
	object: string;
	type: GitObjectType;
	tag: string;
	tagger: GitSignature | null;
	message: string;
}

export function parseTag(body: Uint8Array): ParsedTag {
	const { headers, message } = parseHeaders(body);
	const get = (key: string) => headers.find(([k]) => k === key)?.[1];
	const object = get("object");
	const type = get("type") as GitObjectType | undefined;
	const tag = get("tag");
	if (!object || !type || !tag) throw new Error("tag object missing object/type/tag");
	const taggerLine = get("tagger");
	return { object, type, tag, tagger: taggerLine ? parseSignature(taggerLine) : null, message };
}
