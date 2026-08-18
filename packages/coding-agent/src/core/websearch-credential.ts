// Shared identifiers for the bundled websearch skill's Serper credential, used by
// the /login UI (auth.json key) and the kernel env injection.
export const WEBSEARCH_SKILL_NAME = "websearch";
export const SERPER_CREDENTIAL_ID = "serper";
export const SERPER_CREDENTIAL_NAME = "Serper (web search)";
export const SERPER_ENV_VAR = "SERPER_API_KEY";

// SearXNG has no key, but its base URL is stored the same way so a daemon started
// before SEARXNG_URL was exported still resolves a configured backend.
export const SEARXNG_CREDENTIAL_ID = "searxng";
export const SEARXNG_ENV_VAR = "SEARXNG_URL";
