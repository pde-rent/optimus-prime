/**
 * UUID v7 generation. Replaces the `uuid` package.
 *
 * Only `v7` was ever used. `crypto.randomUUID()` is v4 and is NOT a substitute: v7 embeds a
 * millisecond timestamp in its high bits, so v7 ids sort lexicographically by creation time,
 * which is what the session store relies on.
 *
 * Layout (RFC 9562 §5.7):
 *   48 bits  unix_ts_ms   big-endian
 *    4 bits  version      = 7
 *   12 bits  rand_a
 *    2 bits  variant      = 0b10
 *   62 bits  rand_b
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * Generate a UUID v7.
 *
 * @returns A lowercase, hyphenated v7 UUID that sorts by creation time.
 */
export function v7(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	// 48-bit big-endian millisecond timestamp.
	const ms = Date.now();
	bytes[0] = (ms / 0x10000000000) & 0xff;
	bytes[1] = (ms / 0x100000000) & 0xff;
	bytes[2] = (ms / 0x1000000) & 0xff;
	bytes[3] = (ms / 0x10000) & 0xff;
	bytes[4] = (ms / 0x100) & 0xff;
	bytes[5] = ms & 0xff;

	// Version 7 in the high nibble of byte 6; variant 0b10 in the top bits of byte 8.
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;

	const h = HEX;
	return (
		h[bytes[0]!]! +
		h[bytes[1]!]! +
		h[bytes[2]!]! +
		h[bytes[3]!]! +
		"-" +
		h[bytes[4]!]! +
		h[bytes[5]!]! +
		"-" +
		h[bytes[6]!]! +
		h[bytes[7]!]! +
		"-" +
		h[bytes[8]!]! +
		h[bytes[9]!]! +
		"-" +
		h[bytes[10]!]! +
		h[bytes[11]!]! +
		h[bytes[12]!]! +
		h[bytes[13]!]! +
		h[bytes[14]!]! +
		h[bytes[15]!]!
	);
}
