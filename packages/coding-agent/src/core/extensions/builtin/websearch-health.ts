/**
 * Built-in websearch backend health check.
 *
 * On session start, verifies that at least one backend of the websearch skill
 * is usable: a Serper API key, or a reachable self-hosted SearXNG instance.
 * When neither resolves, the user is warned once per process with setup links,
 * so a dead search backend surfaces at boot instead of failing silently
 * mid-task. Resolution mirrors the skill itself: env vars first, then the
 * matching entries in auth.json.
 *
 * The SearXNG reachability probe is skipped when PI_OFFLINE is set (--offline),
 * since it is a network operation.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../../config.js";
import { isTruthyEnvVar } from "../../../utils/shared.js";
import type { ExtensionFactory } from "../types.js";

const SEARXNG_PROBE_TIMEOUT_MS = 3_000;
const SEARXNG_SETUP_URL = "https://docs.searxng.org/admin/installation-docker.html";
const SERPER_SIGNUP_URL = "https://serper.dev";

/**
 * Read one api_key credential from auth.json by name, expanding values that
 * name an env var. "!command" references cannot be evaluated here.
 */
async function storedCredential(name: string): Promise<string> {
	try {
		const auth = JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: unknown } | undefined
		>;
		const cred = auth[name];
		if (cred?.type !== "api_key") return "";
		const value = String(cred.key ?? "").trim();
		return value.startsWith("!") ? "" : String(process.env[value] || value).trim();
	} catch {
		return "";
	}
}

/**
 * Probe the SearXNG JSON API. Returns a human-readable failure reason, or
 * null when the instance answered correctly.
 */
async function probeSearxng(baseUrl: string): Promise<string | null> {
	const base = baseUrl.replace(/\/+$/, "");
	try {
		const resp = await fetch(`${base}/search?q=optimus+websearch+healthcheck&format=json`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(SEARXNG_PROBE_TIMEOUT_MS),
		});
		if (resp.ok) {
			const contentType = resp.headers.get("content-type") ?? "";
			if (contentType.includes("json")) return null;
			return 'answered, but not with JSON - add "json" to search.formats in settings.yml';
		}
		if (resp.status === 403) return `returned HTTP 403 - set limiter: false in settings.yml`;
		return `returned HTTP ${resp.status}`;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `unreachable (${detail})`;
	}
}

function noBackendMessage(): string {
	return [
		"No web search backend is configured; the websearch skill will not work.",
		`  1. Serper API key - create one at ${SERPER_SIGNUP_URL}, then run /login, choose MCP Connections > Serper (web search), or export SERPER_API_KEY.`,
		`  2. Self-hosted SearXNG - local install guide: ${SEARXNG_SETUP_URL}`,
		"     docker run -d -p 8888:8080 searxng/searxng && export SEARXNG_URL=http://localhost:8888",
	].join("\n");
}

function searxngFailureMessage(baseUrl: string, reason: string): string {
	return [
		`The configured SearXNG instance ${baseUrl} ${reason}; the websearch skill will not work.`,
		`Self-hosted install guide: ${SEARXNG_SETUP_URL}`,
		"  docker run -d -p 8888:8080 searxng/searxng && export SEARXNG_URL=http://localhost:8888",
		`Or switch to a Serper API key: ${SERPER_SIGNUP_URL}`,
	].join("\n");
}

export function createWebsearchHealthExtension(): ExtensionFactory {
	let warned = false;
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (warned) return;
			const serperKey = String(process.env.SERPER_API_KEY || "").trim() || (await storedCredential("serper"));
			if (serperKey) return;
			const searxngUrl = String(process.env.SEARXNG_URL || "").trim() || (await storedCredential("searxng"));
			if (!searxngUrl) {
				warned = true;
				ctx.ui.notify(noBackendMessage(), "warning");
				return;
			}
			if (isTruthyEnvVar(process.env.PI_OFFLINE)) return;
			// Probe off the critical path: session_start blocks startup, and a dead
			// backend would hold boot for the full probe timeout. The warning still
			// surfaces once the probe settles.
			void probeSearxng(searxngUrl).then((reason) => {
				if (warned || reason === null) return;
				warned = true;
				ctx.ui.notify(searxngFailureMessage(searxngUrl, reason), "warning");
			});
		});
	};
}
