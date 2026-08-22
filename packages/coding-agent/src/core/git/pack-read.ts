import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { RawObject } from "./objects.js";
import { bytesToHex, hexToBytes, PACK_TYPE_NAMES, sha1Hex } from "./objects.js";

/**
 * Pack index (.idx v2) + packfile (.pack v2) reader.
 * Spec: Documentation/gitformat-pack.txt in git.git; checksums are verified lazily.
 */

/** git repack defaults to depth <= 50; treat deeper chains as corrupt/cyclic (spec §2.4). */
export const MAX_DELTA_DEPTH = 50;

/** Apply a git delta buffer (copy/insert ops) to a base object body. */
export function applyDelta(delta: Uint8Array, source: Uint8Array): Uint8Array {
	let at = 0;
	const readVarInt = () => {
		let result = 0;
		let shift = 0;
		for (;;) {
			const byte = delta[at++];
			result |= (byte & 0x7f) << shift;
			shift += 7;
			if ((byte & 0x80) === 0) break;
		}
		return result;
	};
	const sourceSize = readVarInt();
	if (sourceSize !== source.length) {
		throw new Error(`delta source size ${sourceSize} != base size ${source.length}`);
	}
	const targetSize = readVarInt();
	const chunks: Uint8Array[] = [];
	let produced = 0;
	while (at < delta.length) {
		const op = delta[at++];
		if (op & 0x80) {
			let offset = 0;
			let size = 0;
			for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[at++] << (i * 8);
			for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[at++] << (i * 8);
			if (size === 0) size = 0x10000;
			chunks.push(source.subarray(offset, offset + size));
			produced += size;
		} else {
			if (op === 0) throw new Error("delta opcode 0 is reserved");
			chunks.push(delta.subarray(at, at + op));
			at += op;
			produced += op;
		}
	}
	if (produced !== targetSize) throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
	return concatBytes(...chunks);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

export class PackReader {
	private readonly view: DataView;
	private readonly fanout: Uint32Array;
	private readonly count: number;
	private readonly shas: string[];
	private readonly offsets: number[];

	private constructor(
		private readonly pack: Uint8Array,
		idx: Uint8Array,
	) {
		this.view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
		if (this.view.getUint32(0) !== 0xff744f63 || this.view.getUint32(4) !== 2) {
			throw new Error("unsupported pack index: need .idx version 2");
		}
		this.fanout = new Uint32Array(256);
		for (let i = 0; i < 256; i++) this.fanout[i] = this.view.getUint32(8 + i * 4);
		this.count = this.fanout[255];
		const shasAt = 8 + 256 * 4;
		const offsetsAt = shasAt + this.count * 20 + this.count * 4;
		this.shas = new Array(this.count);
		this.offsets = new Array(this.count);
		for (let i = 0; i < this.count; i++) {
			this.shas[i] = bytesToHex(idx.subarray(shasAt + i * 20, shasAt + i * 20 + 20));
		}
		const largeOffsets: number[] = [];
		for (let i = 0; i < this.count; i++) {
			const raw = this.view.getUint32(offsetsAt + i * 4);
			if (raw & 0x80000000) {
				const largeIndex = raw & 0x7fffffff;
				if (largeOffsets[largeIndex] === undefined) {
					largeOffsets[largeIndex] = Number(this.view.getBigUint64(offsetsAt + this.count * 4 + largeIndex * 8));
				}
				this.offsets[i] = largeOffsets[largeIndex];
			} else {
				this.offsets[i] = raw;
			}
		}
	}

	static fromBuffers(pack: Uint8Array, idx: Uint8Array): PackReader {
		return new PackReader(pack, idx);
	}

	static open(packPath: string): PackReader {
		return new PackReader(readFileSync(packPath), readFileSync(packPath.replace(/\.pack$/, ".idx")));
	}

	get objectCount(): number {
		return this.count;
	}

	/** SHA-1 of the full pack content as recorded in its trailer. */
	packChecksum(): string {
		return bytesToHex(this.pack.subarray(this.pack.length - 20));
	}

	/** Lazily verify the pack trailing checksum against its content. */
	verifyPackChecksum(): boolean {
		return sha1Hex(this.pack.subarray(0, this.pack.length - 20)) === this.packChecksum();
	}

	has(sha: string): boolean {
		return this.findIndex(hexToBytes(sha.toLowerCase())) >= 0;
	}

	/** Read and fully resolve one object (following delta chains). Returns null when absent. */
	read(sha: string, maxDepth: number = MAX_DELTA_DEPTH): RawObject | null {
		const index = this.findIndex(hexToBytes(sha.toLowerCase()));
		if (index < 0) return null;
		return this.resolveAt(this.offsets[index], maxDepth);
	}

	private findIndex(binarySha: Uint8Array): number {
		const bucket = binarySha[0];
		let lo = bucket === 0 ? 0 : this.fanout[bucket - 1];
		let hi = this.fanout[bucket];
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const cmp = compareBytes(binarySha, hexToBytes(this.shas[mid]));
			if (cmp === 0) return mid;
			if (cmp < 0) hi = mid;
			else lo = mid + 1;
		}
		return -1;
	}

	private entryHeader(offset: number): { typeNumber: number; size: number; dataOffset: number } {
		let byte = this.pack[offset];
		let at = offset + 1;
		const typeNumber = (byte >> 4) & 0x7;
		let size = byte & 0x0f;
		let shift = 4;
		while (byte & 0x80) {
			byte = this.pack[at++];
			size |= (byte & 0x7f) << shift;
			shift += 7;
		}
		return { typeNumber, size, dataOffset: at };
	}

	private resolveAt(offset: number, depthLeft: number): RawObject {
		if (depthLeft <= 0) throw new Error("delta chain too deep");
		const header = this.entryHeader(offset);
		if (header.typeNumber >= 1 && header.typeNumber <= 4) {
			const typeName = PACK_TYPE_NAMES[header.typeNumber];
			const body = inflateSync(this.pack.subarray(header.dataOffset));
			if (body.length !== header.size) throw new Error("inflated size mismatch in pack");
			return { type: typeName, body };
		}
		let baseOffset: number;
		let deltaStart: number;
		if (header.typeNumber === 6) {
			let byte = this.pack[header.dataOffset];
			let at = header.dataOffset + 1;
			let distance = byte & 0x7f;
			while (byte & 0x80) {
				byte = this.pack[at++];
				distance = ((distance + 1) << 7) | (byte & 0x7f);
			}
			baseOffset = offset - distance;
			deltaStart = at;
			if (baseOffset < 0 || baseOffset >= offset) throw new Error("ofs-delta base offset out of range");
		} else if (header.typeNumber === 7) {
			const baseSha = bytesToHex(this.pack.subarray(header.dataOffset, header.dataOffset + 20));
			const index = this.findIndex(hexToBytes(baseSha));
			if (index < 0) throw new Error(`ref-delta base ${baseSha} not in pack`);
			baseOffset = this.offsets[index];
			deltaStart = header.dataOffset + 20;
		} else {
			throw new Error(`unknown pack object type ${header.typeNumber}`);
		}
		const delta = inflateSync(this.pack.subarray(deltaStart));
		const base = this.resolveAt(baseOffset, depthLeft - 1);
		return { type: base.type, body: applyDelta(delta, base.body) };
	}
}
