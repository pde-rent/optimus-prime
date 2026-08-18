---
name: websearch
description: Search Google via the Serper API. Configure access via /login, then MCP Connections, then Serper (web search). Takes one query and returns titles, URLs, snippets, and knowledge-graph data.
---

# Web Search

Search the web via the Serper Google Search API.

## Setup

Get a free API key at https://serper.dev, then run `/login` in Prime Agent,
switch to **MCP Connections**, and choose **Serper (web search)** to paste it.
The key is stored in Prime Agent and made available to this skill automatically.

If web search reports a missing key, walk the user through those two steps;
don't ask them to set environment variables.

Optional overrides (environment variables):

- `PRIME_AGENT_WEBSEARCH_TIMEOUT` - HTTP timeout in seconds (default 45).
- `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` - number of organic results to return (default 5).

## Usage

Call the prepared `websearch` object directly in the JS REPL:

```js
console.log(await websearch.run("latest Prime Agent release"));
```

## API

- `await websearch.run(query, options?)` — run one Google search and return
  formatted results as a string. Options (all optional):
  - `max_output` — truncate output to this many chars (default 8192);
    the middle is replaced with a `... [output truncated, N chars total] ...` marker.
  - `timeout` — HTTP timeout in seconds (default `PRIME_AGENT_WEBSEARCH_TIMEOUT` or 45).
  - `num_results` — organic results to return (default `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` or 5).

```js
await websearch.run("bun test runner docs", { num_results: 10, timeout: 20 });
```

Network and API errors are returned inside the result string rather than
thrown, so a failed search never breaks the surrounding cell.
