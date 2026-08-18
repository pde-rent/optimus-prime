---
name: websearch
description: Search the web with `await websearch.run(query, options?)` and read one page as text with `await websearch.read(url, options?)`, via a self-hosted SearXNG instance (SEARXNG_URL, free and keyless) or the Serper API. Output is deduplicated and character-capped; `read` strips site navigation and supports `{ offset }` continuation.
---

# Web Search

One bounded search interface over two backends. Pick either; SearXNG is recommended.

## Setup

### Option 1: self-hosted SearXNG (recommended - free, keyless, private)

```sh
docker run -d -p 8888:8080 searxng/searxng
export SEARXNG_URL=http://localhost:8888
```

Then in the instance's `settings.yml`:

```yaml
search:
  formats: [html, json]   # the JSON API is OFF by default
server:
  limiter: false          # the bot limiter blocks programmatic clients
```

Restart the container after editing. Nothing leaves your machine except the
searches themselves, and there is no rate limit to work around.

### Option 2: Serper (hosted Google API)

Get a key at https://serper.dev, then run `/login`, switch to **MCP Connections**,
and choose **Serper (web search)**. The key is stored with your other credentials
and supplied to this skill automatically. `SERPER_API_KEY` also works.

### Why not public SearXNG instances?

They are not used, deliberately. A probe of the healthiest, fastest public
instances from `searx.space` found effectively none that answer a programmatic
JSON query: they return `429`, `403`, or `418` on the first request from a clean
IP, because operators turn the JSON API off and run a bot limiter. Rotating
between instances to get around that would be circumventing anti-abuse controls
on volunteer-run servers. Self-host instead - it is one command.

## Backend selection

In order:

1. `options.backend` (`"searxng"` or `"serper"`), or `PRIME_AGENT_WEBSEARCH_BACKEND`
2. `SEARXNG_URL`
3. A Serper key
4. Otherwise: a message explaining both options. Never a silent fallback.

An explicit choice that is not configured returns the setup message rather than
quietly switching backends.

## Usage

```js
console.log(await websearch.run("bun test runner docs"));
```

```js
// Narrow the query and tighten the budget.
await websearch.run("searxng json api", { count: 3, maxChars: 800, time_range: "year" });

// Force a backend.
await websearch.run("rust async runtimes", { backend: "serper" });

// Read one page as text. Navigation chrome is stripped; the last line states
// the range returned and how to continue.
console.log(await websearch.read("https://docs.searxng.org/", { maxChars: 2000 }));

// Continue from where the previous read stopped - no re-fetch, no repetition.
await websearch.read("https://docs.searxng.org/", { maxChars: 2000, offset: 2000 });
```

## Token cost

Output is capped because it lands directly in the agent's context.

| Call | Chars | ≈ Tokens |
|---|---|---|
| `run(q)` (defaults: `count: 6`, `maxChars: 2400`) | 1300-1600 typical, 2400 hard cap | ~350-400 typical, ~600 max |
| `run(q, { count: 3, maxChars: 800 })` | ≤800 | ~200 |
| `read(url)` (default `maxChars: 4000`) | ≤4000 per slice | ~1000 |

Results are deduplicated by URL and by domain (max 2 per site), near-identical
titles from different engines are collapsed, HTML is stripped, and tracking
params (`utm_*`, `fbclid`, `gclid`, ...) are dropped. When the budget bites, the
output says so explicitly: `[truncated: showing N of M results, X char budget]`.

## API

- `await websearch.run(query, options?)` → `Promise<string>`
  - `count` (default 6) - results to return.
  - `maxChars` (default 2400) - hard cap on the whole response.
  - `timeout` (default 15) - seconds.
  - `backend` - `"searxng"` or `"serper"`, overriding the default order.
  - `language` - SearXNG only, e.g. `"en"`.
  - `time_range` - SearXNG only: `day`, `week`, `month`, `year`.

- `await websearch.read(url, options?)` → `Promise<string>`
  - `maxChars` (default 4000) - hard cap on the response.
  - `offset` (default 0) - start position in the extracted text, for continuing
    a previous read.
  - `refresh` (default false) - re-fetch instead of serving the cached text.
  - `timeout` (default 15) - seconds.
  - Main content is extracted before truncation: the first `<main>`, `<article>`,
    `role="main"`, or `id="content"` container (else `<body>`), minus `script`,
    `style`, `noscript`, `nav`, `header`, `footer`, `aside`, and `form`
    subtrees. Generic, not per-site; on a Wikipedia article it removes the
    ~1500 characters of menu, table of contents, and language list that
    otherwise arrive before the first sentence. Non-text content types are
    refused.
  - The extracted text is cached per URL (small LRU) so a continuation costs no
    round trip and cannot disagree with the slice already returned. `refresh`
    bypasses it.
  - Every response ends with its range, either
    `[chars 6000-14000 of 48213 - continue with { offset: 14000 }]` or
    `[end of document - chars 40000-48213 of 48213]`.

Network, configuration, and API errors are returned inside the result string
rather than thrown, so a failed search never breaks the surrounding cell.
