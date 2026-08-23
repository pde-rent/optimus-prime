import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObjectType, RawObject } from "./objects.js";
import { bytesToHex, concatBytes, hashRawObject, hexToBytes, PACK_TYPE_NAMES } from "./objects.js";
import { applyDelta, decodeOfsDistance, packEntryHeader } from "./pack-read.js";

/**
 * Packfile WRITE side: build .pack v2 + .idx v2 from object lists, and index a
 * received pack (resolving ofs/ref deltas) so it can be stored in the
 * PackReader-compatible layout (objects/pack/pack-<trailer-sha>.{pack,idx}).
 * We never emit ref-delta (bases are always in-pack as ofs-delta), but
 * indexPack resolves both when scanning a fetched pack.
 * Spec: Documentation/gitformat-pack.txt in git.git.
 */

export const PACK_SIGNATURE = 0x5041434b; // "PACK"

/** Objects that can be packed; sha is computed when absent and deduplicated. */
export interface PackableObject {
	type: GitObjectType;
	body: Uint8Array;
	sha?: string;
}

const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// -- varint helpers -----------------------------------------------------------

/** Pack object header size encoding (7-bit groups, least-significant first). */
export function encodeSizeHeader(typeNumber: number, size: number): Uint8Array {
	const bytes: number[] = [];
	let first = (typeNumber << 4) | (size & 0x0f);
	size >>>= 4;
	while (size > 0) {
		bytes.push(first | 0x80);
		first = size & 0x7f;
		size >>>= 7;
	}
	bytes.push(first);
	return new Uint8Array(bytes);
}

/** OFS_DELTA negative-offset encoding; inverse of acc = ((acc + 1) << 7) | byte. */
export function encodeOfsOffset(offset: number): Uint8Array {
	const bytes = [offset & 0x7f];
	let value = offset >> 7;
	while (value > 0) {
		value -= 1;
		bytes.unshift(value & 0x7f);
		value >>= 7;
	}
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) out[i] = i === bytes.length - 1 ? bytes[i] : bytes[i] | 0x80;
	return out;
}

// -- CRC-32 (zlib polynomial) -------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array, from = 0, to = data.length): number {
	let c = 0xffffffff;
	for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// -- delta encoding -----------------------------------------------------------

const COPY_SIZE_MAX = 0x10000;
const INSERT_MAX = 127;
/** Matches shorter than this are not worth a copy op. */
const MIN_COPY = 16;
const CHUNK_SPLIT = 128;

function fnv1a(data: Uint8Array, from: number, to: number): number {
	let hash = 0x811c9dc5;
	for (let i = from; i < to; i++) {
		hash ^= data[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Chunk starts: split after every LF, hard-split runs longer than CHUNK_SPLIT. */
function chunkStarts(data: Uint8Array): number[] {
	const starts: number[] = [];
	let at = 0;
	while (at < data.length) {
		starts.push(at);
		let end = at;
		while (end < data.length && data[end] !== 0x0a && end - at < CHUNK_SPLIT) end++;
		at = end < data.length && data[end] === 0x0a ? end + 1 : end;
	}
	return starts;
}

/**
 * Git delta format encoder (copy/insert ops) with greedy chunk-anchored
 * matching against one base. Always yields a valid delta producing target from
 * source, insert-only when nothing matches.
 */
export function createDelta(source: Uint8Array, target: Uint8Array): Uint8Array {
	const buckets = new Map<number, number[]>();
	const sourceStarts = chunkStarts(source);
	for (let c = 0; c < sourceStarts.length; c++) {
		const start = sourceStarts[c];
		const chunkEnd = c + 1 < sourceStarts.length ? sourceStarts[c + 1] : source.length;
		const key = fnv1a(source, start, Math.min(chunkEnd, start + 64));
		const list = buckets.get(key);
		if (list) list.push(start);
		else buckets.set(key, [start]);
	}

	const ops: Uint8Array[] = [];
	let pendingFrom = -1;
	let pendingTo = -1;
	const flushInserts = (): void => {
		if (pendingFrom < 0) return;
		for (let at = pendingFrom; at < pendingTo; ) {
			const take = Math.min(INSERT_MAX, pendingTo - at);
			ops.push(concatBytes(new Uint8Array([take]), target.subarray(at, at + take)));
			at += take;
		}
		pendingFrom = -1;
	};
	const emitCopy = (offset: number, size: number): void => {
		while (size > 0) {
			const take = size >= COPY_SIZE_MAX ? COPY_SIZE_MAX : size;
			// In the wire encoding a size of 0 means exactly 0x10000.
			const encodedSize = take === COPY_SIZE_MAX ? 0 : take;
			let opcode = 0x80;
			const extra: number[] = [];
			for (let bit = 0; bit < 4; bit++) {
				const part = (offset >> (bit * 8)) & 0xff;
				if (part !== 0) {
					opcode |= 1 << bit;
					extra.push(part);
				}
			}
			for (let bit = 0; bit < 3; bit++) {
				const part = (encodedSize >> (bit * 8)) & 0xff;
				if (part !== 0) {
					opcode |= 0x10 << bit;
					extra.push(part);
				}
			}
			ops.push(concatBytes(new Uint8Array([opcode]), new Uint8Array(extra)));
			offset += take;
			size -= take;
		}
	};

	// Walk target chunks with an explicit cursor: a copy may span several
	// chunks, so chunk starts before the cursor are already emitted.
	const targetStarts = chunkStarts(target);
	let cursor = 0;
	for (let c = 0; c < targetStarts.length; c++) {
		const at = targetStarts[c];
		if (at < cursor) {
			// A previous copy may cover chunks fully or partially.
			const coveredTo = c + 1 < targetStarts.length ? targetStarts[c + 1] : target.length;
			if (coveredTo <= cursor) continue; // fully covered
			pendingFrom = cursor; // partially covered: only the tail still needs emitting
			pendingTo = coveredTo;
			cursor = coveredTo;
			continue;
		}
		const chunkEnd = c + 1 < targetStarts.length ? targetStarts[c + 1] : target.length;
		const best = { pos: -1, len: 0 };
		const candidates = buckets.get(fnv1a(target, at, Math.min(chunkEnd, at + 64)));
		if (candidates) {
			for (const pos of candidates) {
				let len = 0;
				while (pos + len < source.length && at + len < target.length && source[pos + len] === target[at + len])
					len++;
				if (len > best.len) {
					best.pos = pos;
					best.len = len;
				}
			}
		}
		if (best.len >= MIN_COPY) {
			flushInserts();
			emitCopy(best.pos, best.len);
			cursor = at + best.len;
		} else {
			cursor = at;
		}
		// Whatever remains of this chunk (a short copy leaves a tail) is
		// unmatched target text and becomes pending insert bytes.
		if (cursor < chunkEnd) {
			if (pendingFrom < 0) pendingFrom = cursor;
			pendingTo = chunkEnd;
		}
		cursor = Math.max(cursor, chunkEnd);
	}
	flushInserts();

	return concatBytes(encodeVarIntLE(source.length), encodeVarIntLE(target.length), ...ops);
}

function encodeVarIntLE(value: number): Uint8Array {
	const bytes: number[] = [];
	do {
		bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
		value >>>= 7;
	} while (value > 0);
	return new Uint8Array(bytes);
}

/** Pick a delta base by size proximity among already-emitted same-type objects. */
function chooseDelta(body: Uint8Array, emitted: Array<{ body: Uint8Array; sha: string }>, maxCandidates: number) {
	let best: { delta: Uint8Array; sha: string } | null = null;
	for (let i = emitted.length - 1; i >= 0 && emitted.length - i <= maxCandidates; i--) {
		const candidate = emitted[i];
		const ratio = candidate.body.length / Math.max(1, body.length);
		if (ratio > 3 || ratio < 1 / 3) continue;
		const delta = createDelta(candidate.body, body);
		if (delta.length >= body.length) continue;
		if (!best || delta.length < best.delta.length) best = { delta, sha: candidate.sha };
	}
	return best;
}

export interface BuildPackOptions {
	/** Attempt ofs-delta compression against other objects in this pack (default true). */
	delta?: boolean;
	maxDeltaCandidates?: number;
}

export interface PackEntryInfo {
	sha: string;
	/** Byte offset of the entry's first header byte inside the pack. */
	offset: number;
	/** CRC-32 over the raw entry bytes (header + base ref + compressed payload). */
	crc32: number;
}

export interface BuiltPack {
	pack: Uint8Array;
	entries: PackEntryInfo[];
}

/** Serialize objects into a complete .pack v2 buffer plus per-entry index data. */
export function buildPackBuffer(objects: PackableObject[], options: BuildPackOptions = {}): BuiltPack {
	const useDelta = options.delta ?? true;
	const seen = new Map<string, { typeNumber: number; body: Uint8Array }>();
	for (const object of objects) {
		const sha = (object.sha ?? hashRawObject(object.type, object.body)).toLowerCase();
		if (!seen.has(sha)) seen.set(sha, { typeNumber: TYPE_NUMBERS[object.type], body: object.body });
	}
	// Bigger objects first so later ones can delta against them; group by type.
	const order = [...seen.entries()].sort(
		(a, b) => a[1].typeNumber - b[1].typeNumber || b[1].body.length - a[1].body.length || (a[0] < b[0] ? -1 : 1),
	);

	const parts: Uint8Array[] = [];
	const header = new Uint8Array(12);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, PACK_SIGNATURE);
	headerView.setUint32(4, 2);
	headerView.setUint32(8, order.length);
	parts.push(header);
	const entries: PackEntryInfo[] = [];
	const emitted: Array<{ body: Uint8Array; sha: string }> = [];
	let offset = 12;

	for (const [sha, entry] of order) {
		const start = offset;
		const entryParts: Uint8Array[] = [];
		let typeNumber = entry.typeNumber;
		const candidate = useDelta ? chooseDelta(entry.body, emitted, options.maxDeltaCandidates ?? 6) : null;
		if (candidate) {
			typeNumber = 6; // ofs-delta; the base is always already emitted
			entryParts.push(encodeSizeHeader(6, candidate.delta.length));
			let base: PackEntryInfo | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].sha === candidate.sha) {
					base = entries[i];
					break;
				}
			}
			if (!base) throw new Error(`delta base ${candidate.sha} not yet emitted`);
			entryParts.push(encodeOfsOffset(start - base.offset));
			entryParts.push(deflateSync(candidate.delta));
		} else {
			entryParts.push(encodeSizeHeader(typeNumber, entry.body.length));
			entryParts.push(deflateSync(entry.body));
		}
		const entryBytes = concatBytes(...entryParts);
		parts.push(entryBytes);
		entries.push({ sha, offset: start, crc32: crc32(entryBytes) });
		emitted.push({ body: entry.body, sha });
		offset += entryBytes.length;
	}

	const body = concatBytes(...parts);
	const trailer = createHash("sha1").update(body).digest();
	return { pack: concatBytes(body, trailer), entries };
}

/** Trailer checksum (SHA-1 over the pack body) as hex. */
export function packChecksum(pack: Uint8Array): string {
	if (pack.length < 32) throw new Error("pack too short");
	return bytesToHex(pack.subarray(pack.length - 20));
}

// -- pack scanning / indexing -------------------------------------------------

interface ScannedEntry {
	sha: string;
	offset: number;
	typeNumber: number;
	crc32: number;
}

/** Smallest compressed length whose inflation reproduces the full payload. */
function compressedEntryLength(pack: Uint8Array, dataOffset: number): number {
	const full = inflateSync(pack.subarray(dataOffset));
	const maxLen = pack.length - dataOffset;
	const inflatesFully = (length: number): boolean => {
		try {
			return inflateSync(pack.subarray(dataOffset, dataOffset + length)).length === full.length;
		} catch {
			return false;
		}
	};
	let lo = 1;
	let hi = maxLen;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (inflatesFully(mid)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * Walk every entry of a pack, resolving ofs- and ref-deltas against bases in
 * the same pack. Thin packs (external bases) are rejected. Verifies the
 * trailer checksum and the declared object count.
 */
export function scanPack(pack: Uint8Array): { entries: ScannedEntry[]; objects: Map<string, RawObject> } {
	if (pack.length < 32) throw new Error("pack too short");
	const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
	if (view.getUint32(0) !== PACK_SIGNATURE) throw new Error("not a packfile");
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
	const count = view.getUint32(8);
	if (
		packChecksum(pack) !==
		bytesToHex(
			createHash("sha1")
				.update(pack.subarray(0, pack.length - 20))
				.digest(),
		)
	) {
		throw new Error("pack trailer checksum mismatch");
	}

	const entries: ScannedEntry[] = [];
	const objects = new Map<string, RawObject>();
	const byOffset = new Map<number, RawObject>();
	let at = 12;
	for (let i = 0; i < count; i++) {
		const entryOffset = at;
		const header = packEntryHeader(pack, at);
		const typeNumber = header.typeNumber;
		let object: RawObject;
		let dataStart = header.dataOffset;
		if (typeNumber >= 1 && typeNumber <= 4) {
			const body = inflateSync(pack.subarray(header.dataOffset));
			if (body.length !== header.size) throw new Error(`pack entry at ${entryOffset}: inflated size mismatch`);
			object = { type: PACK_TYPE_NAMES[typeNumber], body };
		} else if (typeNumber === 6 || typeNumber === 7) {
			let base: RawObject | undefined;
			if (typeNumber === 6) {
				const { distance, next } = decodeOfsDistance(pack, header.dataOffset);
				dataStart = next;
				base = byOffset.get(entryOffset - distance) ?? undefined;
				if (!base) throw new Error(`ofs-delta base at ${entryOffset - distance} not found before entry`);
			} else {
				const baseSha = bytesToHex(pack.subarray(header.dataOffset, header.dataOffset + 20));
				dataStart = header.dataOffset + 20;
				base = objects.get(baseSha);
				if (!base) throw new Error(`ref-delta base ${baseSha} not in pack (thin packs unsupported)`);
			}
			const delta = inflateSync(pack.subarray(dataStart));
			object = { type: base.type, body: applyDelta(delta, base.body) };
		} else {
			throw new Error(`unknown pack object type ${typeNumber} at ${entryOffset}`);
		}
		const sha = hashRawObject(object.type, object.body);
		const end = dataStart + compressedEntryLength(pack, dataStart);
		entries.push({ sha, offset: entryOffset, typeNumber, crc32: crc32(pack, entryOffset, end) });
		objects.set(sha, object);
		byOffset.set(entryOffset, object);
		at = end;
	}
	if (at !== pack.length - 20) throw new Error(`pack entry walk ended at ${at}, expected ${pack.length - 20}`);
	return { entries, objects };
}

/**
 * Build the canonical .idx v2 for a pack buffer. Byte-identical to
 * `git index-pack -o` output for the same pack (v2, no large offsets).
 */
/** .idx v2 section: big-endian u32 array. */
function u32Section(values: ArrayLike<number>, guard?: (value: number) => void): Uint8Array {
	const bytes = new Uint8Array(values.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < values.length; i++) {
		if (guard) guard(values[i]);
		view.setUint32(i * 4, values[i]);
	}
	return bytes;
}

export function buildPackIdx(pack: Uint8Array): Uint8Array {
	const { entries } = scanPack(pack);
	const sorted = [...entries].sort((a, b) => (a.sha < b.sha ? -1 : 1));
	const fanout = new Uint32Array(256);
	for (const entry of sorted) fanout[hexToBytes(entry.sha)[0]]++;
	for (let i = 1; i < 256; i++) fanout[i] += fanout[i - 1];

	const chunks: Uint8Array[] = [];
	const magic = new Uint8Array(8);
	const magicView = new DataView(magic.buffer);
	magicView.setUint32(0, 0xff744f63);
	magicView.setUint32(4, 2);
	chunks.push(magic);
	chunks.push(u32Section(fanout));
	for (const entry of sorted) chunks.push(hexToBytes(entry.sha));
	chunks.push(u32Section(sorted.map((entry) => entry.crc32)));
	chunks.push(
		u32Section(
			sorted.map((entry) => entry.offset),
			(offset) => {
				if (offset >= 0x80000000) throw new Error("packs >= 2 GiB are unsupported (large offsets)");
			},
		),
	);
	chunks.push(pack.subarray(pack.length - 20));

	const body = concatBytes(...chunks);
	return concatBytes(body, createHash("sha1").update(body).digest());
}

/**
 * Store a pack + its freshly built .idx under .git/objects/pack, named by the
 * pack trailer checksum (the layout PackReader.open expects). Returns the
 * checksum hex.
 */
export function writePackFiles(gitDir: string, pack: Uint8Array): string {
	const checksum = packChecksum(pack);
	const packDir = join(gitDir, "objects", "pack");
	mkdirSync(packDir, { recursive: true });
	const packPath = join(packDir, `pack-${checksum}.pack`);
	const idxPath = join(packDir, `pack-${checksum}.idx`);
	const idx = buildPackIdx(pack);
	// Write-then-rename so readers never observe a partial pair.
	const tmpPack = `${packPath}.tmp-${process.pid}`;
	writeFileSync(tmpPack, pack);
	renameSync(tmpPack, packPath);
	const tmpIdx = `${idxPath}.tmp-${process.pid}`;
	writeFileSync(tmpIdx, idx);
	renameSync(tmpIdx, idxPath);
	return checksum;
}
