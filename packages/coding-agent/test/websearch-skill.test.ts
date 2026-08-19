import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as websearch from "../skills/websearch/skill.js";

const {
	default: createSkill,
	cleanUrl,
	clearReadCache,
	dedupeResults,
	extractMainText,
	formatResults,
	NOT_CONFIGURED_MESSAGE,
	stripHtml,
} = websearch;

type Result = { title: string; url: string; snippet: string };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	clearReadCache(); // the read cache is module scope: keep tests independent
});

/** Stub `fetch`, recording every request made. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	}) as unknown as typeof fetch;
	return calls;
}

function response(body: unknown, { status = 200, contentType = "application/json" } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

const SEARX_HIT = { results: [{ title: "SearXNG hit", url: "https://x.test/a", content: "from searxng" }] };
const SERPER_HIT = { organic: [{ title: "Serper hit", link: "https://y.test/b", snippet: "from serper" }] };

describe("websearch: backend selection", () => {
	it("returns setup instructions naming both options when nothing is configured", async () => {
		const calls = stubFetch(() => response({}));
		const out = await createSkill({ env: {} }).run("q");
		expect(out).toBe(NOT_CONFIGURED_MESSAGE);
		expect(out).toContain("SEARXNG_URL");
		expect(out).toContain("serper.dev");
		expect(calls).toHaveLength(0); // no network when unconfigured
	});

	it("never falls back to a public SearXNG instance", async () => {
		const calls = stubFetch(() => response({}));
		await createSkill({ env: {} }).run("q");
		expect(calls.some((c) => c.url.includes("searx.space"))).toBe(false);
	});

	it("prefers SEARXNG_URL when both backends are configured", async () => {
		const calls = stubFetch(() => response(SEARX_HIT));
		const out = await createSkill({ env: { SEARXNG_URL: "http://localhost:8888", SERPER_API_KEY: "k" } }).run("q");
		expect(out).toContain("SearXNG hit");
		expect(calls[0].url.startsWith("http://localhost:8888/search")).toBe(true);
		expect(calls.some((c) => c.url.includes("serper"))).toBe(false);
	});

	it("uses Serper when only a key is configured", async () => {
		const calls = stubFetch(() => response(SERPER_HIT));
		const out = await createSkill({ env: { SERPER_API_KEY: "k" } }).run("q");
		expect(out).toContain("Serper hit");
		expect(calls[0].url).toContain("google.serper.dev");
	});

	it("honours an explicit backend choice over the default order", async () => {
		const calls = stubFetch((url) => response(url.includes("serper") ? SERPER_HIT : SEARX_HIT));
		const env = { SEARXNG_URL: "http://localhost:8888", SERPER_API_KEY: "k" };
		expect(await createSkill({ env }).run("q", { backend: "serper" })).toContain("Serper hit");
		expect(calls[0].url).toContain("google.serper.dev");
	});

	it("honours OPTIMUS_WEBSEARCH_BACKEND", async () => {
		const calls = stubFetch((url) => response(url.includes("serper") ? SERPER_HIT : SEARX_HIT));
		const env = {
			SEARXNG_URL: "http://localhost:8888",
			SERPER_API_KEY: "k",
			OPTIMUS_WEBSEARCH_BACKEND: "serper",
		};
		await createSkill({ env }).run("q");
		expect(calls[0].url).toContain("google.serper.dev");
	});

	it("does not silently switch backends when the explicit choice is unconfigured", async () => {
		stubFetch(() => response(SERPER_HIT));
		const out = await createSkill({ env: { SERPER_API_KEY: "k" } }).run("q", { backend: "searxng" });
		expect(out).toBe(NOT_CONFIGURED_MESSAGE);
	});

	it("passes language and time_range through to SearXNG", async () => {
		const calls = stubFetch(() => response(SEARX_HIT));
		await createSkill({ env: { SEARXNG_URL: "http://localhost:8888" } }).run("q", {
			language: "en",
			time_range: "week",
		});
		expect(calls[0].url).toContain("language=en");
		expect(calls[0].url).toContain("time_range=week");
	});
});

describe("websearch: backend errors", () => {
	it("explains how to enable the JSON API when SearXNG returns HTML", async () => {
		stubFetch(() => response("<html/>", { contentType: "text/html" }));
		const out = await createSkill({ env: { SEARXNG_URL: "http://localhost:8888" } }).run("q");
		expect(out).toContain("search.formats");
	});

	it("points at the bot limiter on a 403", async () => {
		stubFetch(() => response("", { status: 403, contentType: "text/html" }));
		const out = await createSkill({ env: { SEARXNG_URL: "http://localhost:8888" } }).run("q");
		expect(out).toContain("limiter");
	});

	it("reports a Serper API error without throwing", async () => {
		stubFetch(() => response("quota exceeded", { status: 429, contentType: "text/plain" }));
		const out = await createSkill({ env: { SERPER_API_KEY: "k" } }).run("q");
		expect(out).toContain("Web search failed");
		expect(out).toContain("429");
	});

	it("survives an offline machine", async () => {
		stubFetch(() => {
			throw new Error("getaddrinfo ENOTFOUND");
		});
		const out = await createSkill({ env: { SEARXNG_URL: "http://localhost:8888" } }).run("q");
		expect(out).toContain("Web search failed");
	});
});

describe("websearch: cleaning and dedupe", () => {
	it("strips HTML and collapses whitespace", () => {
		expect(stripHtml("<b>Hello</b>   <i>world</i><script>evil()</script>")).toBe("Hello world");
		expect(stripHtml("a &amp; b &nbsp; c")).toBe("a & b c");
	});

	it("drops tracking params and fragments from URLs", () => {
		expect(cleanUrl("https://x.test/a?utm_source=g&id=7#frag")).toBe("https://x.test/a?id=7");
		expect(cleanUrl("https://x.test/a?fbclid=1")).toBe("https://x.test/a");
	});

	it("keeps a param that merely starts with a tracking prefix", () => {
		expect(cleanUrl("https://x.test/a?reference=7")).toContain("reference=7");
	});

	it("deduplicates URLs that differ only by tracking params", () => {
		const out = dedupeResults([
			{ title: "A", url: "https://x.test/a?utm_source=g", content: "one" },
			{ title: "A", url: "https://x.test/a", content: "one" },
		]);
		expect(out).toHaveLength(1);
	});

	it("collapses near-identical titles from different engines", () => {
		const out = dedupeResults([
			{ title: "Rust Programming Language", url: "https://rust.test/a", content: "x" },
			{ title: "rust programming language!", url: "https://rust.test/b", content: "x" },
		]);
		expect(out).toHaveLength(1);
	});

	it("caps any single domain at two results", () => {
		const out: Result[] = dedupeResults([
			{ title: "One", url: "https://d.test/1" },
			{ title: "Two", url: "https://d.test/2" },
			{ title: "Three", url: "https://d.test/3" },
			{ title: "Other", url: "https://e.test/1" },
		]);
		expect(out).toHaveLength(3);
		expect(out.filter((r) => r.url.includes("d.test"))).toHaveLength(2);
	});

	it("treats www and bare domains as the same site", () => {
		const out = dedupeResults([
			{ title: "One", url: "https://www.d.test/1" },
			{ title: "Two", url: "https://d.test/2" },
			{ title: "Three", url: "https://d.test/3" },
		]);
		expect(out).toHaveLength(2);
	});

	it("treats scheme, www and index.html variants as one page", () => {
		const body = "Bun implements a fast all-in-one JavaScript runtime with a bundler and test runner built in.";
		const out = dedupeResults([
			{ title: "Bun docs | Runtime", url: "https://www.bun.test/docs", content: body },
			{ title: "Bun docs - Runtime", url: "http://bun.test/docs", content: body },
			{ title: "Bun Documentation", url: "https://bun.test/docs/index.html", content: body },
		]);
		expect(out).toHaveLength(1);
	});

	it("collapses syndicated copies of one article across different domains", () => {
		const body =
			"The release adds a bundler, a test runner and a package manager to the runtime, all shipped in one binary.";
		const out = dedupeResults([
			{ title: "Bun 1.0 released", url: "https://news-a.test/bun", content: body },
			{ title: "Bun ships 1.0", url: "https://news-b.test/bun", content: body },
			{ title: "Bun hits 1.0", url: "https://news-c.test/bun", content: body },
		]);
		expect(out).toHaveLength(1);
	});

	it("collapses syndicated copies truncated at different lengths", () => {
		const body =
			"The release adds a bundler, a test runner and a package manager to the runtime, all shipped in a single binary.";
		const out = dedupeResults([
			{ title: "Bun 1.0 released", url: "https://news-a.test/bun", content: body },
			{ title: "Bun ships 1.0", url: "https://news-b.test/bun", content: body.slice(0, 92) },
			{ title: "Bun hits 1.0", url: "https://news-c.test/bun", content: `(Reuters) - ${body}` },
		]);
		expect(out).toHaveLength(1);
	});

	it("keeps two stories that merely cover the same event", () => {
		const out = dedupeResults([
			{
				title: "Bun 1.0 shipped",
				url: "https://news-a.test/1",
				content:
					"Bun 1.0 shipped today with a bundler, a test runner and a package manager bundled into one binary.",
			},
			{
				title: "Reaction to the release",
				url: "https://news-b.test/2",
				content:
					"Maintainers debated whether shipping a single binary helps developers or further fragments the tooling.",
			},
		]);
		expect(out).toHaveLength(2);
	});

	it("keeps distinct pages whose snippets are too short to fingerprint", () => {
		const out = dedupeResults([
			{ title: "Alpha", url: "https://a.test/1", content: "Read more" },
			{ title: "Beta", url: "https://b.test/2", content: "Read more" },
			{ title: "Gamma", url: "https://c.test/3", content: "" },
		]);
		expect(out).toHaveLength(3);
	});

	it("skips results with an unusable URL", () => {
		expect(
			dedupeResults([
				{ title: "A", url: "not a url" },
				{ title: "B", url: "" },
			]),
		).toHaveLength(0);
	});

	it("strips HTML out of titles and snippets", () => {
		const [only] = dedupeResults([{ title: "<b>Bold</b>", url: "https://x.test/a", content: "<i>it</i>" }]);
		expect(only.title).toBe("Bold");
		expect(only.snippet).toBe("it");
	});
});

describe("websearch: character budget", () => {
	const many: Result[] = Array.from({ length: 20 }, (_, i) => ({
		title: `Result ${i} ${"title ".repeat(20)}`,
		url: `https://x${i}.test/page`,
		snippet: "snippet ".repeat(80),
	}));

	it("never exceeds maxChars and says so when it truncates", () => {
		const out = formatResults(many, { query: "q", maxChars: 800, count: 10 });
		expect(out.length).toBeLessThanOrEqual(800);
		expect(out).toContain("[truncated");
	});

	it("stays within the default budget", () => {
		expect(formatResults(many, { query: "q" }).length).toBeLessThanOrEqual(2400);
	});

	it("respects the count knob", () => {
		const out = formatResults(many, { query: "q", count: 3, maxChars: 100000 });
		expect(out).toContain("3. ");
		expect(out).not.toContain("4. ");
	});

	it("does not claim truncation when everything fits", () => {
		const out = formatResults([{ title: "A", url: "https://x.test/a", snippet: "short" }], { query: "q" });
		expect(out).not.toContain("[truncated");
		expect(out).toContain("https://x.test/a");
	});

	it("reports no results without inventing any", () => {
		expect(formatResults([], { query: "nothing" })).toContain("No results");
	});

	it("applies the budget end to end through run()", async () => {
		stubFetch(() =>
			response({
				results: Array.from({ length: 30 }, (_, i) => ({
					title: `T${i} ${"x".repeat(200)}`,
					url: `https://s${i}.test/p`,
					content: "y".repeat(2000),
				})),
			}),
		);
		const out = await createSkill({ env: { SEARXNG_URL: "http://localhost:8888" } }).run("q", { maxChars: 1000 });
		expect(out.length).toBeLessThanOrEqual(1000);
	});
});

describe("websearch: read()", () => {
	it("returns bounded readable text", async () => {
		stubFetch(() => ({
			ok: true,
			status: 200,
			headers: { get: () => "text/html; charset=utf-8" },
			text: async () => `<html><body><p>${"word ".repeat(2000)}</p></body></html>`,
		}));
		const out = await createSkill({ env: {} }).read("https://x.test/page", { maxChars: 500 });
		expect(out.length).toBeLessThanOrEqual(500);
		expect(out).toContain("continue with { offset:");
		expect(out).not.toContain("<p>");
	});

	it("refuses non-text content", async () => {
		stubFetch(() => ({ ok: true, status: 200, headers: { get: () => "image/png" }, text: async () => "" }));
		expect(await createSkill({ env: {} }).read("https://x.test/a.png")).toContain("unsupported content-type");
	});

	it("reports an HTTP error without throwing", async () => {
		stubFetch(() => response("", { status: 404, contentType: "text/html" }));
		expect(await createSkill({ env: {} }).read("https://x.test/missing")).toContain("404");
	});
});

/**
 * A Wikipedia-shaped page: Vector-2022 nests the article in `<main id="content">`
 * and everything else in nav/header/footer/aside landmarks.
 */
const WIKI_HTML = `<html><head><title>Decentralized finance - Wikipedia</title></head><body>
<header class="vector-header"><a href="#content">Jump to content</a>
  <nav class="vector-main-menu-landmark" aria-label="Site"><h3>Main menu</h3><span>move to sidebar</span>
    <ul><li><a>Main page</a></li><li><a>Donate</a></li><li><a>Create account</a></li><li><a>Log in</a></li></ul>
  </nav>
</header>
<div class="vector-sidebar">
  <nav id="mw-panel-toc" aria-label="Contents"><span>Toggle the table of contents</span>
    <ul><li>1 History</li><li>2 Key characteristics</li><li>3 Decentralized exchanges</li></ul>
  </nav>
</div>
<main id="content" class="mw-body">
  <h1>Decentralized finance</h1>
  <nav aria-label="Namespaces"><ul><li><a>Talk</a></li><li><a>Read</a></li><li><a>View history</a></li></ul></nav>
  <div id="mw-content-text">
    <p>Decentralized finance provides financial instruments through smart contracts on a permissionless blockchain.</p>
    <p>DeFi platforms enable users to lend or borrow funds and earn interest in savings-like accounts.</p>
  </div>
  <footer class="mw-content-footer"><a>Retrieved from the wiki database</a></footer>
</main>
<aside id="p-lang" class="vector-column-end"><h3>Languages</h3>
  <ul><li>Afrikaans</li><li>Azerbaycanca</li><li>Deutsch</li><li>Nederlands</li></ul>
</aside>
<footer class="mw-footer"><ul><li>This page was last edited on 1 January 2026</li></ul></footer>
<script>window.RLQ = [];</script>
</body></html>`;

/** The chrome that used to eat the first ~1500 chars of every Wikipedia read. */
const CHROME = [
	"Jump to content",
	"Main menu",
	"move to sidebar",
	"Donate",
	"Create account",
	"Toggle the table of contents",
	"Key characteristics",
	"Afrikaans",
	"Azerbaycanca",
	"Nederlands",
	"View history",
	"Retrieved from",
	"last edited",
	"window.RLQ",
];

describe("websearch: main-content extraction", () => {
	it("drops navigation chrome and keeps the article prose", () => {
		const text = extractMainText(WIKI_HTML);
		for (const chrome of CHROME) expect(text).not.toContain(chrome);
		expect(text).toContain("Decentralized finance provides financial instruments");
		expect(text).toContain("earn interest in savings-like accounts");
	});

	it("removes far more than it keeps on a chrome-heavy page", () => {
		expect(extractMainText(WIKI_HTML).length).toBeLessThan(stripHtml(WIKI_HTML).length / 2);
	});

	it("prefers <article> when there is no <main>", () => {
		const html = `<body><nav>Skip</nav><article><p>Body text.</p></article><aside>Related</aside></body>`;
		expect(extractMainText(html)).toBe("Body text.");
	});

	it("falls back through role=main, id=content, then body", () => {
		expect(extractMainText(`<body><nav>Skip</nav><div role="main"><p>Roled.</p></div></body>`)).toBe("Roled.");
		expect(extractMainText(`<body><nav>Skip</nav><div id="content"><p>Ided.</p></div></body>`)).toBe("Ided.");
		expect(extractMainText(`<body><nav>Skip</nav><p>Bodied.</p></body>`)).toBe("Bodied.");
	});

	it("handles nested containers of the same name", () => {
		const html = `<main><div><nav>Outer<nav>Inner</nav>Still nav</nav></div><p>Kept.</p></main>`;
		expect(extractMainText(html)).toBe("Kept.");
	});

	it("keeps an unclosed nav from swallowing the rest of the page", () => {
		expect(extractMainText("<main><nav><p>Kept anyway.</p></main>")).toContain("Kept anyway.");
	});

	it("reads a page through read() without the chrome", async () => {
		stubFetch(() => response(WIKI_HTML, { contentType: "text/html; charset=utf-8" }));
		const out = await createSkill({ env: {} }).read("https://en.wikipedia.test/wiki/Decentralized_finance");
		for (const chrome of CHROME) expect(out).not.toContain(chrome);
		expect(out).toContain("permissionless blockchain");
	});
});

/** Fixed-width tokens so `w0007` can never match as a substring of another. */
const TOKENS = Array.from({ length: 1200 }, (_, i) => `w${String(i).padStart(4, "0")}`);
const LONG_HTML = `<html><body><main><p>${TOKENS.join(" ")}</p></main></body></html>`;

/** The slice between the URL header and the trailing range marker. */
function bodyOf(out: string): string {
	return out.split("\n\n")[1] ?? "";
}

/** The `offset` the marker tells the caller to continue from, or null at the end. */
function nextOffset(out: string): number | null {
	const m = out.match(/continue with \{ offset: (\d+) \}/);
	return m ? Number(m[1]) : null;
}

describe("websearch: read() continuation", () => {
	it("returns the next slice instead of repeating the first", async () => {
		stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });

		const first = await skill.read("https://x.test/long", { maxChars: 600 });
		const offset = nextOffset(first);
		expect(offset).not.toBeNull();

		const second = await skill.read("https://x.test/long", { maxChars: 600, offset });
		const firstBody = bodyOf(first);
		const secondBody = bodyOf(second);

		expect(firstBody).toContain("w0000");
		expect(secondBody).not.toContain("w0000");
		// The two slices are adjacent: nothing repeated, nothing skipped.
		const lastOfFirst = firstBody.trim().split(" ").at(-1) as string;
		const firstOfSecond = secondBody.trim().split(" ")[0];
		expect(secondBody).not.toContain(lastOfFirst);
		expect(Number(firstOfSecond.slice(1))).toBe(Number(lastOfFirst.slice(1)) + 1);
	});

	it("states the range and total in the marker", async () => {
		stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const out = await createSkill({ env: {} }).read("https://x.test/long", { maxChars: 600 });
		expect(out).toMatch(/\[chars 0-\d+ of \d+ — continue with \{ offset: \d+ \}\]$/);
	});

	it("marks the end of the document only when it is exhausted", async () => {
		stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });

		let out = await skill.read("https://x.test/long", { maxChars: 900 });
		let offset = nextOffset(out);
		let hops = 0;
		while (offset !== null && hops < 50) {
			expect(out).not.toContain("[end of document");
			out = await skill.read("https://x.test/long", { maxChars: 900, offset });
			offset = nextOffset(out);
			hops += 1;
		}
		expect(hops).toBeGreaterThan(1); // it really did take several slices
		expect(out).toContain("[end of document");
		expect(bodyOf(out)).toContain(TOKENS.at(-1) as string);
	});

	it("does not claim a continuation when the whole page fits", async () => {
		stubFetch(() =>
			response("<html><body><main><p>Short page.</p></main></body></html>", { contentType: "text/html" }),
		);
		const out = await createSkill({ env: {} }).read("https://x.test/short");
		expect(out).toContain("Short page.");
		expect(out).toContain("[end of document");
		expect(nextOffset(out)).toBeNull();
	});

	it("still caps output at maxChars on every slice", async () => {
		stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });
		for (const offset of [0, 1000, 4000]) {
			const out = await skill.read("https://x.test/long", { maxChars: 400, offset });
			expect(out.length).toBeLessThanOrEqual(400);
		}
	});
});

describe("websearch: read() cache", () => {
	it("does not re-fetch for a continuation", async () => {
		const calls = stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });
		const first = await skill.read("https://x.test/long", { maxChars: 600 });
		await skill.read("https://x.test/long", { maxChars: 600, offset: nextOffset(first) });
		await skill.read("https://x.test/long", { maxChars: 600, offset: 0 });
		expect(calls).toHaveLength(1);
	});

	it("re-fetches when refresh is set", async () => {
		let body = "<html><body><main><p>First version.</p></main></body></html>";
		const calls = stubFetch(() => response(body, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });

		expect(await skill.read("https://x.test/live")).toContain("First version.");
		body = "<html><body><main><p>Second version.</p></main></body></html>";
		expect(await skill.read("https://x.test/live")).toContain("First version."); // cached
		expect(calls).toHaveLength(1);

		expect(await skill.read("https://x.test/live", { refresh: true })).toContain("Second version.");
		expect(calls).toHaveLength(2);
	});

	it("keys the cache by cleaned URL, so tracking params do not split it", async () => {
		const calls = stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });
		await skill.read("https://x.test/long?utm_source=a");
		await skill.read("https://x.test/long");
		expect(calls).toHaveLength(1);
	});

	it("evicts old entries rather than growing without bound", async () => {
		const calls = stubFetch(() => response(LONG_HTML, { contentType: "text/html" }));
		const skill = createSkill({ env: {} });
		for (let i = 0; i < 6; i++) await skill.read(`https://x.test/p${i}`);
		expect(calls).toHaveLength(6);
		await skill.read("https://x.test/p0"); // evicted: fetched again
		expect(calls).toHaveLength(7);
		await skill.read("https://x.test/p5"); // still resident
		expect(calls).toHaveLength(7);
	});
});
