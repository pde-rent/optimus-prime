import { describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import { isNearDuplicateSnippet, snippetFingerprint, snippetSimilarity } from "../skills/websearch/skill.js";
import { fingerprintSimilarity, isNearDuplicate, textFingerprint } from "../src/utils/near-duplicate.js";

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

describe("substitution guard", () => {
	// Overlap alone is a token-edit-distance proxy: the more boilerplate around a
	// changed identifier, the higher it scores. These are the texts that measure
	// betrays, and the one-sidedness rule is what rejects them.
	const substitutions: [string, string, string][] = [
		[
			"replica count",
			"The deployment manifest for the rates ingester sets replicas to 3 and requests two hundred millicores of cpu per pod.",
			"The deployment manifest for the rates ingester sets replicas to 12 and requests two hundred millicores of cpu per pod.",
		],
		[
			"environment",
			"Deploy record: environment staging, cluster meshlab dev, image tag built from the release branch and promoted after tests.",
			"Deploy record: environment production, cluster meshlab prod, image tag built from the release branch and promoted after tests.",
		],
		[
			"version",
			"Install the toolkit by downloading version 3.1 from the releases page and adding the extracted binary directory to PATH.",
			"Install the toolkit by downloading version 4.0 from the releases page and adding the extracted binary directory to PATH.",
		],
		[
			"a literal in a code sample",
			"async function retry(fn) { for (let i = 0; i < 5; i++) { try { return await fn(); } catch { await sleep(100); } } }",
			"async function retry(fn) { for (let i = 0; i < 5; i++) { try { return await fn(); } catch { await sleep(500); } } }",
		],
		[
			"a runbook action",
			"Runbook step five: when the sync hangs, restart the deployment and confirm the pods report ready before continuing.",
			"Runbook step five: when the sync hangs, delete the stuck pod and confirm the pods report ready before continuing.",
		],
	];

	for (const [name, a, b] of substitutions) {
		it(`keeps two records differing only in ${name}`, () => {
			// High overlap, deliberately not collapsed: the differing token is the payload.
			expect(fingerprintSimilarity(textFingerprint(a), textFingerprint(b))).toBeGreaterThan(0.4);
			expect(isNearDuplicate(textFingerprint(a), textFingerprint(b))).toBe(false);
		});
	}

	it("still collapses a one-sided difference at the same overlap", () => {
		const a = "Runbook step five: when the sync hangs, restart the deployment and confirm the pods report ready.";
		const b = `${a} Escalate if it is still hanging afterwards.`;
		expect(isNearDuplicate(textFingerprint(a), textFingerprint(b))).toBe(true);
	});

	it("does not collapse a corrected typo, because a substitution cannot be told from an edit", () => {
		// Accepted cost of the guard: re-saving a fact with a typo fixed is structurally
		// identical to changing `replicas 3` to `replicas 12`. Keeping both costs tokens
		// once; collapsing the wrong pair loses information silently.
		const a = "Never run kubectl patch against the sitp workloads because Argo selfHeal revrts the change quickly.";
		const b = "Never run kubectl patch against the sitp workloads because Argo selfHeal reverts the change quickly.";
		expect(isNearDuplicate(textFingerprint(a), textFingerprint(b))).toBe(false);
	});
});

describe("skill/core parity", () => {
	// Skills are copied wholesale into the bundle and cannot import from src, so the
	// near-duplicate logic exists twice. This is the guard against silent drift, and it
	// has to exercise the decision, the undefined boundary and the guard -- not just a
	// pair of long similar strings, which would certify agreement it never checked.
	const LONG_A = ARTICLE;
	const LONG_B = `(Reuters) - ${ARTICLE}`;
	const shared = [
		LONG_A,
		LONG_B,
		"Bun implements a fast all-in-one JavaScript runtime with a bundler, test runner and package",
		"The Bun test runner discovers files matching the test glob and runs them in parallel with an isolated registry.",
		"Route DU workloads to AKS and never to the k0s node, because cross-deployment counts as a breach of the routing rule.",
		"The deployment manifest for the rates ingester sets replicas to 3 and requests two hundred millicores of cpu.",
		"The deployment manifest for the rates ingester sets replicas to 12 and requests two hundred millicores of cpu.",
	];

	it("agrees on similarity for every pair above both length floors", () => {
		for (const left of shared) {
			for (const right of shared) {
				expect(snippetSimilarity(snippetFingerprint(left), snippetFingerprint(right))).toBeCloseTo(
					fingerprintSimilarity(textFingerprint(left), textFingerprint(right)),
					10,
				);
			}
		}
	});

	it("agrees on the collapse decision, including the substitution guard", () => {
		for (const left of shared) {
			for (const right of shared) {
				expect(isNearDuplicateSnippet(snippetFingerprint(left), snippetFingerprint(right))).toBe(
					isNearDuplicate(textFingerprint(left), textFingerprint(right)),
				);
			}
		}
	});

	it("agrees on which texts are too short to fingerprint", () => {
		// Catches a divergent SHINGLE_SIZE or MIN_SHINGLES, which a fixture of long
		// strings would never reach.
		for (const text of ["", "deploy now", "deploy from main", "ha ha ha ha ha ha ha ha"]) {
			expect(snippetFingerprint(text)).toBeUndefined();
			expect(textFingerprint(text)).toBeUndefined();
		}
	});

	it("documents the skill's extra length floor as the one intended difference", () => {
		// The skill drops snippets under 80 chars because a short search snippet is
		// boilerplate; the core primitive has no such floor. This is the only place the
		// two are meant to disagree, so it is asserted rather than left to chance.
		const short = "the retry limit is five attempts per request";
		expect(short.length).toBeLessThan(80);
		expect(snippetFingerprint(short)).toBeUndefined();
		expect(textFingerprint(short)).toBeDefined();
	});

	it("shares the same threshold", () => {
		// A pair close to the threshold, so raising it on one side alone would show up.
		const near = "The Bun test runner discovers files matching the test glob and runs them in parallel.";
		const nearPlus = `${near} Each file gets an isolated module registry so global state cannot leak between them.`;
		expect(fingerprintSimilarity(textFingerprint(near), textFingerprint(nearPlus))).toBeLessThan(0.75);
		expect(isNearDuplicateSnippet(snippetFingerprint(near), snippetFingerprint(nearPlus))).toBe(
			isNearDuplicate(textFingerprint(near), textFingerprint(nearPlus)),
		);
		expect(isNearDuplicateSnippet(snippetFingerprint(LONG_A), snippetFingerprint(LONG_B))).toBe(
			isNearDuplicate(textFingerprint(LONG_A), textFingerprint(LONG_B)),
		);
	});
});
