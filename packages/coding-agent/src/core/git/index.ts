import { createHash } from "node:crypto";
import { bytesToHex, concatBytes } from "./objects.js";

/**
 * The dircache (.git/index), format versions 2 and 3.
 * Spec: Documentation/gitformat-index.txt in git.git.
 */

export interface IndexEntry {
	ctimeSeconds: number;
	ctimeNanoseconds: number;
	mtimeSeconds: number;
	mtimeNanoseconds: number;
	dev: number;
	ino: number;
	mode: number;
	uid: number;
	gid: number;
	/** File size in bytes (truncated to 32 bits). */
	fileSize: number;
	sha: string;
	/** First flags word: assume-valid << 15 | extended << 14 | stage << 12 | name length. */
	flags: number;
	/** Second flags word (index v3 only): intent-to-add / skip-worktree bits. */
	extendedFlags: number;
	path: string;
}

const SIGNATURE = 0x44495243; // "DIRC"
const FIXED_ENTRY_SIZE = 62;

export function entryStage(entry: IndexEntry): number {
	return (entry.flags >> 12) & 0x3;
}

/** Reject paths that could escape the worktree when parsed from disk. */
function assertSafeIndexPath(path: string): void {
	if (path.length < 1 || path.startsWith("/") || path.split("/").includes("..")) {
		throw new Error(`unsafe index path: ${path}`);
	}
}

/** Git's index sort order: byte-wise path compare, then stage number. */
function compareEntries(a: IndexEntry, b: IndexEntry): number {
	const aPath = new TextEncoder().encode(a.path);
	const bPath = new TextEncoder().encode(b.path);
	const pathCmp = Buffer.compare(Buffer.from(aPath), Buffer.from(bPath));
	return pathCmp !== 0 ? pathCmp : entryStage(a) - entryStage(b);
}

export class GitIndex {
	entries: IndexEntry[] = [];
	/** Raw TREE extension bytes; dropped when entries change (cache-scan data goes stale). */
	treeExtension: Uint8Array | null = null;
	version = 2;
	private dirty = false;

	static parse(data: Uint8Array): GitIndex {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		if (data.length < 12 || view.getUint32(0) !== SIGNATURE) throw new Error("not a git index file");
		const version = view.getUint32(4);
		if (version < 2 || version > 3) throw new Error(`unsupported index version ${version}`);
		const count = view.getUint32(8);
		const index = new GitIndex();
		index.version = version;
		let at = 12;
		for (let i = 0; i < count; i++) {
			const entryStart = at;
			const flags = view.getUint16(at + 60);
			let pathLength = flags & 0xfff;
			let extendedFlags = 0;
			let cursor = at + FIXED_ENTRY_SIZE;
			if (version >= 3 && flags & 0x4000) {
				extendedFlags = view.getUint16(cursor);
				cursor += 2;
			}
			if (pathLength === 0xfff) {
				pathLength = data.indexOf(0x00, cursor) - cursor;
			}
			const path = new TextDecoder().decode(data.subarray(cursor, cursor + pathLength));
			assertSafeIndexPath(path);
			index.entries.push({
				ctimeSeconds: view.getUint32(at),
				ctimeNanoseconds: view.getUint32(at + 4),
				mtimeSeconds: view.getUint32(at + 8),
				mtimeNanoseconds: view.getUint32(at + 12),
				dev: view.getUint32(at + 16),
				ino: view.getUint32(at + 20),
				mode: view.getUint32(at + 24),
				uid: view.getUint32(at + 28),
				gid: view.getUint32(at + 32),
				fileSize: view.getUint32(at + 36),
				sha: bytesToHex(data.subarray(at + 40, at + 60)),
				flags,
				extendedFlags,
				path,
			});
			at = cursor + pathLength + 1; // fixed fields + path + NUL terminator
			for (let pad = at; pad < entryStart + Math.ceil((at - entryStart) / 8) * 8; pad++) {
				if (data[pad] !== 0x00) throw new Error("non-zero index entry padding");
			}
			at = entryStart + Math.ceil((at - entryStart) / 8) * 8; // pad to 8-byte boundary
		}
		// Remaining bytes: extensions then trailing checksum.
		while (at + 8 <= data.length - 20) {
			const signature = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
			const size = view.getUint32(at + 4);
			if (signature === "TREE") {
				index.treeExtension = data.subarray(at + 8, at + 8 + size);
			}
			at += 8 + size;
		}
		const expectedChecksum = bytesToHex(data.subarray(data.length - 20));
		const hasher = createHash("sha1");
		hasher.update(data.subarray(0, data.length - 20));
		if (hasher.digest("hex") !== expectedChecksum) throw new Error("index checksum mismatch");
		return index;
	}

	get(path: string, stage = 0): IndexEntry | undefined {
		return this.entries.find((entry) => entry.path === path && entryStage(entry) === stage);
	}

	hasConflicts(): boolean {
		return this.entries.some((entry) => entryStage(entry) !== 0);
	}

	/** Insert or replace an entry for the same path+stage; keeps entries sorted. */
	add(entry: IndexEntry): void {
		this.remove(entry.path, entryStage(entry));
		this.entries.push(entry);
		this.entries.sort(compareEntries);
		this.dirty = true;
	}

	remove(path: string, stage = 0): boolean {
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => !(entry.path === path && entryStage(entry) === stage));
		if (this.entries.length !== before) this.dirty = true;
		return this.entries.length !== before;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	write(): Uint8Array {
		const header = new Uint8Array(12);
		const headerView = new DataView(header.buffer);
		headerView.setUint32(0, SIGNATURE);
		headerView.setUint32(4, 2); // we always write format v2 (v3-only bits are preserved read-side)
		headerView.setUint32(8, this.entries.length);
		const chunks: Uint8Array[] = [header];
		for (const entry of [...this.entries].sort(compareEntries)) {
			const pathBytes = new TextEncoder().encode(entry.path);
			const bodyLength = FIXED_ENTRY_SIZE + pathBytes.length + 1;
			const paddedLength = Math.ceil(bodyLength / 8) * 8;
			const record = new Uint8Array(paddedLength);
			const view = new DataView(record.buffer);
			view.setUint32(0, entry.ctimeSeconds);
			view.setUint32(4, entry.ctimeNanoseconds);
			view.setUint32(8, entry.mtimeSeconds);
			view.setUint32(12, entry.mtimeNanoseconds);
			view.setUint32(16, entry.dev);
			view.setUint32(20, entry.ino);
			view.setUint32(24, entry.mode);
			view.setUint32(28, entry.uid);
			view.setUint32(32, entry.gid);
			view.setUint32(36, entry.fileSize);
			for (let i = 0; i < 20; i++) {
				record[40 + i] = Number.parseInt(entry.sha.slice(i * 2, i * 2 + 2), 16);
			}
			view.setUint16(60, entry.flags & ~0x4000); // never emit the v3 "extended" marker
			record.set(pathBytes, FIXED_ENTRY_SIZE);
			chunks.push(record);
		}
		if (!this.dirty && this.treeExtension) {
			const extension = new Uint8Array(8 + this.treeExtension.length);
			new TextEncoder().encodeInto("TREE", extension);
			new DataView(extension.buffer).setUint32(4, this.treeExtension.length);
			extension.set(this.treeExtension, 8);
			chunks.push(extension);
		}
		const body = concatBytes(...chunks);
		return concatBytes(body, createHash("sha1").update(body).digest());
	}
}
