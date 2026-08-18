/**
 * Prime Agent websearch skill: Google search via the Serper API.
 *
 * Port of the original Python skill. Uses native `fetch` and `Bun.file()`;
 * no npm dependencies. The API key is resolved on every call (env var first,
 * then `auth.json` in the agent dir) so a key added via /login after boot is
 * picked up without a restart.
 */

const SERPER_URL = "https://google.serper.dev/search";

const NO_KEY_MESSAGE =
	"Web search is not set up yet: no Serper API key is configured.\n" +
	"Tell the user how to enable it:\n" +
	"  1. Get a free API key at https://serper.dev (sign up, copy the key).\n" +
	'  2. In Prime Agent, run /login, switch to MCP Connections, choose "Serper (web search)", and paste the key.\n' +
	"Do not ask the user to set environment variables. Once the key is saved, web search works automatically.";

/** Read an int from `env`, falling back to `fallback` on missing/bad values. */
function envInt(env, name, fallback) {
	const raw = env[name];
	if (raw === undefined || raw === null) return fallback;
	const n = Number.parseInt(String(raw), 10);
	return Number.isNaN(n) ? fallback : n;
}

/** Expand a leading `~` using HOME, matching Python's `Path.expanduser()`. */
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
 * Stored keys may be a literal or an env-var name; "!command" refs can't be
 * run safely here, so skip them (the agent injects those resolved at build time).
 */
function resolveConfigValue(value, env) {
	const v = String(value || "").trim();
	if (!v || v.startsWith("!")) return "";
	return String(env[v] || v).trim();
}

/** Env var wins; otherwise read the `serper` api_key entry from auth.json. */
async function resolveApiKey(env) {
	const envKey = String(env.SERPER_API_KEY || "").trim();
	if (envKey) return envKey;

	try {
		const auth = JSON.parse(await Bun.file(`${agentDir(env)}/auth.json`).text());
		const cred = auth && typeof auth === "object" ? auth.serper : null;
		if (cred && typeof cred === "object" && cred.type === "api_key") {
			return resolveConfigValue(cred.key, env);
		}
	} catch {
		// Missing/unreadable/invalid auth.json => no key.
	}
	return "";
}

const str = (v) => String(v ?? "").trim();

/** Format a Serper API response into readable text. */
function formatSerperResults(data, query, numResults = 5) {
	const sections = [];

	const kg = data?.knowledgeGraph;
	if (kg) {
		const kgLines = [];
		const title = str(kg.title);
		if (title) kgLines.push(`Knowledge Graph: ${title}`);
		const description = str(kg.description);
		if (description) kgLines.push(description);
		for (const [key, value] of Object.entries(kg.attributes || {})) {
			const text = str(value);
			if (text) kgLines.push(`${key}: ${text}`);
		}
		if (kgLines.length) sections.push(kgLines.join("\n"));
	}

	const organic = (data?.organic || []).slice(0, numResults);
	organic.forEach((result, i) => {
		const lines = [`Result ${i}: ${str(result.title) || "Untitled"}`];
		const link = str(result.link);
		if (link) lines.push(`URL: ${link}`);
		const snippet = str(result.snippet);
		if (snippet) lines.push(snippet);
		sections.push(lines.join("\n"));
	});

	const peopleAlsoAsk = data?.peopleAlsoAsk || [];
	if (peopleAlsoAsk.length) {
		const maxQ = Math.max(1, Math.min(3, peopleAlsoAsk.length));
		const questions = [];
		for (const item of peopleAlsoAsk.slice(0, maxQ)) {
			const question = str(item.question);
			if (!question) continue;
			let entry = `Q: ${question}`;
			const answer = str(item.snippet);
			if (answer) entry += `\nA: ${answer}`;
			questions.push(entry);
		}
		if (questions.length) sections.push(`People Also Ask:\n${questions.join("\n")}`);
	}

	if (!sections.length) return `No results returned for query: ${query}`;

	return sections.join("\n\n---\n\n");
}

/** Execute a single Serper API search and format the response. */
async function fetchSerper(query, apiKey, timeout = 45, numResults = 5) {
	const resp = await fetch(SERPER_URL, {
		method: "POST",
		body: JSON.stringify({ q: query }),
		headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
		signal: AbortSignal.timeout(timeout * 1000),
	});
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(`Serper search error (${resp.status}): ${body}`);
	}
	return formatSerperResults(await resp.json(), query, numResults);
}

export default function createSkill(ctx = {}) {
	const env = ctx.env || process.env;

	return {
		/**
		 * Run a Google search via Serper and return formatted results.
		 *
		 * @param {string} query - Google search query.
		 * @param {object} [options]
		 * @param {number} [options.max_output=8192] - Truncate output to this many chars.
		 * @param {number} [options.timeout] - HTTP timeout in seconds
		 *   (default `PRIME_AGENT_WEBSEARCH_TIMEOUT` or 45).
		 * @param {number} [options.num_results] - Organic results to return
		 *   (default `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` or 5).
		 * @returns {Promise<string>} Formatted search results.
		 */
		async run(query, options = {}) {
			const { max_output: maxOutput = 8192 } = options;

			const apiKey = await resolveApiKey(env);
			if (!apiKey) return NO_KEY_MESSAGE;

			const timeout = options.timeout ?? envInt(env, "PRIME_AGENT_WEBSEARCH_TIMEOUT", 45);
			const numResults = options.num_results ?? envInt(env, "PRIME_AGENT_WEBSEARCH_NUM_RESULTS", 5);

			let result;
			try {
				result = await fetchSerper(query, apiKey, timeout, numResults);
			} catch (e) {
				result = `Error searching for '${query}': ${e?.message || e}`;
			}

			let output = `Results for query "${query}":\n\n${result}`;

			if (output.length > maxOutput) {
				const total = output.length;
				const marker = `\n... [output truncated, ${total} chars total] ...\n`;
				// Reserve room for the marker so the result stays within max_output.
				const half = Math.max(0, Math.floor((maxOutput - marker.length) / 2));
				output = output.slice(0, half) + marker + output.slice(output.length - half);
				if (output.length > maxOutput) output = output.slice(0, maxOutput); // marker alone exceeds the budget
			}

			return output;
		},
	};
}
