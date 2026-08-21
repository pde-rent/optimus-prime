/**
 * Pasted images are represented in the editor as `[image #N]` markers while the
 * image bytes are held aside in a registry keyed by N. The markers present in
 * the submitted text decide which images are attached to the prompt, so deleting
 * a marker drops its image and restoring it (undo, history, retry) brings it back
 * as long as the bytes are still in the registry.
 */

/** Matches `[image #N]` markers inserted when an image is pasted into the editor. */
const IMAGE_MARKER_REGEX = /\[image #(\d+)\]/g;

/** The marker text inserted into the editor for pasted image `id`. */
export function formatImageMarker(id: number): string {
	return `[image #${id}]`;
}

/** Marker ids that appear in `text`, in order of appearance. */
export function imageMarkerIds(text: string): number[] {
	return [...text.matchAll(IMAGE_MARKER_REGEX)]
		.map((match) => Number(match[1]))
		.filter((id) => Number.isSafeInteger(id));
}

/** Replace every image-marker spelling whose numeric id appears in `remaps`. */
export function remapImageMarkers(text: string, remaps: ReadonlyMap<number, number>): string {
	return text.replace(IMAGE_MARKER_REGEX, (marker, id: string) => {
		const replacement = remaps.get(Number(id));
		return replacement === undefined ? marker : formatImageMarker(replacement);
	});
}

/**
 * Split bracketed-paste text into path candidates. Terminals escape whitespace
 * when inserting a dragged file ("/a/b\ c.png") or quote the whole path
 * ('"/a/b c.png"'), so a plain whitespace split destroys any path containing a
 * space. Backslash escapes and matching quotes are resolved here; unterminated
 * quotes keep their content.
 */
export function parsePastedTokens(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (char === "\\") {
			const next = text[i + 1];
			if (next !== undefined) {
				current += next;
				started = true;
				i++;
				continue;
			}
		}
		if (quote === undefined && (char === '"' || char === "'")) {
			quote = char;
			started = true;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			continue;
		}
		if (quote === undefined && /\s/.test(char)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}
	if (started) {
		tokens.push(current);
	}
	return tokens;
}

/**
 * Images from `pending` whose marker still appears in `text`, in paste order
 * (the map's insertion order). Each image is returned at most once even if its
 * marker is duplicated in the text.
 */
export function collectMarkedImages<T>(pending: ReadonlyMap<number, T>, text: string): T[] {
	if (pending.size === 0) {
		return [];
	}
	const present = new Set(imageMarkerIds(text));
	const images: T[] = [];
	for (const [id, image] of pending) {
		if (present.has(id)) {
			images.push(image);
		}
	}
	return images;
}

/**
 * Evict oldest entries (insertion order) from `images` until the total of
 * `sizeOf` is within `maxBytes`. Ids in `keep` are never evicted, so an image
 * whose marker is still live retains its bytes even if that holds the total
 * above the cap.
 */
export function evictImagesToBudget<T>(
	images: Map<number, T>,
	sizeOf: (value: T) => number,
	maxBytes: number,
	keep: ReadonlySet<number>,
): void {
	let total = 0;
	for (const value of images.values()) {
		total += sizeOf(value);
	}
	for (const key of [...images.keys()]) {
		if (total <= maxBytes) {
			break;
		}
		if (keep.has(key)) {
			continue;
		}
		const value = images.get(key);
		if (value !== undefined) {
			total -= sizeOf(value);
			images.delete(key);
		}
	}
}
