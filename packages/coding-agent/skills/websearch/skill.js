/**
 * Prime Agent websearch skill: one bounded search interface over two backends.
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
const USER_AGENT = "prime-agent-websearch/1.0 (+https://github.com/PrimeIntellect-ai/prime-agent)";

const SERPER_URL = "https://google.serper.dev/search";

export const NOT_CONFIGURED_MESSAGE =
	"Web search is not configured. Two options, either works:\n" +
	"  1. Self-hosted SearXNG (recommended: free, keyless, private)\n" +
	"       docker run -d -p 8888:8080 searxng/searxng\n" +
	"     then in settings.yml set `search.formats: [html, json]` and `server.limiter: false`,\n" +
	"     and export SEARXNG_URL=http://localhost:8888\n" +
	"  2. Serper (hosted Google API, free tier): get a key at https://serper.dev, then run\n" +
	'     /login in Prime Agent, switch to MCP Connections, and choose "Serper (web search)".\n' +
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

/** Resolve the Prime Agent config dir the same way the runtime does. */
function agentDir(env) {
	const raw =
		env.PRIME_AGENT_CODING_AGENT_DIR ||
		env.PI_CODING_AGENT_DIR ||
		`${env.HOME || env.USERPROFILE || ""}/.prime/agent`;
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
 * Strip HTML to readable text: drop script/style bodies, unwrap tags, decode
 * the entities that actually show up, collapse whitespace.
 *
 * @param {string} html
 * @returns {string} Plain text.
 */
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
	return (
		String(html ?? "")
			.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			// Keep block boundaries so words do not run together.
			.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)\b[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip);/gi, (_, e) => entities[e.toLowerCase()] ?? " ")
			.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
			.replace(/[^\S\n]+/g, " ")
			.replace(/\n\s*\n\s*/g, "\n")
			.trim()
	);
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
	const perDomain = new Map();
	const out = [];

	for (const raw of results ?? []) {
		const url = cleanUrl(raw?.url);
		if (!url || seenUrl.has(url)) continue;

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

		seenUrl.add(url);
		seenTitle.add(tKey);
		perDomain.set(domain, count + 1);
		out.push({ title, url, snippet: stripHtml(raw?.content) });
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
		const choice = String(explicit || env.PRIME_AGENT_WEBSEARCH_BACKEND || "")
			.trim()
			.toLowerCase();
		const url = String(env.SEARXNG_URL || "").trim();
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
		 * Backend order: `options.backend` (or `PRIME_AGENT_WEBSEARCH_BACKEND`),
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
		 * Fetch one URL and return its readable text, bounded like search results.
		 *
		 * A small HTML-to-text pass, not a full readability implementation.
		 *
		 * @param {string} url - Absolute http(s) URL.
		 * @param {object} [options]
		 * @param {number} [options.maxChars=4000] - Hard cap on returned text (≈1000 tokens).
		 * @param {number} [options.timeout=15] - Timeout in seconds.
		 * @returns {Promise<string>} Readable page text, or an error message.
		 */
		async read(url, options = {}) {
			const { maxChars = DEFAULT_READ_CHARS, timeout = 15 } = options;
			try {
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

				const head = `${cleanUrl(url)}\n\n`;
				const text = stripHtml(await resp.text());
				if (head.length + text.length <= maxChars) return head + text;
				return `${head}${clip(text, maxChars - head.length - 40)}\n\n[truncated to ${maxChars} chars]`;
			} catch (e) {
				return `Fetch failed for ${url}: ${e?.message || e}`;
			}
		},
	};
}
