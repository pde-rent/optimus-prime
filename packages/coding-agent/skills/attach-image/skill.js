/**
 * Prime Agent attach-image skill: load on-disk images into the model's context
 * as viewable multimodal attachments.
 *
 * Images are emitted through the REPL `display()` bridge, which turns them into
 * image content blocks on the tool result — the same path a pasted image takes.
 * Decoding, EXIF orientation, compositing and JPEG re-encoding use the Photon
 * (Rust/WASM) image library that ships with the agent; no extra dependency.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

// Keep emitted attachments small enough that daemon clients can render and replay
// image-heavy sessions without compressing megabytes of base64 on every update.
const MAX_SOURCE_IMAGE_BYTES = 20_000_000;
const MAX_SOURCE_IMAGE_PIXELS = 36_000_000;
const MAX_ATTACHMENT_DATA_CHARS = 350_000;
const MAX_ATTACHMENT_DIMENSION = 1200;
const JPEG_QUALITIES = [82, 72, 60, 48, 36];

// Matches IMAGE_MIME_TYPES in src/utils/mime.ts.
const IMAGE_SIGNATURES = [
	["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
	["image/jpeg", [0xff, 0xd8, 0xff]],
	["image/gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
	["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
];

function startsWith(bytes, prefix) {
	if (bytes.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
	return true;
}

function detectImageMime(bytes) {
	for (const [mime, prefix] of IMAGE_SIGNATURES) {
		if (startsWith(bytes, prefix)) return mime;
	}
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
		return "image/webp";
	}
	return null;
}

/** Read image dimensions straight from the container header (no full decode). */
function headerDimensions(bytes, mime) {
	if (mime === "image/png" && bytes.length >= 24) {
		return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	}
	if (mime === "image/gif" && bytes.length >= 10) {
		return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
	}
	if (mime === "image/webp") return webpDimensions(bytes);
	if (mime === "image/jpeg") return jpegDimensions(bytes);
	return null;
}

function webpDimensions(bytes) {
	const fourcc = bytes.toString("ascii", 12, 16);
	if (fourcc === "VP8X" && bytes.length >= 30) {
		const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
		const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
		return [w, h];
	}
	if (fourcc === "VP8 " && bytes.length >= 30) {
		return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
	}
	if (fourcc === "VP8L" && bytes.length >= 25) {
		const bits = bytes.readUInt32LE(21);
		return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
	}
	return null;
}

function jpegDimensions(bytes) {
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = bytes.readUInt16BE(offset + 2);
		// SOF0-SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
		}
		offset += 2 + length;
	}
	return null;
}

/** Heuristic multi-frame detection; only used to annotate the flattening note. */
function isAnimated(bytes, mime) {
	if (mime === "image/gif") {
		let frames = 0;
		for (let i = 0; i + 2 < bytes.length && frames < 2; i++) {
			if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) frames++;
		}
		return frames > 1;
	}
	const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("latin1");
	if (mime === "image/webp") return head.includes("ANIM");
	if (mime === "image/png") return head.includes("acTL");
	return false;
}

/**
 * Decode with `Bun.Image`, which applies EXIF orientation and takes the first frame of an
 * animation while decoding, so the rotate/flip and frame handling that used to live here is
 * no longer needed.
 */
function decode(bytes, label) {
	try {
		return new Bun.Image(bytes);
	} catch {
		throw new Error(`${label} is not a readable supported image (PNG, JPEG, GIF, WebP).`);
	}
}

/**
 * True when the container declares an alpha channel.
 *
 * Read from the header rather than scanned per pixel: the decoder no longer exposes raw
 * pixels, and this only drives a note, so a declared-but-unused alpha channel is acceptable.
 */
function hasAlphaChannel(bytes, mimeType) {
	if (mimeType === "image/png") {
		// PNG colour type lives at byte 25 of the IHDR chunk: 4 and 6 carry alpha.
		const colorType = bytes[25];
		return colorType === 4 || colorType === 6;
	}
	if (mimeType === "image/gif") return true;
	if (mimeType === "image/webp") {
		// Extended WebP flags the alpha bit in the VP8X chunk.
		return bytes.length > 20 && bytes.toString("latin1", 12, 16) === "VP8X" && (bytes[20] & 0x10) !== 0;
	}
	return false;
}

function base64Chars(byteLength) {
	return Math.floor((byteLength + 2) / 3) * 4;
}

/**
 * Prepare the emitted payload: pass the original bytes through when they are
 * already small enough, otherwise downscale and re-encode as JPEG.
 * Returns `[base64, mimeType, note]`.
 */
async function resizeForAttachment(filepath, mimeType, size, dimensions, bytes) {
	const encodedChars = base64Chars(bytes.length);
	if (
		size <= Math.floor((MAX_ATTACHMENT_DATA_CHARS * 3) / 4) &&
		Math.max(dimensions[0], dimensions[1]) <= MAX_ATTACHMENT_DIMENSION &&
		encodedChars <= MAX_ATTACHMENT_DATA_CHARS
	) {
		return [bytes.toString("base64"), mimeType, null];
	}

	const notes = [];
	if (isAnimated(bytes, mimeType)) notes.push("animated image flattened to first frame");
	if (hasAlphaChannel(bytes, mimeType)) {
		// JPEG has no alpha, so the encoder flattens it; say so rather than let the colours
		// change silently.
		notes.push("transparent pixels flattened by the JPEG encoder");
	}
	const conversionNote = notes.length > 0 ? notes.join("; ") : null;

	{
		const meta = await decode(bytes, filepath).metadata();
		const originalWidth = meta.width;
		const originalHeight = meta.height;
		const scale = Math.min(1, MAX_ATTACHMENT_DIMENSION / Math.max(originalWidth, originalHeight));
		let targetWidth = Math.max(1, Math.round(originalWidth * scale));
		let targetHeight = Math.max(1, Math.round(originalHeight * scale));
		let lastLength = 0;
		let lastWidth = targetWidth;
		let lastHeight = targetHeight;

		while (targetWidth >= 1 && targetHeight >= 1) {
			for (const quality of JPEG_QUALITIES) {
				// A fresh instance per encode: operations chain onto one, so reusing it
				// would resize the already-resized result.
				const candidate = Buffer.from(
					await new Bun.Image(bytes).resize(targetWidth, targetHeight).jpeg({ quality }).bytes(),
				);
				lastLength = candidate.length;
				lastWidth = targetWidth;
				lastHeight = targetHeight;
				if (base64Chars(candidate.length) <= MAX_ATTACHMENT_DATA_CHARS) {
					let note =
						`original ${originalWidth}x${originalHeight}; attached ` +
						`${targetWidth}x${targetHeight} JPEG at quality ${quality}`;
					if (conversionNote) note += `; ${conversionNote}`;
					return [candidate.toString("base64"), "image/jpeg", note];
				}
			}

			const nextWidth = Math.max(1, Math.trunc(targetWidth * 0.75));
			const nextHeight = Math.max(1, Math.trunc(targetHeight * 0.75));
			if (nextWidth === targetWidth && nextHeight === targetHeight) break;
			targetWidth = nextWidth;
			targetHeight = nextHeight;
		}

		throw new Error(
			`${filepath} could not be compressed below ${Math.floor(MAX_ATTACHMENT_DATA_CHARS / 1000)}KB base64 payload ` +
				`(smallest was ${Math.floor(base64Chars(lastLength) / 1000)}KB at ${lastWidth}x${lastHeight}).`,
		);
	}
}

function expandUser(path, cwd) {
	let expanded = path;
	if (expanded === "~") expanded = homedir();
	else if (expanded.startsWith("~/")) expanded = resolvePath(homedir(), expanded.slice(2));
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

async function validateImage(path, cwd) {
	const filepath = expandUser(path, cwd);
	let stats;
	try {
		stats = await stat(filepath);
	} catch {
		throw new Error(`${path} is not an existing regular file`);
	}
	if (!stats.isFile()) throw new Error(`${path} is not an existing regular file`);

	const size = stats.size;
	if (size > MAX_SOURCE_IMAGE_BYTES) {
		throw new Error(
			`${path} is ${Math.floor(size / 1_000_000)}MB; images must be under ` +
				`${Math.floor(MAX_SOURCE_IMAGE_BYTES / 1_000_000)}MB. Resize it first.`,
		);
	}

	const bytes = await readFile(filepath);
	const mime = detectImageMime(bytes);
	if (mime === null) {
		throw new Error(
			`${path} is not a supported image (PNG, JPEG, GIF, WebP). ` +
				"Only images can be loaded into context; open other files in the REPL instead.",
		);
	}

	// Reject by header pixel count before paying for a full decode.
	const headerDims = headerDimensions(bytes, mime);
	if (headerDims) {
		const pixels = headerDims[0] * headerDims[1];
		if (pixels > MAX_SOURCE_IMAGE_PIXELS) {
			throw new Error(
				`${path} is ${headerDims[0]}x${headerDims[1]} (${Math.floor(pixels / 1_000_000)}MP); ` +
					`images must be at most ${Math.floor(MAX_SOURCE_IMAGE_PIXELS / 1_000_000)}MP. Resize it first.`,
			);
		}
	}

	// Full decode: proves the file is really readable, and yields authoritative dimensions.
	const meta = await decode(bytes, path).metadata();
	const dimensions = [meta.width, meta.height];
	const pixelCount = dimensions[0] * dimensions[1];
	if (pixelCount > MAX_SOURCE_IMAGE_PIXELS) {
		throw new Error(
			`${path} is ${dimensions[0]}x${dimensions[1]} (${Math.floor(pixelCount / 1_000_000)}MP); ` +
				`images must be at most ${Math.floor(MAX_SOURCE_IMAGE_PIXELS / 1_000_000)}MP. Resize it first.`,
		);
	}

	return { filepath, mime, size, dimensions, bytes };
}

export default function createSkill({ hostRequest, display, cwd }) {
	return {
		/**
		 * Load one or more on-disk images into the model's context as attachments.
		 *
		 * Use this when the model needs to actually SEE an image file — a screenshot,
		 * diagram, chart, photo, or scanned page. The image is sent to the model as a
		 * viewable attachment (the same way a pasted image is).
		 *
		 * Do NOT use this for programmatic image analysis (reading pixels, cropping,
		 * resizing, hashing, measuring colors). For that, open the file in the REPL
		 * with an image library instead.
		 *
		 * @param {...string} paths One or more image paths. Relative (resolved against
		 *   the REPL cwd), absolute, or `~`-prefixed. Supported formats: PNG, JPEG,
		 *   GIF, WebP. Other types (PDF, audio, video) are not supported and throw.
		 * @returns {Promise<string>} A short confirmation listing the images loaded.
		 * @throws {Error} If a path does not exist or is not a regular file, if a file
		 *   is not a supported image, is too large, cannot be compressed enough for
		 *   safe inline rendering and replay, or if the model cannot accept images.
		 */
		async run(...paths) {
			if (paths.length === 0) throw new Error("attach_image requires at least one image path");

			const info = (await hostRequest("model.info", {})) ?? {};
			const inputs = Array.isArray(info.input) ? info.input : [];
			if (!inputs.includes("image")) {
				const modelId = info.id || "the current model";
				throw new Error(
					`${modelId} does not support vision. ` +
						"Tell the user to switch to a vision-capable model to load images into context.",
				);
			}

			// Validate every path before emitting anything, so a later failure never
			// leaves a partial subset injected.
			const validated = [];
			for (const path of paths) validated.push(await validateImage(path, cwd));

			const resizeNotes = [];
			for (const { filepath, mime, size, dimensions, bytes } of validated) {
				const [data, emittedMime, note] = await resizeForAttachment(filepath, mime, size, dimensions, bytes);
				display({ mimeType: emittedMime, data });
				if (note) resizeNotes.push(`${filepath}: ${note}`);
			}

			let message = `Loaded ${validated.length} image(s) into context: ${paths.join(", ")}`;
			if (resizeNotes.length > 0) {
				message += `\nResized for efficient inline rendering/replay:\n- ${resizeNotes.join("\n- ")}`;
			}
			return message;
		},
	};
}
