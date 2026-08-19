/**
 * Optimus Prime websearch skill: one bounded search interface over two backends.
 *
 *   1. SearXNG, self-hosted  - keyless, private, free. Set `SEARXNG_URL`.
 *   2. Serper                - hosted Google API. Set a key via /login.
 *
 * There is deliberately NO public-instance fallback. A probe of the healthiest
 * public SearXNG instances found none that answer a programmatic JSON query
 * (429/403/418 on the first request from a clean IP); rotating instances to get
 * around that would be circumventing anti-abuse controls on volunteer-run
 * servers, so we do not.
 *
 * Output is bounded on purpose: results land straight in an agent's context, so
 * we return a short, deduplicated, character-capped summary. See SKILL.md.
 */

const DEFAULT_COUNT = 6;
const DEFAULT_MAX_CHARS = 2400; // ≈600 tokens
const SNIPPET_CHARS = 220;
const DEFAULT_READ_CHARS = 4000;
/** Extracted-text cache bounds: this module lives in a long-running REPL. */
const READ_CACHE_ENTRIES = 5;
const READ_CACHE_CHARS = 600_000;
const USER_AGENT = "optimus-prime-websearch/1.0 (+https://github.com/pde-rent/optimus-prime)";

const SERPER_URL = "https://google.serper.dev/search";

export const NOT_CONFIGURED_MESSAGE =
	"Web search is not configured. Two options, either works:\n" +
	"  1. Self-hosted SearXNG (recommended: free, keyless, private)\n" +
	"       docker run -d -p 8888:8080 searxng/searxng\n" +
	"     then in settings.yml set `search.formats: [html, json]` and `server.limiter: false`,\n" +
	"     and export SEARXNG_URL=http://localhost:8888\n" +
	"  2. Serper (hosted Google API, free tier): get a key at https://serper.dev, then run\n" +
	'     /login in Optimus Prime, switch to MCP Connections, and choose "Serper (web search)".\n' +
	"Public SearXNG instances are not used: they block programmatic clients by design.";

/**
 * Query params that exist only for tracking; dropped so URLs dedupe cleanly.
 * Prefixes match a whole family (`utm_source`, `utm_medium`, ...); the exact
 * list must not match innocent params like `reference`.
 */
const TRACKING_PREFIXES = /^(utm_|ga_|mc_|matomo_|pk_)/i;
const TRACKING_EXACT = /^(_ga|fbclid|gclid|msclkid|igshid|ref|ref_src|source|spm|yclid|dclid)$/i;

/** @returns {boolean} True when a query param carries no meaning for the page. */
function isTrackingParam(key) {
	return TRACKING_PREFIXES.test(key) || TRACKING_EXACT.test(key);
}

/** Expand a leading `~` using HOME. */
function expandUser(p, env) {
	const home = env.HOME || env.USERPROFILE || "";
	if (p === "~") return home;
	if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
	return p;
}

/** Resolve the Optimus Prime config dir the same way the runtime does. */
function agentDir(env) {
	const raw =
		env.OPTIMUS_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || `${env.HOME || env.USERPROFILE || ""}/.optimus/agent`;
	return expandUser(raw, env);
}

/**
 * Resolve the Serper key: env var first, then the `serper` entry in auth.json,
 * so a key added via /login after boot is picked up without a restart.
 *
 * @returns {Promise<string>} The key, or "" when none is configured.
 */
async function serperKey(env) {
	const fromEnv = String(env.SERPER_API_KEY || "").trim();
	if (fromEnv) return fromEnv;
	try {
		const auth = JSON.parse(await Bun.file(`${agentDir(env)}/auth.json`).text());
		const cred = auth?.serper;
		if (cred?.type !== "api_key") return "";
		const value = String(cred.key || "").trim();
		// Stored values may name an env var; "!command" refs cannot be run here.
		return value.startsWith("!") ? "" : String(env[value] || value).trim();
	} catch {
		return ""; // missing/unreadable auth.json => no key
	}
}

/**
 * Resolve the SearXNG base URL: env var first, then the `searxng` entry in
 * auth.json. The env-only path breaks whenever a long-lived daemon was started
 * before the variable was exported, so the stored value is the durable source.
 *
 * @returns {Promise<string>} The base URL, or "" when none is configured.
 */
async function searxngUrl(env) {
	const fromEnv = String(env.SEARXNG_URL || "").trim();
	if (fromEnv) return fromEnv;
	try {
		const auth = JSON.parse(await Bun.file(`${agentDir(env)}/auth.json`).text());
		const cred = auth?.searxng;
		if (cred?.type !== "api_key") return "";
		const value = String(cred.key || "").trim();
		// Stored values may name an env var; "!command" refs cannot be run here.
		return value.startsWith("!") ? "" : String(env[value] || value).trim();
	} catch {
		return ""; // missing/unreadable auth.json => not configured
	}
}

/**
 * Strip HTML to readable text: drop script/style bodies, unwrap tags, decode
 * the entities that actually show up, collapse whitespace.
 *
 * @param {string} html
 * @returns {string} Plain text.
 */
const HTML_ENTITIES = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	apos: "'",
	mdash: "\u2014",
	ndash: "\u2013",
	hellip: "\u2026",
};

/** Decode the entity forms that actually appear in fetched pages. */
function decodeEntities(text) {
	return String(text)
		.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip);/gi, (_, e) => HTML_ENTITIES[e.toLowerCase()] ?? " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

export function stripHtml(html) {
	const entities = {
		nbsp: " ",
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		"#39": "'",
		apos: "'",
		mdash: "—",
		ndash: "–",
		hellip: "…",
	};
	// Preformatted blocks are lifted out before the whitespace collapse below and
	// restored afterwards. Without this, `[^\S\n]+` flattens every code sample
	// fetched from documentation to a single leading space -- cosmetic in most
	// languages, syntactically wrong in Python.
	const preserved = [];
	const withPlaceholders = String(html ?? "").replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
		preserved.push(body);
		return `\n\uE000${preserved.length - 1}\uE001\n`;
	});
	const restore = (text) =>
		text.replace(/\uE000(\d+)\uE001/g, (_, index) => {
			const body = preserved[Number(index)] ?? "";
			// Tags and entities still need handling; indentation does not.
			return decodeEntities(body.replace(/<[^>]+>/g, "")).replace(/[ \t]+$/gm, "");
		});

	return restore(
		withPlaceholders
			.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			// Keep block boundaries so words do not run together.
			.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)\b[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip);/gi, (_, e) => entities[e.toLowerCase()] ?? " ")
			.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
			// Hex numeric entities: sites that escape apostrophes emit &#x27; far more
			// often than &#39;, so skipping these leaks raw entity text into context.
			.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
			.replace(/[^\S\n]+/g, " ")
			.replace(/\n\s*\n\s*/g, "\n")
			.trim(),
	);
}

/**
 * Depth-aware scan for the element opened at `openEnd`, so nested elements of
 * the same name do not end it early.
 *
 * @returns {number} Index of the matching close tag, or -1 when unclosed.
 */
function closeIndex(html, tag, openEnd) {
	const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
	re.lastIndex = openEnd;
	let depth = 1;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		if (m[2] === "/") continue; // self-closing: opens and closes at once
		depth += m[1] === "/" ? -1 : 1;
		if (depth === 0) return m.index;
	}
	return -1;
}

/**
 * Inner HTML of the first element matching `openRe`, or null when absent or
 * unclosed. `openRe` must capture the tag name in group 1.
 *
 * @returns {string|null}
 */
function firstElement(html, openRe) {
	const open = openRe.exec(html);
	if (!open) return null;
	const end = closeIndex(html, open[1], open.index + open[0].length);
	return end === -1 ? null : html.slice(open.index + open[0].length, end);
}

/** Delete every `tags` subtree, honouring nesting. Unclosed tags are kept. */
function dropSubtrees(html, tags) {
	const re = new RegExp(`<(${tags.join("|")})\\b[^>]*?(/?)>`, "gi");
	let out = "";
	let last = 0;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		if (m.index < last) continue; // inside an already-dropped subtree
		out += html.slice(last, m.index);
		if (m[2] === "/") {
			last = re.lastIndex; // self-closing: drop the tag alone
			continue;
		}
		const end = closeIndex(html, m[1], re.lastIndex);
		if (end === -1) {
			out += m[0]; // unclosed: keep it rather than swallow the rest of the page
			last = re.lastIndex;
			continue;
		}
		last = html.indexOf(">", end) + 1 || end;
		re.lastIndex = last;
	}
	return out + html.slice(last);
}

/** Containers that hold the primary content, in order of confidence. */
const MAIN_CONTAINERS = [
	/<(main)\b[^>]*>/i,
	/<(article)\b[^>]*>/i,
	/<([a-z][a-z0-9-]*)\b[^>]*\brole\s*=\s*["']?main\b[^>]*>/i,
	/<([a-z][a-z0-9-]*)\b[^>]*\bid\s*=\s*["']?content["'\s>][^>]*>/i,
	/<(body)\b[^>]*>/i,
];

/**
 * Readable text of a page's main content: pick the primary container, drop
 * navigation chrome (nav, header, footer, aside, form, script, style), then
 * strip to text. Generic — no per-site rules.
 *
 * @param {string} html
 * @returns {string} Plain text of the article body.
 */
export function extractMainText(html) {
	const src = String(html ?? "")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
	let main = null;
	for (const re of MAIN_CONTAINERS) {
		main = firstElement(src, re);
		if (main !== null) break;
	}
	return stripHtml(dropSubtrees(main ?? src, ["nav", "header", "footer", "aside", "form"]));
}

/**
 * LRU of extracted page text, keyed by cleaned URL. A continuation must agree
 * with the slice already shown, and a live page can change between fetches, so
 * the text is pinned here rather than re-fetched.
 *
 * @type {Map<string, string>}
 */
const readCache = new Map();

/** @returns {string|undefined} Cached text, marked most-recently-used. */
function cacheGet(url) {
	const hit = readCache.get(url);
	if (hit === undefined) return undefined;
	readCache.delete(url);
	readCache.set(url, hit);
	return hit;
}

/** Store `text`, then evict oldest entries until both bounds hold. */
function cacheSet(url, text) {
	readCache.delete(url);
	readCache.set(url, text);
	let total = 0;
	for (const v of readCache.values()) total += v.length;
	while (readCache.size > 1 && (readCache.size > READ_CACHE_ENTRIES || total > READ_CACHE_CHARS)) {
		const oldest = readCache.keys().next().value;
		total -= readCache.get(oldest).length;
		readCache.delete(oldest);
	}
}

/** Reset the read cache. Exported for tests. */
export function clearReadCache() {
	readCache.clear();
}

/**
 * Return the slice of `text` starting at `offset`, within `maxChars`, ending
 * with either a continuation hint or an end-of-document marker.
 *
 * @returns {string}
 */
export function sliceDocument(url, text, { maxChars = DEFAULT_READ_CHARS, offset = 0 } = {}) {
	const total = text.length;
	const head = `${url}\n\n`;
	const start = Math.min(Math.max(Math.trunc(Number(offset) || 0), 0), total);
	// Upper bound on the footer, so the slice below can never push past maxChars.
	const reserve = `\n\n[chars ${start}-${total} of ${total} — continue with { offset: ${total} }]`.length;
	const room = maxChars - head.length - reserve;
	if (room < 1) return `${head}[document is ${total} chars; maxChars ${maxChars} leaves no room for text]`;

	let body = text.slice(start, start + room);
	if (start + body.length < total) {
		const space = body.lastIndexOf(" ");
		if (space > room * 0.6) body = body.slice(0, space); // do not split a word across slices
	}
	const end = start + body.length;
	const footer =
		end >= total
			? `\n\n[end of document — chars ${start}-${end} of ${total}]`
			: `\n\n[chars ${start}-${end} of ${total} — continue with { offset: ${end} }]`;
	return head + body.trimEnd() + footer;
}

/**
 * Normalise a URL for display and dedupe: drop tracking params, fragment, and
 * a trailing slash.
 *
 * @param {string} raw
 * @returns {string} Cleaned URL, or the input unchanged when unparseable.
 */
export function cleanUrl(raw) {
	try {
		const url = new URL(String(raw));
		for (const key of [...url.searchParams.keys()]) {
			if (isTrackingParam(key)) url.searchParams.delete(key);
		}
		url.hash = "";
		const out = url.toString();
		return out.endsWith("/") && url.pathname !== "/" ? out.slice(0, -1) : out;
	} catch {
		return String(raw ?? "");
	}
}

/**
 * Identity key for a page, as opposed to `cleanUrl`, which is what we display.
 * `https://www.x.com/a`, `http://x.com/a/` and `https://x.com/a/index.html` are one
 * page; keeping all three spends the snippet budget three times on the same text.
 *
 * @param {string} url - An already-cleaned URL.
 * @returns {string} Scheme-, `www.`- and index-insensitive key, or the input on failure.
 */
function urlIdentity(url) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
		const path = parsed.pathname.replace(/\/index\.html?$/i, "/").replace(/\/+$/, "");
		return `${host}${path}${parsed.search}`;
	} catch {
		return url;
	}
}

/**
 * Comparable form of a snippet, for collapsing syndicated copies of one article.
 * Mirrors publish identical text under different domains, which URL and title dedupe
 * cannot see. Returns "" for bodies too short to identify a page by.
 *
 * The whole body is the key, not a prefix: two unrelated pages can share a long
 * boilerplate lede, and snippets are short enough that hashing a prefix buys nothing.
 *
 * @param {string} snippet
 * @returns {string} Normalised key, or "" when the snippet is too short to trust.
 */
function snippetKey(snippet) {
	const normalized = String(snippet ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return normalized.length >= MIN_DEDUPE_SNIPPET_CHARS ? normalized : "";
}

/** Below this, a snippet is too generic to treat as a page fingerprint. */
const MIN_DEDUPE_SNIPPET_CHARS = 80;

/** Comparable form of a title, for collapsing near-identical engine results. */
function titleKey(title) {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.slice(0, 60);
}

/**
 * Deduplicate by URL, then collapse near-identical entries: one result per
 * (domain + similar title), and at most two per domain so a single site cannot
 * eat the whole budget.
 *
 * @param {Array<{title?: string, url?: string, content?: string}>} results - Raw backend results.
 * @returns {Array<{title: string, url: string, snippet: string}>} Cleaned, unique results.
 */
export function dedupeResults(results) {
	const seenUrl = new Set();
	const seenTitle = new Set();
	const seenSnippet = new Set();
	const perDomain = new Map();
	const out = [];

	for (const raw of results ?? []) {
		const url = cleanUrl(raw?.url);
		if (!url) continue;
		const identity = urlIdentity(url);
		if (seenUrl.has(identity)) continue;

		let domain;
		try {
			domain = new URL(url).hostname.replace(/^www\./, "");
		} catch {
			continue; // not a usable URL
		}

		const title = stripHtml(raw?.title) || url;
		const tKey = `${domain}|${titleKey(title)}`;
		const count = perDomain.get(domain) ?? 0;
		if (seenTitle.has(tKey) || count >= 2) continue;

		// Last gate, and the only one that catches syndication: same body, different
		// site. Skipped for short snippets, which are too generic to fingerprint.
		const snippet = stripHtml(raw?.content);
		const sKey = snippetKey(snippet);
		if (sKey && seenSnippet.has(sKey)) continue;

		seenUrl.add(identity);
		seenTitle.add(tKey);
		if (sKey) seenSnippet.add(sKey);
		perDomain.set(domain, count + 1);
		out.push({ title, url, snippet });
	}
	return out;
}

/** Cut `text` to `max` chars on a word boundary, adding an ellipsis. */
function clip(text, max) {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Render results within a hard character budget, stating any truncation.
 *
 * @param {Array<{title: string, url: string, snippet: string}>} results
 * @param {object} opts
 * @param {string} opts.query - The query, echoed in the header.
 * @param {string} [opts.via] - Backend label, e.g. the SearXNG URL.
 * @param {number} [opts.count=6] - Maximum results to include.
 * @param {number} [opts.maxChars=2400] - Hard cap on the whole response.
 * @returns {string} Formatted, budget-bounded text.
 */
export function formatResults(results, { query, via = "", count = DEFAULT_COUNT, maxChars = DEFAULT_MAX_CHARS }) {
	const header = `Results for "${query}"${via ? ` (via ${via})` : ""}:`;
	const wanted = results.slice(0, count);
	if (wanted.length === 0) return `${header}\n\nNo results.`;

	const lines = [header, ""];
	let used = header.length + 1;
	let shown = 0;

	for (const r of wanted) {
		const entry = `${shown + 1}. ${clip(r.title, 100)}\n   ${r.url}${r.snippet ? `\n   ${clip(r.snippet, SNIPPET_CHARS)}` : ""}`;
		// Always emit the first result, even if it alone overruns the budget.
		if (shown > 0 && used + entry.length + 1 > maxChars) break;
		lines.push(entry);
		used += entry.length + 1;
		shown++;
	}

	if (shown < results.length) {
		lines.push("", `[truncated: showing ${shown} of ${results.length} results, ${maxChars} char budget]`);
	}
	const out = lines.join("\n");
	return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

/**
 * Query a self-hosted SearXNG instance's JSON API.
 *
 * @returns {Promise<Array<object>>} Raw results.
 * @throws {Error} With actionable text when the instance rejects the JSON API.
 */
async function searchSearxng(base, query, { timeoutMs, extra }) {
	const url = new URL("search", `${String(base).replace(/\/+$/, "")}/`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	for (const [k, v] of Object.entries(extra)) {
		if (v) url.searchParams.set(k, String(v));
	}

	const resp = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!resp.ok) {
		const hint =
			resp.status === 403 || resp.status === 429
				? " - the bot limiter is on; set `server.limiter: false` in settings.yml"
				: "";
		throw new Error(`SearXNG at ${base} returned HTTP ${resp.status}${hint}`);
	}
	if (!(resp.headers.get("content-type") ?? "").includes("json")) {
		throw new Error(`SearXNG at ${base} returned HTML, not JSON - add "json" to \`search.formats\` in settings.yml`);
	}
	const data = await resp.json();
	const results = Array.isArray(data?.results) ? data.results : [];

	// Wikipedia and Wikidata answer as `infoboxes`, not `results` — a knowledge-category query
	// otherwise looks empty while carrying exactly the clean factual answer the agent asked for.
	// Mapped onto the common shape and placed first, because a curated summary beats a crawl hit.
	const infoboxes = (Array.isArray(data?.infoboxes) ? data.infoboxes : []).map((box) => ({
		title: box?.infobox ?? "",
		url: box?.id ?? box?.urls?.[0]?.url ?? "",
		content: box?.content ?? "",
	}));

	return [...infoboxes.filter((b) => b.title && b.url), ...results];
}

/**
 * Query the Serper API, mapping its shape onto the common one.
 *
 * @returns {Promise<Array<object>>} Raw results as `{title, url, content}`.
 */
async function searchSerper(key, query, { timeoutMs, count }) {
	const resp = await fetch(SERPER_URL, {
		method: "POST",
		headers: { "X-API-KEY": key, "Content-Type": "application/json", "User-Agent": USER_AGENT },
		body: JSON.stringify({ q: query, num: Math.max(count, 10) }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!resp.ok)
		throw new Error(`Serper returned HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
	const data = await resp.json();
	return (data?.organic ?? []).map((r) => ({ title: r?.title, url: r?.link, content: r?.snippet }));
}

export default function createSkill(ctx = {}) {
	const env = ctx.env || process.env;

	/**
	 * Decide which backend to use: explicit choice, then SearXNG, then Serper.
	 * Never falls back to public instances.
	 *
	 * @returns {Promise<{backend: "searxng"|"serper"|"none", url?: string, key?: string}>}
	 */
	async function selectBackend(explicit) {
		const choice = String(explicit || env.OPTIMUS_WEBSEARCH_BACKEND || "")
			.trim()
			.toLowerCase();
		const url = await searxngUrl(env);
		const key = await serperKey(env);

		if (choice === "searxng") return url ? { backend: "searxng", url } : { backend: "none" };
		if (choice === "serper") return key ? { backend: "serper", key } : { backend: "none" };
		if (url) return { backend: "searxng", url };
		if (key) return { backend: "serper", key };
		return { backend: "none" };
	}

	return {
		/**
		 * Search the web and return a short, deduplicated, budget-capped summary.
		 *
		 * Backend order: `options.backend` (or `OPTIMUS_WEBSEARCH_BACKEND`),
		 * then `SEARXNG_URL`, then a Serper key. Returns setup instructions when
		 * neither is configured.
		 *
		 * @param {string} query - Search query.
		 * @param {object} [options]
		 * @param {number} [options.count=6] - Results to return.
		 * @param {number} [options.maxChars=2400] - Hard cap on the response (≈600 tokens).
		 * @param {number} [options.timeout=15] - Timeout in seconds.
		 * @param {"searxng"|"serper"} [options.backend] - Force a backend.
		 * @param {string} [options.language] - SearXNG `language` param, e.g. `"en"`.
		 * @param {string} [options.time_range] - SearXNG range: `day`, `week`, `month`, `year`.
		 * @returns {Promise<string>} Formatted results, or an actionable error message.
		 */
		async run(query, options = {}) {
			const { count = DEFAULT_COUNT, maxChars = DEFAULT_MAX_CHARS, timeout = 15 } = options;
			const timeoutMs = timeout * 1000;

			const chosen = await selectBackend(options.backend);
			if (chosen.backend === "none") return NOT_CONFIGURED_MESSAGE;

			try {
				const [results, via] =
					chosen.backend === "searxng"
						? [
								await searchSearxng(chosen.url, query, {
									timeoutMs,
									extra: { language: options.language, time_range: options.time_range },
								}),
								chosen.url,
							]
						: [await searchSerper(chosen.key, query, { timeoutMs, count }), "serper"];
				return formatResults(dedupeResults(results), { query, via, count, maxChars });
			} catch (e) {
				return `Web search failed: ${e?.message || e}`;
			}
		},

		/**
		 * Fetch one URL and return a bounded slice of its readable main content.
		 *
		 * Navigation chrome is dropped before truncation, the extracted text is
		 * cached per URL, and `offset` returns the next slice instead of
		 * repeating what the caller already read. The last line always states the
		 * range returned and how to continue, or that the document is exhausted.
		 *
		 * @param {string} url - Absolute http(s) URL.
		 * @param {object} [options]
		 * @param {number} [options.maxChars=4000] - Hard cap on the response (≈1000 tokens).
		 * @param {number} [options.offset=0] - Start position in the extracted text.
		 * @param {boolean} [options.refresh=false] - Re-fetch instead of using the cache.
		 * @param {number} [options.timeout=15] - Timeout in seconds.
		 * @returns {Promise<string>} Readable page text, or an error message.
		 */
		async read(url, options = {}) {
			const { maxChars = DEFAULT_READ_CHARS, timeout = 15, offset = 0, refresh = false } = options;
			const key = cleanUrl(url);
			try {
				let text = refresh ? undefined : cacheGet(key);
				if (text === undefined) {
					const resp = await fetch(url, {
						headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" },
						signal: AbortSignal.timeout(timeout * 1000),
						redirect: "follow",
					});
					if (!resp.ok) return `Fetch failed for ${url}: HTTP ${resp.status}`;

					const type = resp.headers.get("content-type") ?? "";
					if (!/text\/|json|xml/i.test(type)) {
						return `Fetch skipped for ${url}: unsupported content-type "${type.split(";")[0]}"`;
					}
					const body = await resp.text();
					text = /html/i.test(type) ? extractMainText(body) : stripHtml(body);
					cacheSet(key, text);
				}
				return sliceDocument(key, text, { maxChars, offset });
			} catch (e) {
				return `Fetch failed for ${url}: ${e?.message || e}`;
			}
		},
	};
}
