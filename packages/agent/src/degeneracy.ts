/**
 * Streaming degeneracy guard.
 *
 * Sampling collapse — the model looping on a phrase for thousands of tokens — cannot be
 * prevented from inside the harness. This detects it while it streams so the turn can be
 * cancelled instead of billed to max_tokens and written into the session as permanent context.
 *
 * Two independent signals, both bounded to a fixed window so cost is O(window) per check and
 * the message is never re-scanned:
 *
 * - `loop`: the tail of the stream is a verbatim repeat of the text just before it.
 * - `repetition`: distinct word 4-grams collapse while one 4-gram recurs. Both conditions must
 *   hold at once, twice in a row.
 *
 * Neither signal is structural alone: both are gated on the repeating text reading as natural
 * language. Repetition is only evidence of a model losing the thread of a sentence when there is
 * a sentence. Padding, ASCII art, progress bars, base64, tables, logs and minified code repeat
 * themselves for reasons of their own, and aborting a turn over one destroys real work.
 *
 * Thresholds were fitted against 6.5 MB of real assistant text, reasoning, session transcripts,
 * source files, diffs, markdown tables, logs, base64, minified JS, ASCII art and character runs,
 * at zero false positives.
 * Feed it assistant text and reasoning only: tool-call arguments are legitimately repetitive.
 */

/** Words per natural-language window. ~600 characters of prose. */
const WINDOW_WORDS = 120;
const NGRAM = 4;
/** Words appended between window checks. */
const CHECK_EVERY_WORDS = 20;
/**
 * Distinct 4-grams / total 4-grams. Legitimate prose windows in the fitting corpus bottomed
 * out at 0.60, so this alone would misfire; it only trips paired with NGRAM_REPEATS below.
 */
const MAX_DISTINCT_RATIO = 0.8;
/** Peak recurrence of a single 4-gram. No legitimate gated window in the corpus exceeded 6. */
const MIN_NGRAM_REPEATS = 7;
const CONSECUTIVE_CHECKS = 2;
/**
 * Fraction of tokens that must be English function words for a stretch to be judged at all.
 * Below it the text is code, a table, a log, base64, ASCII art or a run of padding — all
 * legitimately repetitive, none of them a model losing the thread of a sentence.
 */
const MIN_STOPWORD_FRACTION = 0.35;

/** Characters of stream tail retained for the verbatim-loop check. */
const TAIL_CHARS = 4000;
const CHECK_EVERY_CHARS = 128;
const PROBE_CHARS = 32;
const MIN_LOOP_CHARS = 480;
const MIN_LOOP_REPEATS = 4;
const MAX_LOOP_PERIOD = 512;
/** Fewer word tokens than this in the repeating stretch and it cannot be sentences. */
const MIN_LOOP_TOKENS = 8;

const WORD_RE = /[\p{L}\p{N}']+/gu;

/**
 * English function words. Their share of a stretch of text is the test for "this is language".
 * Deliberately the standard closed-class set: content words would make the gate topic-specific.
 */
const STOPWORDS = new Set(
	"the a an and or but of to in on at for with from by as is are was were be been being it its this that these those i you he she we they not no so if then than there here what which who when how all any some each other into over under about after before out up down do does did have has had will would can could should may might must my your his her our their me him them us same such very just only more most both few own too again once while where why between through during against above below off until further nor now am having doing because myself yourself himself herself itself ourselves themselves hers ours yours theirs mine".split(
		" ",
	),
);

/** Share of tokens that are function words. Zero for an empty stretch: silence is not language. */
function languageScore(tokens: string[]): number {
	if (tokens.length === 0) {
		return 0;
	}
	let stopwords = 0;
	for (const token of tokens) {
		if (STOPWORDS.has(token)) {
			stopwords++;
		}
	}
	return stopwords / tokens.length;
}

export interface DegeneracyReport {
	kind: "loop" | "repetition";
	/** Human-readable evidence, safe to show to the user and to record on the message. */
	detail: string;
	/** Characters streamed into the current content block before the trip. */
	chars: number;
}

/**
 * Fed the deltas of one streaming assistant message. `blockId` separates content blocks so a
 * reasoning block and the text block after it are never mixed into the same window.
 */
export class DegeneracyDetector {
	private blockId = -1;
	private words: string[] = [];
	private carry = "";
	private tail = "";
	private chars = 0;
	private sinceWordCheck = 0;
	private sinceCharCheck = 0;
	private lowStreak = 0;
	private reported = false;

	push(blockId: number, text: string): DegeneracyReport | undefined {
		if (this.reported || text.length === 0) {
			return undefined;
		}
		if (blockId !== this.blockId) {
			this.blockId = blockId;
			this.resetBlock();
		}

		this.chars += text.length;
		this.tail =
			this.tail.length + text.length > TAIL_CHARS ? (this.tail + text).slice(-TAIL_CHARS) : this.tail + text;
		this.sinceCharCheck += text.length;
		this.sinceWordCheck += this.ingest(text);

		let report: DegeneracyReport | undefined;
		if (this.sinceCharCheck >= CHECK_EVERY_CHARS) {
			this.sinceCharCheck = 0;
			report = this.inspectTail();
		}
		if (!report && this.sinceWordCheck >= CHECK_EVERY_WORDS) {
			this.sinceWordCheck = 0;
			report = this.inspectWindow();
		}
		if (report) {
			this.reported = true;
		}
		return report;
	}

	private resetBlock(): void {
		this.words = [];
		this.carry = "";
		this.tail = "";
		this.chars = 0;
		this.sinceWordCheck = 0;
		this.sinceCharCheck = 0;
		this.lowStreak = 0;
	}

	/** Appends whole words, holding back a word that a later delta may continue. */
	private ingest(text: string): number {
		const buffer = this.carry + text;
		let added = 0;
		let trailing = "";
		WORD_RE.lastIndex = 0;
		let match = WORD_RE.exec(buffer);
		while (match) {
			if (match.index + match[0].length === buffer.length) {
				trailing = match[0];
				break;
			}
			this.words.push(match[0].toLowerCase());
			added++;
			match = WORD_RE.exec(buffer);
		}
		// A token this long is not a word; flushing keeps memory bounded on unseparated output.
		if (trailing.length > TAIL_CHARS) {
			this.words.push(trailing.toLowerCase());
			added++;
			trailing = "";
		}
		this.carry = trailing;
		if (this.words.length > WINDOW_WORDS * 4) {
			this.words = this.words.slice(-WINDOW_WORDS);
		}
		return added;
	}

	private inspectWindow(): DegeneracyReport | undefined {
		if (this.words.length < WINDOW_WORDS) {
			return undefined;
		}
		const window = this.words.slice(-WINDOW_WORDS);
		if (languageScore(window) < MIN_STOPWORD_FRACTION) {
			this.lowStreak = 0;
			return undefined;
		}

		const total = window.length - NGRAM + 1;
		const counts = new Map<string, number>();
		let peak = 0;
		for (let i = 0; i < total; i++) {
			const key = `${window[i]} ${window[i + 1]} ${window[i + 2]} ${window[i + 3]}`;
			const seen = (counts.get(key) ?? 0) + 1;
			counts.set(key, seen);
			if (seen > peak) {
				peak = seen;
			}
		}
		const distinct = counts.size / total;
		if (distinct >= MAX_DISTINCT_RATIO || peak < MIN_NGRAM_REPEATS) {
			this.lowStreak = 0;
			return undefined;
		}
		this.lowStreak++;
		if (this.lowStreak < CONSECUTIVE_CHECKS) {
			return undefined;
		}
		return {
			kind: "repetition",
			detail: `only ${Math.round(distinct * 100)}% of word sequences in the last ${WINDOW_WORDS} words were distinct, one recurring ${peak} times`,
			chars: this.chars,
		};
	}

	private inspectTail(): DegeneracyReport | undefined {
		const tail = this.tail;
		if (tail.length < MIN_LOOP_CHARS + PROBE_CHARS) {
			return undefined;
		}
		const probe = tail.slice(tail.length - PROBE_CHARS);
		const previous = tail.lastIndexOf(probe, tail.length - PROBE_CHARS - 1);
		if (previous < 0) {
			return undefined;
		}
		const period = tail.length - PROBE_CHARS - previous;
		if (period < 1 || period > MAX_LOOP_PERIOD) {
			return undefined;
		}
		const unit = tail.slice(tail.length - period);
		// Repeats that span a line break are the shape of tables, logs, lists and diffs, not of a loop.
		if (unit.includes("\n")) {
			return undefined;
		}
		let i = tail.length - 1;
		while (i - period >= 0 && tail[i] === tail[i - period]) {
			i--;
		}
		const run = tail.length - 1 - i + period;
		if (run < MIN_LOOP_CHARS || run < period * MIN_LOOP_REPEATS) {
			return undefined;
		}
		// Judged on the repeating stretch itself, not on the window around it: a run of padding or
		// ASCII art inside ordinary prose leaves the window looking like language while the run is
		// not language at all, and that stretch is the thing being called degenerate.
		const runTokens =
			tail
				.slice(tail.length - run)
				.toLowerCase()
				.match(WORD_RE) ?? [];
		if (runTokens.length < MIN_LOOP_TOKENS || languageScore(runTokens) < MIN_STOPWORD_FRACTION) {
			return undefined;
		}
		return {
			kind: "loop",
			detail: `${Math.floor(run / period)} verbatim repeats of a ${period}-character fragment`,
			chars: this.chars,
		};
	}
}

/** Message recorded on the aborted turn. Read by the user in the UI and in the transcript. */
export function degeneracyErrorMessage(report: DegeneracyReport): string {
	return (
		`Output stopped: the model collapsed into a repetition loop (${report.detail}). ` +
		`The turn was aborted after ${report.chars} characters and the repeated output was discarded. ` +
		`Retry the turn, or pass --no-degeneracy-guard to let it run.`
	);
}
