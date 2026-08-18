import type { HarnessEntry, HarnessScope } from "./refinement.js";

/**
 * Deterministic lexical retrieval over persisted harness memories.
 *
 * The ranker is a true BM25F: term frequencies from the three fields (id+title,
 * path, content) are combined into a single field-weighted frequency and
 * saturated once, globally, rather than saturating per field and summing (which
 * lets a long content field out-shout an exact title hit). Scale-free relevance
 * gates then drop the tail so a search either answers or says nothing, and the
 * response carries query-biased snippets instead of whole entries so a wide
 * top-k stays inside a sane payload budget.
 *
 * This stays lexical on purpose: paths, symbols, identifiers, and error text are
 * the target corpus. Semantic retrieval remains an evidence-led future step.
 */

const BM25_K1 = 1.2;
const FIELD_COUNT = 3;
const FIELD_WEIGHTS = [3, 2, 1];
const FIELD_B = [0.6, 0.5, 0.75];

const PHRASE_BONUS_WEIGHT = 0.15;
const MIN_COVERAGE = 0.3;
const MIN_SCORE_RATIO = 0.25;
const PREFIX_MIN_LENGTH = 4;
const PREFIX_WEIGHT = 0.5;

const SNIPPET_CHARS = 320;
const PAYLOAD_BUDGET = 6000;
const SNIPPET_MIN_CHARS = 80;
const SNIPPET_EDGE_EXPANSION = 32;
const SNIPPET_MAX_OCCURRENCES = 200;

const INDEX_CACHE_LIMIT = 8;
const INDEX_CACHE_MAX_CORPUS = 20000;

export interface HarnessMemorySearchOptions {
	query: string;
	topK: number;
	scope?: HarnessScope;
	/** When provided, the built index is memoized under this key (LRU 8). */
	indexKey?: string;
}

export interface HarnessMemorySearchResult {
	/** Merged-state key, which remains unambiguous when local and global ids collide. */
	key: string;
	id: string;
	scope: HarnessScope;
	title: string;
	path: string;
	version: number;
	updatedAt: string;
	/** BM25F score, rounded to 4dp. */
	score: number;
	/** Share of the query's total idf this entry matched, rounded to 2dp. */
	coverage: number;
	matchedTerms: string[];
	snippet: string;
	contentChars: number;
	truncated: boolean;
}

export interface HarnessMemorySearchResponse {
	queryTerms: string[];
	/** Matches surviving the relevance gates, before the topK slice. */
	totalMatches: number;
	results: HarnessMemorySearchResult[];
}

const COMBINING_MARKS = /\p{M}+/gu;
const ACRONYM_BOUNDARY = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;
const CASE_BOUNDARY = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;
const CJK_CHAR = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const CJK_RUN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]+/gu;
const PLURAL_CANDIDATE = /^\p{Ll}{4,}s$/u;
const PLURAL_EXCEPTION = /(ss|us|is)$/;
const WHITESPACE = /\s/;
const WHITESPACE_RUN = /\s+/g;

/** NFKD + strip combining marks so `café`/`cafe` and `déployer`/`deployer` collide. */
function fold(value: string): string {
	return value.normalize("NFKD").replace(COMBINING_MARKS, "");
}

/**
 * CJK text has no whitespace boundaries, so a run of ideographs/kana/jamo is
 * emitted as overlapping bigrams (数据库 -> 数据, 据库). Non-CJK slices of the
 * same token pass through untouched.
 */
function splitCjkRuns(token: string): string[] {
	if (!CJK_CHAR.test(token)) return [token];
	const parts: string[] = [];
	let cursor = 0;
	CJK_RUN.lastIndex = 0;
	let match = CJK_RUN.exec(token);
	while (match) {
		if (match.index > cursor) parts.push(token.slice(cursor, match.index));
		const characters = [...match[0]];
		if (characters.length === 1) {
			parts.push(characters[0]);
		} else {
			for (let index = 0; index + 1 < characters.length; index++) {
				parts.push(characters[index] + characters[index + 1]);
			}
		}
		cursor = match.index + match[0].length;
		match = CJK_RUN.exec(token);
	}
	if (cursor < token.length) parts.push(token.slice(cursor));
	return parts;
}

/** Tokenizer without plural expansion; the surface form the writer actually typed. */
function tokenizeBase(value: string): string[] {
	const normalized = fold(value).replace(ACRONYM_BOUNDARY, "$1 $2").replace(CASE_BOUNDARY, "$1 $2").toLowerCase();
	const tokens: string[] = [];
	for (const raw of normalized.split(NON_ALPHANUMERIC)) {
		if (!raw) continue;
		for (const part of splitCjkRuns(raw)) {
			if (part) tokens.push(part);
		}
	}
	return tokens;
}

/**
 * Additive, symmetric plural folding: `caches` also indexes/queries as `cache`,
 * while the original token is always kept so `class`/`status`/`analysis` survive.
 */
function expandPlurals(tokens: readonly string[]): string[] {
	const expanded: string[] = [];
	for (const token of tokens) {
		expanded.push(token);
		if (PLURAL_CANDIDATE.test(token) && !PLURAL_EXCEPTION.test(token)) {
			expanded.push(token.slice(0, -1));
		}
	}
	return expanded;
}

function tokenize(value: string): string[] {
	return expandPlurals(tokenizeBase(value));
}

function countTerms(tokens: readonly string[], into: Map<string, number>): number {
	for (const token of tokens) {
		into.set(token, (into.get(token) ?? 0) + 1);
	}
	return tokens.length;
}

interface IndexedDoc {
	key: string;
	id: string;
	scope: HarnessScope;
	title: string;
	path: string;
	content: string;
	version: number;
	updatedAt: string;
	fieldTf: Map<string, number>[];
	fieldLength: number[];
	terms: Set<string>;
	/** Folded + lowercased title/path, for the phrase bonus. Content is never scanned. */
	titleFolded: string;
	pathFolded: string;
}

interface BuiltIndex {
	docs: IndexedDoc[];
	postings: Map<string, number[]>;
}

interface CachedIndex extends BuiltIndex {
	touched: number;
}

const indexCache = new Map<string, CachedIndex>();
let cacheClock = 0;

function buildIndex(memories: Readonly<Record<string, HarnessEntry>>): BuiltIndex {
	const docs: IndexedDoc[] = [];
	const postings = new Map<string, number[]>();
	for (const [key, entry] of Object.entries(memories)) {
		const fieldTf = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
		const fieldLength = [
			countTerms(tokenize(`${entry.id} ${entry.title}`), fieldTf[0]),
			countTerms(tokenize(entry.path ?? ""), fieldTf[1]),
			countTerms(tokenize(entry.content ?? ""), fieldTf[2]),
		];
		const terms = new Set<string>();
		for (const field of fieldTf) {
			for (const term of field.keys()) terms.add(term);
		}
		const docIndex = docs.length;
		for (const term of terms) {
			const posting = postings.get(term);
			if (posting) posting.push(docIndex);
			else postings.set(term, [docIndex]);
		}
		docs.push({
			key,
			id: entry.id,
			scope: entry.scope ?? "global",
			title: entry.title ?? "",
			path: entry.path ?? "",
			content: entry.content ?? "",
			version: entry.version,
			updatedAt: entry.updated_at ?? "",
			fieldTf,
			fieldLength,
			terms,
			titleFolded: fold(entry.title ?? "").toLowerCase(),
			pathFolded: fold(entry.path ?? "").toLowerCase(),
		});
	}
	return { docs, postings };
}

function getIndex(memories: Readonly<Record<string, HarnessEntry>>, indexKey: string | undefined): BuiltIndex {
	if (indexKey === undefined) return buildIndex(memories);
	const corpusSize = Object.keys(memories).length;
	if (corpusSize > INDEX_CACHE_MAX_CORPUS) return buildIndex(memories);

	const cached = indexCache.get(indexKey);
	if (cached) {
		cacheClock += 1;
		cached.touched = cacheClock;
		return cached;
	}

	cacheClock += 1;
	const entry: CachedIndex = { ...buildIndex(memories), touched: cacheClock };
	indexCache.set(indexKey, entry);
	while (indexCache.size > INDEX_CACHE_LIMIT) {
		let evictKey: string | undefined;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [key, value] of indexCache) {
			if (value.touched < oldest) {
				oldest = value.touched;
				evictKey = key;
			}
		}
		if (evictKey === undefined) break;
		indexCache.delete(evictKey);
	}
	return entry;
}

/** Field-weighted term frequency; BM25F saturates this sum once, not each field. */
function weightedTermFrequency(doc: IndexedDoc, term: string, averageLength: readonly number[]): number {
	let total = 0;
	for (let field = 0; field < FIELD_COUNT; field++) {
		const frequency = doc.fieldTf[field].get(term);
		if (!frequency) continue;
		const b = FIELD_B[field];
		const normalizer = 1 - b + (b * doc.fieldLength[field]) / averageLength[field];
		total += (FIELD_WEIGHTS[field] * frequency) / (normalizer || 1);
	}
	return total;
}

function termScore(doc: IndexedDoc, term: string, idf: number, averageLength: readonly number[]): number {
	const weighted = weightedTermFrequency(doc, term, averageLength);
	if (weighted <= 0) return 0;
	return (idf * weighted) / (BM25_K1 + weighted);
}

function roundTo(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

interface FoldedText {
	folded: string;
	/** folded index -> original index; null when the fold is index-preserving. */
	map: number[] | null;
}

function foldWithMap(value: string): FoldedText {
	const lowered = value.toLowerCase();
	if (lowered.length === value.length && value.normalize("NFKD") === value) {
		return { folded: lowered, map: null };
	}
	let folded = "";
	const map: number[] = [];
	for (let index = 0; index < value.length; index++) {
		const piece = fold(value[index]).toLowerCase();
		for (let offset = 0; offset < piece.length; offset++) map.push(index);
		folded += piece;
	}
	return { folded, map };
}

function snippetWidth(resultCount: number): number {
	if (resultCount <= 0) return SNIPPET_CHARS;
	return Math.max(SNIPPET_MIN_CHARS, Math.min(SNIPPET_CHARS, Math.floor(PAYLOAD_BUDGET / resultCount)));
}

function buildSnippet(
	content: string,
	terms: readonly string[],
	width: number,
): { snippet: string; truncated: boolean } {
	// A window wider than the body always covers it, so skip the search entirely.
	if (content.length <= width) return { snippet: content, truncated: false };

	const { folded, map } = foldWithMap(content);
	const occurrences: { offset: number; term: string }[] = [];
	for (const term of terms) {
		if (!term) continue;
		let at = folded.indexOf(term);
		while (at !== -1 && occurrences.length < SNIPPET_MAX_OCCURRENCES) {
			occurrences.push({ offset: at, term });
			at = folded.indexOf(term, at + 1);
		}
		if (occurrences.length >= SNIPPET_MAX_OCCURRENCES) break;
	}
	occurrences.sort((left, right) => left.offset - right.offset || left.term.localeCompare(right.term));

	let bestStart = 0;
	let bestDistinct = -1;
	for (const occurrence of occurrences) {
		const start = occurrence.offset;
		const end = start + width;
		const distinct = new Set<string>();
		for (const other of occurrences) {
			if (other.offset >= end) break;
			if (other.offset >= start) distinct.add(other.term);
		}
		if (distinct.size > bestDistinct) {
			bestDistinct = distinct.size;
			bestStart = start;
		}
	}

	const foldedEnd = Math.min(folded.length, bestStart + width);
	let start = map ? (map[bestStart] ?? 0) : Math.min(bestStart, content.length);
	let end = map ? (foldedEnd >= map.length ? content.length : map[foldedEnd]) : Math.min(content.length, foldedEnd);

	for (let step = 0; step < SNIPPET_EDGE_EXPANSION && start > 0 && !WHITESPACE.test(content[start - 1]); step++) {
		start -= 1;
	}
	for (let step = 0; step < SNIPPET_EDGE_EXPANSION && end < content.length && !WHITESPACE.test(content[end]); step++) {
		end += 1;
	}

	const covered = start === 0 && end === content.length;
	const body = content.slice(start, end).trim();
	const prefix = start > 0 ? "..." : "";
	const suffix = end < content.length ? "..." : "";
	return { snippet: `${prefix}${body}${suffix}`, truncated: !covered };
}

interface ScoredDoc {
	doc: IndexedDoc;
	score: number;
	coverage: number;
	matchedTerms: string[];
}

function compareScored(left: ScoredDoc, right: ScoredDoc): number {
	return (
		right.score - left.score ||
		right.doc.updatedAt.localeCompare(left.doc.updatedAt) ||
		left.doc.scope.localeCompare(right.doc.scope) ||
		left.doc.key.localeCompare(right.doc.key)
	);
}

function applyRatioGate(ranked: readonly ScoredDoc[]): ScoredDoc[] {
	if (ranked.length === 0) return [];
	const top = ranked[0].score;
	if (top <= 0) return [];
	return ranked.filter((candidate) => candidate.score >= MIN_SCORE_RATIO * top);
}

/**
 * Deterministically rank persisted harness memories without mutating the store.
 */
export function searchHarnessMemories(
	memories: Readonly<Record<string, HarnessEntry>>,
	options: HarnessMemorySearchOptions,
): HarnessMemorySearchResponse {
	const baseTerms = [...new Set(tokenizeBase(options.query))];
	const queryTerms = [...new Set(expandPlurals(baseTerms))];
	if (queryTerms.length === 0) return { queryTerms: [], totalMatches: 0, results: [] };

	const { docs, postings } = getIndex(memories, options.indexKey);
	const scope = options.scope;
	const candidates: number[] = [];
	const inScope = new Uint8Array(docs.length);
	for (let index = 0; index < docs.length; index++) {
		if (scope !== undefined && docs[index].scope !== scope) continue;
		inScope[index] = 1;
		candidates.push(index);
	}
	const total = candidates.length;
	if (total === 0) return { queryTerms, totalMatches: 0, results: [] };

	const averageLength: number[] = [];
	for (let field = 0; field < FIELD_COUNT; field++) {
		let sum = 0;
		for (const index of candidates) sum += docs[index].fieldLength[field];
		averageLength.push(sum / total || 1);
	}

	const idfCache = new Map<string, number>();
	const idfOf = (term: string): number => {
		const cached = idfCache.get(term);
		if (cached !== undefined) return cached;
		let frequency = 0;
		for (const index of postings.get(term) ?? []) {
			if (inScope[index]) frequency += 1;
		}
		const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
		idfCache.set(term, idf);
		return idf;
	};

	let queryIdf = 0;
	for (const term of queryTerms) queryIdf += idfOf(term);
	const phraseBonus = PHRASE_BONUS_WEIGHT * queryIdf;
	const phrase = fold(options.query).toLowerCase().replace(WHITESPACE_RUN, " ").trim();

	const scored: ScoredDoc[] = [];
	for (const index of candidates) {
		const doc = docs[index];
		let score = 0;
		let matchedIdf = 0;
		const matchedTerms: string[] = [];
		for (const term of queryTerms) {
			if (!doc.terms.has(term)) continue;
			matchedTerms.push(term);
			const idf = idfOf(term);
			matchedIdf += idf;
			score += termScore(doc, term, idf, averageLength);
		}
		if (matchedTerms.length === 0) continue;
		if (phrase && (doc.titleFolded.includes(phrase) || doc.pathFolded.includes(phrase))) {
			score += phraseBonus;
		}
		scored.push({ doc, score, coverage: queryIdf > 0 ? matchedIdf / queryIdf : 0, matchedTerms });
	}
	scored.sort(compareScored);

	// Coverage is only meaningful once the query carries more than one concept;
	// plural variants of a single word do not make a query multi-term.
	const coverageApplies = baseTerms.length >= 2;
	let gated: ScoredDoc[] = [];
	if (scored.length > 0 && (!coverageApplies || scored[0].coverage >= MIN_COVERAGE)) {
		gated = applyRatioGate(scored).filter((candidate) => !coverageApplies || candidate.coverage >= MIN_COVERAGE);
	}

	if (gated.length === 0) {
		gated = prefixFallback(docs, candidates, queryTerms, postings, averageLength, idfOf, queryIdf);
	}

	const totalMatches = gated.length;
	const selected = gated.slice(0, Math.max(0, options.topK));
	const width = snippetWidth(selected.length);
	const results = selected.map(({ doc, score, coverage, matchedTerms }) => {
		const { snippet, truncated } = buildSnippet(doc.content, matchedTerms, width);
		return {
			key: doc.key,
			id: doc.id,
			scope: doc.scope,
			title: doc.title,
			path: doc.path,
			version: doc.version,
			updatedAt: doc.updatedAt,
			score: roundTo(score, 4),
			coverage: roundTo(coverage, 2),
			matchedTerms,
			snippet,
			contentChars: doc.content.length,
			truncated,
		};
	});

	return { queryTerms, totalMatches, results };
}

/**
 * Last-resort pass for typed-prefix queries (`authent` -> `authentication`).
 * Only runs when the gated set came back empty, and is discounted so a prefix
 * hit can never outrank a real one in a normal search.
 */
function prefixFallback(
	docs: readonly IndexedDoc[],
	candidates: readonly number[],
	queryTerms: readonly string[],
	postings: ReadonlyMap<string, number[]>,
	averageLength: readonly number[],
	idfOf: (term: string) => number,
	queryIdf: number,
): ScoredDoc[] {
	const prefixes = queryTerms.filter((term) => term.length >= PREFIX_MIN_LENGTH);
	if (prefixes.length === 0) return [];

	const expansions = new Map<string, string[]>();
	for (const term of postings.keys()) {
		for (const prefix of prefixes) {
			if (term.length > prefix.length && term.startsWith(prefix)) {
				const bucket = expansions.get(prefix);
				if (bucket) bucket.push(term);
				else expansions.set(prefix, [term]);
			}
		}
	}
	if (expansions.size === 0) return [];

	const scored: ScoredDoc[] = [];
	for (const index of candidates) {
		const doc = docs[index];
		let score = 0;
		let matchedIdf = 0;
		const matchedTerms: string[] = [];
		for (const [, terms] of expansions) {
			for (const term of terms) {
				if (!doc.terms.has(term)) continue;
				const idf = idfOf(term);
				matchedTerms.push(term);
				matchedIdf += idf;
				score += PREFIX_WEIGHT * termScore(doc, term, idf, averageLength);
			}
		}
		if (matchedTerms.length === 0) continue;
		matchedTerms.sort();
		scored.push({ doc, score, coverage: queryIdf > 0 ? Math.min(1, matchedIdf / queryIdf) : 0, matchedTerms });
	}
	scored.sort(compareScored);
	return applyRatioGate(scored);
}
