import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import * as websearch from "../skills/websearch/skill.js";

const { default: createSkill, cleanUrl, dedupeResults, formatResults, NOT_CONFIGURED_MESSAGE, stripHtml } = websearch;

type Result = { title: string; url: string; snippet: string };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
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

	it("honours PRIME_AGENT_WEBSEARCH_BACKEND", async () => {
		const calls = stubFetch((url) => response(url.includes("serper") ? SERPER_HIT : SEARX_HIT));
		const env = {
			SEARXNG_URL: "http://localhost:8888",
			SERPER_API_KEY: "k",
			PRIME_AGENT_WEBSEARCH_BACKEND: "serper",
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
		expect(out).toContain("[truncated");
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
