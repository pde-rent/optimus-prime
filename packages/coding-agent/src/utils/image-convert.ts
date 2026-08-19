/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	try {
		// `Bun.Image` applies EXIF orientation while decoding, so the PNG comes out the way up
		// the photograph was taken.
		const bytes = await new Bun.Image(Buffer.from(base64Data, "base64")).png().bytes();
		return { data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" };
	} catch {
		// Conversion failed
		return null;
	}
}
