import { describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import { snippetFingerprint, snippetSimilarity } from "../skills/websearch/skill.js";
import {
	fingerprintSimilarity,
	isNearDuplicate,
	NEAR_DUPLICATE_THRESHOLD,
	textFingerprint,
} from "../src/utils/near-duplicate.js";

const ARTICLE =
	"Bun implements a fast all-in-one JavaScript runtime with a bundler, test runner and package manager built in.";

describe("textFingerprint", () => {
	it("returns undefined for text too short to fingerprint", () => {
		expect(textFingerprint("")).toBeUndefined();
		expect(textFingerprint("deploy now")).toBeUndefined();
		// Three words make exactly one shingle, which is below the minimum.
		expect(textFingerprint("deploy from main")).toBeUndefined();
	});

	it("ignores casing and punctuation", () => {
		const plain = textFingerprint(ARTICLE);
		const shouted = textFingerprint(ARTICLE.toUpperCase().replace(/[.,]/g, " !! "));
		expect(fingerprintSimilarity(plain, shouted)).toBe(1);
	});

	it("scores a text against itself as 1 and against nothing as 0", () => {
		const fingerprint = textFingerprint(ARTICLE);
		expect(fingerprintSimilarity(fingerprint, fingerprint)).toBe(1);
		expect(fingerprintSimilarity(fingerprint, undefined)).toBe(0);
	});
});

describe("isNearDuplicate", () => {
	const cases: { name: string; a: string; b: string; duplicate: boolean }[] = [
		{
			name: "same article truncated differently",
			duplicate: true,
			a: ARTICLE,
			b: "Bun implements a fast all-in-one JavaScript runtime with a bundler, test runner and package",
		},
		{ name: "same article behind a wire-service prefix", duplicate: true, a: ARTICLE, b: `(Reuters) - ${ARTICLE}` },
		{
			name: "same body with a sentence appended",
			duplicate: true,
			a: "The daemon inherits the runtime of whatever launched it. Bun ignores npmrc, so registry overrides there do nothing.",
			b: "The daemon inherits the runtime of whatever launched it. Bun ignores npmrc, so registry overrides there do nothing. Check which binary started it.",
		},
		{
			// Order-sensitivity is the whole point: these two share nearly every word but
			// mean the opposite, and a bag-of-words measure ranks them ABOVE a real reword.
			name: "same words in a different order meaning the opposite",
			duplicate: false,
			a: "Route DU workloads to AKS and never to the k0s node.",
			b: "Route k0s workloads to the node and never DU to AKS.",
		},
		{
			// Jaccard's length penalty is what defeats the containment trap.
			name: "short text embedded verbatim in a much longer one",
			duplicate: false,
			a: "The keeper service signs every order before submission.",
			b: "The keeper service signs every order before submission and refuses to start when the signing key is absent from the environment. It also rotates the nonce per block, retries on revert, and reports fill ratios to the dashboard every minute.",
		},
		{
			name: "shared boilerplate opener but different body",
			duplicate: false,
			a: "This project uses Bun exclusively. The test runner is invoked with bun test from the package directory.",
			b: "This project uses Bun exclusively. The formatter is biome with tab indentation, never prettier.",
		},
	];

	for (const { name, a, b, duplicate } of cases) {
		it(`${duplicate ? "collapses" : "keeps"}: ${name}`, () => {
			expect(isNearDuplicate(textFingerprint(a), textFingerprint(b))).toBe(duplicate);
		});
	}

	it("does not claim to catch semantic rewording", () => {
		// Documented limit, asserted so nobody assumes otherwise: the same lesson in
		// different words shares almost no 3-grams. Catching this needs meaning, so the
		// measure stays conservative rather than guessing.
		const a =
			"Never run kubectl patch against the sitp workloads. Argo selfHeal reverts the change within sixty seconds.";
		const b =
			"Do not use kubectl patch on the sitp workloads; Argo selfHeal will revert the change in about sixty seconds.";
		expect(isNearDuplicate(textFingerprint(a), textFingerprint(b))).toBe(false);
	});
});

describe("skill/core parity", () => {
	// Skills are copied wholesale into the bundle and cannot import from src, so the
	// near-duplicate logic exists twice. This is the guard against silent drift.
	const texts = [
		ARTICLE,
		`(Reuters) - ${ARTICLE}`,
		"Bun implements a fast all-in-one JavaScript runtime with a bundler, test runner and package",
		"The Bun test runner discovers files matching the test glob and runs them in parallel with an isolated registry.",
		"Route DU workloads to AKS and never to the k0s node, because cross-deployment counts as a breach of the routing rule.",
	];

	it("agrees with the core primitive on every pair", () => {
		for (const left of texts) {
			for (const right of texts) {
				expect(snippetSimilarity(snippetFingerprint(left), snippetFingerprint(right))).toBeCloseTo(
					fingerprintSimilarity(textFingerprint(left), textFingerprint(right)),
					10,
				);
			}
		}
	});

	it("shares the same threshold", () => {
		const b = `(Reuters) - ${ARTICLE}`;
		const skillSays =
			snippetSimilarity(snippetFingerprint(ARTICLE), snippetFingerprint(b)) >= NEAR_DUPLICATE_THRESHOLD;
		expect(skillSays).toBe(isNearDuplicate(textFingerprint(ARTICLE), textFingerprint(b)));
	});
});
