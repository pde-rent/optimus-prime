import { open } from "node:fs/promises";
import { imageMimeTypeFromBuffer } from "./image-sniff.js";

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const FILE_TYPE_SNIFF_BYTES = 4100;

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
		if (bytesRead === 0) {
			return null;
		}

		const mime = imageMimeTypeFromBuffer(buffer.subarray(0, bytesRead));
		if (!mime || !IMAGE_MIME_TYPES.has(mime)) {
			return null;
		}

		return mime;
	} finally {
		await fileHandle.close();
	}
}
