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
const TRANSPARENCY_BACKGROUND = [0x88, 0x88, 0x88];
const TRANSPARENCY_BACKGROUND_LABEL = "#888888";
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

/** JPEG EXIF orientation tag (1-8), or 1 when absent/unreadable. */
function exifOrientation(bytes, mime) {
	if (mime !== "image/jpeg") return 1;
	let offset = 2;
	while (offset + 4 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xda) return 1; // start of scan: no EXIF found
		const length = bytes.readUInt16BE(offset + 2);
		if (marker === 0xe1 && bytes.toString("ascii", offset + 4, offset + 10) === "Exif\0\0") {
			return readExifOrientation(bytes, offset + 10);
		}
		offset += 2 + length;
	}
	return 1;
}

function readExifOrientation(bytes, tiff) {
	if (tiff + 8 > bytes.length) return 1;
	const endian = bytes.toString("ascii", tiff, tiff + 2);
	if (endian !== "II" && endian !== "MM") return 1;
	const little = endian === "II";
	const u16 = (at) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
	const u32 = (at) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
	const ifd = tiff + u32(tiff + 4);
	if (ifd + 2 > bytes.length) return 1;
	const count = u16(ifd);
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > bytes.length) break;
		if (u16(entry) === 0x0112) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

async function loadPhoton() {
	try {
		return await import("@silvia-odwyer/photon-node");
	} catch (error) {
		throw new Error(
			`attach_image needs the photon image library to inspect this image before loading it into context: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function decode(photon, bytes, label) {
	try {
		return photon.PhotonImage.new_from_byteslice(new Uint8Array(bytes));
	} catch {
		throw new Error(`${label} is not a readable supported image (PNG, JPEG, GIF, WebP).`);
	}
}

function rotate90Steps(photon, image, orientation) {
	// EXIF orientations 5-8 are the transposed quadrants; 3/4 are the 180 pair.
	const angle = orientation === 3 || orientation === 4 ? 180 : orientation === 5 || orientation === 6 ? 90 : 270;
	const rotated = photon.rotate(image, angle);
	image.free();
	return rotated;
}

/** Apply an EXIF orientation in place / by replacement, returning the upright image. */
function applyOrientation(photon, image, orientation) {
	if (orientation <= 1) return image;
	let out = image;
	if (orientation !== 2) out = rotate90Steps(photon, out, orientation);
	if (orientation === 2 || orientation === 4 || orientation === 5 || orientation === 7) photon.fliph(out);
	return out;
}

/** True when any pixel carries partial or full transparency. */
function hasTransparency(pixels) {
	for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
	return false;
}

function compositeOnBackground(photon, image) {
	const pixels = image.get_raw_pixels();
	const [bgR, bgG, bgB] = TRANSPARENCY_BACKGROUND;
	for (let i = 0; i < pixels.length; i += 4) {
		const a = pixels[i + 3];
		if (a === 255) continue;
		const k = a / 255;
		pixels[i] = Math.round(pixels[i] * k + bgR * (1 - k));
		pixels[i + 1] = Math.round(pixels[i + 1] * k + bgG * (1 - k));
		pixels[i + 2] = Math.round(pixels[i + 2] * k + bgB * (1 - k));
		pixels[i + 3] = 255;
	}
	const flattened = new photon.PhotonImage(pixels, image.get_width(), image.get_height());
	image.free();
	return flattened;
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

	const photon = await loadPhoton();
	const notes = [];
	if (isAnimated(bytes, mimeType)) notes.push("animated image flattened to first frame");

	let image = applyOrientation(photon, decode(photon, bytes, filepath), exifOrientation(bytes, mimeType));
	if (hasTransparency(image.get_raw_pixels())) {
		notes.push(`transparent pixels composited on ${TRANSPARENCY_BACKGROUND_LABEL} background`);
		image = compositeOnBackground(photon, image);
	}
	const conversionNote = notes.length > 0 ? notes.join("; ") : null;

	try {
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const scale = Math.min(1, MAX_ATTACHMENT_DIMENSION / Math.max(originalWidth, originalHeight));
		let targetWidth = Math.max(1, Math.round(originalWidth * scale));
		let targetHeight = Math.max(1, Math.round(originalHeight * scale));
		let lastLength = 0;
		let lastWidth = targetWidth;
		let lastHeight = targetHeight;

		while (targetWidth >= 1 && targetHeight >= 1) {
			const resized = photon.resize(image, targetWidth, targetHeight, photon.SamplingFilter.Lanczos3);
			try {
				for (const quality of JPEG_QUALITIES) {
					const candidate = Buffer.from(resized.get_bytes_jpeg(quality));
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
			} finally {
				resized.free();
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
	} finally {
		image.free();
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
	const photon = await loadPhoton();
	const image = decode(photon, bytes, path);
	let dimensions;
	try {
		dimensions = [image.get_width(), image.get_height()];
	} finally {
		image.free();
	}
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
