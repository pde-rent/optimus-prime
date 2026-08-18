/**
 * Image type detection from magic bytes. Replaces `file-type`.
 *
 * Only the four image formats the attachment pipeline accepts are recognised, which is the
 * entire surface that was ever used. Sniffing reads the file's own bytes rather than trusting
 * its extension: this runs on untrusted input, so `Bun.file().type` (which guesses from the
 * name) is deliberately not used here.
 */

/** Byte signatures, checked in order. `null` in a pattern matches any byte. */
const SIGNATURES: ReadonlyArray<{ mime: string; offset: number; bytes: ReadonlyArray<number | null> }> = [
	// PNG: \x89PNG\r\n\x1a\n
	{ mime: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	// JPEG: FF D8 FF — every variant (JFIF, Exif, raw) shares this prefix.
	{ mime: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
	// GIF: "GIF87a" or "GIF89a"
	{ mime: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, null, 0x61] },
	// WebP: "RIFF" ???? "WEBP" — the four size bytes at offset 4 are skipped.
	{ mime: "image/webp", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
];

function matches(buffer: Uint8Array, offset: number, pattern: ReadonlyArray<number | null>): boolean {
	if (buffer.length < offset + pattern.length) return false;
	for (let i = 0; i < pattern.length; i += 1) {
		const expected = pattern[i];
		if (expected !== null && buffer[offset + i] !== expected) return false;
	}
	return true;
}

/**
 * Identify an image from its leading bytes.
 *
 * @param buffer - The head of the file; 12 bytes is enough for every signature here.
 * @returns The detected MIME type, or `undefined` when nothing matches.
 */
export function imageMimeTypeFromBuffer(buffer: Uint8Array): string | undefined {
	for (const { mime, offset, bytes } of SIGNATURES) {
		if (!matches(buffer, offset, bytes)) continue;
		// A signature alone is not a file. PNG's first chunk must be IHDR, which rejects a
		// truncated or fabricated header that would otherwise be attached as a valid image.
		if (mime === "image/png" && !matches(buffer, 12, [0x49, 0x48, 0x44, 0x52])) continue;
		return mime;
	}
	return undefined;
}
