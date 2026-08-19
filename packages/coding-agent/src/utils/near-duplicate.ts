/**
 * Deterministic near-duplicate detection over short texts.
 *
 * Exact-match dedupe only catches byte-identical bodies, which misses the shapes
 * that actually recur: an article truncated at a different length, the same
 * article behind a wire-service prefix, a memory re-saved with a sentence
 * appended. Those all cost their tokens twice.
 *
 * Two independent signals must agree before anything collapses.
 *
 * 1. Shingle overlap. Jaccard over word 3-grams, which is order-sensitive -- two
 *    texts built from the same words in a different order ("route DU to AKS,
 *    never k0s" against "route k0s to the node, never DU to AKS") share almost no
 *    3-grams and score 0, while a bag-of-words measure ranks them ABOVE a genuine
 *    reword. Jaccard's length penalty also defeats the containment trap, where a
 *    short text embedded verbatim in a much longer one looks like a perfect match.
 *
 * 2. One-sidedness. Overlap alone is a token-edit-distance proxy: it weights a
 *    difference by its share of the token budget, so a 40-word body differing in a
 *    single token scores 0.95. That is exactly inverted for the texts this runs
 *    on, where the one token that differs -- `replicas 3` against `replicas 12`,
 *    `staging` against `production`, one correlation id against another -- is the
 *    entire information content. So a collapse additionally requires that the
 *    difference be one-sided: one text's tokens must be a subset of the other's.
 *    Truncation, a prepended source, an appended sentence and pure reordering are
 *    all one-sided; a substitution is not.
 *
 * A numeric token appearing on only one side also blocks the collapse, since
 * quantities are the payload of exactly the templated records that are otherwise
 * indistinguishable.
 *
 * Two known limits. Scripts written without spaces (Chinese, Japanese, Korean)
 * tokenise into one "word" per clause or per text, so a fingerprint is usually
 * undefined and near-duplicate detection simply does not engage -- it fails safe,
 * toward keeping both copies. `splitCjkRuns` in memory-search.ts solves this for the
 * BM25 tokenizer and is the model to follow if this becomes worth fixing.
 *
 * The other is that what this deliberately does NOT catch is semantic rewording -- the same lesson
 * said in different words. That is not a threshold in need of tuning: the highest
 * scoring pair by word overlap in the calibration fixture is a pair that means the
 * OPPOSITE of its twin. Separating those needs meaning, not lexical overlap, so
 * this stays conservative and leaves them to a human or an embedding.
 */

/** Word 3-grams; the smallest window that still encodes order. */
const SHINGLE_SIZE = 3;

/** Fewer shingles than this and the ratio is noise rather than a signal. */
const MIN_SHINGLES = 4;

/** Midpoint of the measured separation between duplicate and non-duplicate pairs. */
export const NEAR_DUPLICATE_THRESHOLD = 0.5;

const DIGIT = /\p{N}/u;

export interface TextFingerprint {
	/** Order-sensitive word 3-grams. */
	shingles: Set<string>;
	/** Distinct words, for the one-sidedness test. */
	tokens: Set<string>;
}

/**
 * Fingerprint of a text, or `undefined` when it is too short to fingerprint.
 * Callers should treat `undefined` as "not comparable" rather than "not similar",
 * and fall back to exact matching.
 */
export function textFingerprint(text: string): TextFingerprint | undefined {
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
	if (shingles.size < MIN_SHINGLES) return undefined;
	return { shingles, tokens: new Set(words) };
}

/** Jaccard overlap of two fingerprints' shingles; 0 when either is missing. */
export function fingerprintSimilarity(left: TextFingerprint | undefined, right: TextFingerprint | undefined): number {
	if (!left || !right || left.shingles.size === 0 || right.shingles.size === 0) return 0;
	// Iterate the smaller set: the intersection is the same either way.
	const [small, large] =
		left.shingles.size <= right.shingles.size ? [left.shingles, right.shingles] : [right.shingles, left.shingles];
	let intersection = 0;
	for (const shingle of small) {
		if (large.has(shingle)) intersection += 1;
	}
	return intersection / (left.shingles.size + right.shingles.size - intersection);
}

/** Words present in `from` and absent from `other`. */
function extraTokens(from: Set<string>, other: Set<string>): string[] {
	const extra: string[] = [];
	for (const token of from) {
		if (!other.has(token)) extra.push(token);
	}
	return extra;
}

/**
 * Whether the two texts differ only by addition on one side. A substitution shows
 * up as both sides holding a token the other lacks, and is never a duplicate here.
 * A number present on only one side blocks the collapse even when one-sided.
 */
function differenceIsOneSided(left: TextFingerprint, right: TextFingerprint): boolean {
	const onlyLeft = extraTokens(left.tokens, right.tokens);
	const onlyRight = extraTokens(right.tokens, left.tokens);
	if (onlyLeft.length > 0 && onlyRight.length > 0) return false;
	return !onlyLeft.some((token) => DIGIT.test(token)) && !onlyRight.some((token) => DIGIT.test(token));
}

/** Whether two fingerprints describe substantially the same text. */
export function isNearDuplicate(left: TextFingerprint | undefined, right: TextFingerprint | undefined): boolean {
	if (!left || !right) return false;
	if (fingerprintSimilarity(left, right) < NEAR_DUPLICATE_THRESHOLD) return false;
	return differenceIsOneSided(left, right);
}
