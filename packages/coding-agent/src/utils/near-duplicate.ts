/**
 * Deterministic near-duplicate detection over short texts.
 *
 * Exact-match dedupe only catches byte-identical bodies, which misses the shapes
 * that actually recur: an article truncated at a different length, the same
 * article behind a wire-service prefix, a memory re-saved with a typo fixed or a
 * sentence appended. Those all cost their tokens twice.
 *
 * The measure is Jaccard overlap of word 3-grams. Shingles are order-sensitive,
 * which is what makes this safe: two texts built from the same words in a
 * different order -- "route DU to AKS, never k0s" against "route k0s to the node,
 * never DU to AKS" -- share almost no 3-grams and score 0, while a bag-of-words
 * measure scores them higher than a genuine reword. Jaccard's length penalty also
 * removes the containment trap, where a short text embedded verbatim in a much
 * longer one would otherwise look like a perfect match.
 *
 * On a labelled fixture of duplicate and non-duplicate pairs, the lowest genuine
 * duplicate scores 0.70 and the highest non-duplicate 0.30, so the threshold sits
 * midway with margin on both sides. Stopwords are deliberately NOT stripped: it
 * widens the margin slightly but would bake an English-only word list into a
 * primitive that also sees CJK and code identifiers.
 *
 * What this deliberately does NOT catch is semantic rewording -- the same lesson
 * said in different words. That is not a threshold that needs tuning: on the same
 * fixture, the highest-scoring pair by word overlap is a pair that means the
 * OPPOSITE of its twin. Separating those needs meaning, not lexical overlap, so
 * this stays conservative and leaves them to a human or an embedding.
 */

/** Word 3-grams; the smallest window that still encodes order. */
const SHINGLE_SIZE = 3;

/** Fewer shingles than this and the ratio is noise rather than a signal. */
const MIN_SHINGLES = 4;

/** Midpoint of the measured separation between duplicate and non-duplicate pairs. */
export const NEAR_DUPLICATE_THRESHOLD = 0.5;

/**
 * Order-sensitive fingerprint of a text, or `undefined` when it is too short to
 * fingerprint. Callers should treat `undefined` as "not comparable" rather than
 * "not similar", and fall back to exact matching.
 */
export function textFingerprint(text: string): Set<string> | undefined {
	const words = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
	if (words.length < SHINGLE_SIZE) return undefined;
	const shingles = new Set<string>();
	for (let index = 0; index + SHINGLE_SIZE <= words.length; index++) {
		shingles.add(words.slice(index, index + SHINGLE_SIZE).join(" "));
	}
	return shingles.size >= MIN_SHINGLES ? shingles : undefined;
}

/** Jaccard overlap of two fingerprints; 0 when either is missing. */
export function fingerprintSimilarity(left: Set<string> | undefined, right: Set<string> | undefined): number {
	if (!left || !right || left.size === 0 || right.size === 0) return 0;
	// Iterate the smaller set: the intersection is the same either way.
	const [small, large] = left.size <= right.size ? [left, right] : [right, left];
	let intersection = 0;
	for (const shingle of small) {
		if (large.has(shingle)) intersection += 1;
	}
	return intersection / (left.size + right.size - intersection);
}

/** Whether two fingerprints describe substantially the same text. */
export function isNearDuplicate(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
	return fingerprintSimilarity(left, right) >= NEAR_DUPLICATE_THRESHOLD;
}
