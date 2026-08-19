# MCP Integrations

Connect external services (Linear, Notion, …) to Optimus Prime over the
[Model Context Protocol](https://modelcontextprotocol.io).

Consistent with Optimus Prime's single-tool design, MCP integrations are **not**
exposed as new agent tools. Each integration is a [JS-backed skill](skills.md)
bound as a global in the persistent JavaScript REPL, which the model calls
directly:

```js
const issues = await linear.list_issues({ team: "Engineering" });
```

The MCP connection is spoken from the REPL: MCP Streamable HTTP (JSON-RPC 2.0
over `fetch`, handling both plain-JSON and `text/event-stream` responses), with
no npm dependencies. The host's only jobs are interactive login (browser OAuth),
minting/refreshing credentials in `auth.json`, and resolving the server's URL and
headers.

## Table of Contents

- [Using a built-in integration](#using-a-built-in-integration)
- [How a call works](#how-a-call-works)
- [Authoring your own integration](#authoring-your-own-integration)
  - [1. Declare the server](#1-declare-the-server)
  - [2. Ship the skill](#2-ship-the-skill)
  - [Authentication](#authentication)
- [The MCP skill API](#the-mcp-skill-api)
- [Enable-by-login lifecycle](#enable-by-login-lifecycle)
- [Caveats](#caveats)

## Using a built-in integration

Built-in integrations (Linear, Notion) ship **disabled**. Logging in enables them:

- Open `/login`, switch to **MCP Connections**, pick the integration, and
  complete OAuth in the browser. `/mcp login <name>` does the same from the CLI.
- Once connected, the integration's skill becomes visible to the model and its
  `skill.js` is preloaded into the REPL as a global.
- `/mcp` lists integrations and connection status; `/mcp logout <name>`
  disconnects.

Credentials are stored once in `~/.optimus/agent/auth.json` under `mcp:<name>`.
Enablement is derived from whether valid credentials exist — there is no separate
on/off switch.

## How a call works

The tool set is defined by the **server**, not the skill, so discover before you
call — don't assume tool names or arguments:

```js
// 1. Discover available tools (names + JSON Schemas)
for (const tool of await linear.list_tools()) {
	console.log(tool.name, "-", tool.description);
}

// 2. Inspect a tool's argument schema
const tools = await linear.list_tools();
console.log(JSON.stringify(tools.find((t) => t.name === "list_issues").inputSchema, null, 2));

// 3. Call it; the argument object must match the tool's input schema
const result = await linear.list_issues({ team: "Engineering" });
```

- Every tool call is `async` — always `await`.
- Any property that isn't `list_tools` / `call_tool` / `client` is dispatched to
  a matching MCP tool by a `Proxy`, so `linear.<tool>(args)` works for every tool
  the server exposes. An unknown name fails with the list of available tools.
- Results are already-parsed JavaScript: an object for structured output, a
  string for text, or an array of content blocks otherwise. No `JSON.parse`.
- A tool whose name isn't a valid JavaScript identifier (e.g. Notion's
  `notion-search`) is called via the escape hatch:
  `await notion.call_tool("notion-search", { query: "roadmap" })`.
- A call against an integration with no credentials throws `NotEnabled` (telling
  the user to run `/mcp login <server>`); a tool that returns an error result
  throws `McpToolError`.
- Each call opens a fresh MCP session (`initialize` → `notifications/initialized`
  → request). On a 401/403 the skill asks the host to refresh the token once and
  retries the whole exchange.

## Authoring your own integration

An integration is a [JS-backed skill](skills.md#js-backed-skills) whose
`skill.js` returns the object built by the shared `createMcpSkill` helper. The
built-in `linear` / `notion` skills are the reference implementations: each is a
directory holding `SKILL.md`, `skill.js`, and a copy of `mcp-client.js`.

### 1. Declare the server

Add it under `mcpServers` in `~/.optimus/agent/settings.json` (or project
`.optimus/agent/settings.json`):

```jsonc
// ~/.optimus/agent/settings.json
{
  "mcpServers": {
    "acme": {
      "type": "http",
      "url": "https://mcp.acme.com/mcp",
      "oauth": true
    }
  }
}
```

Only remote `"http"` servers are wired through to the REPL. HTTP server fields:

| Field | Meaning |
|-------|---------|
| `type` | Must be `"http"` |
| `url` | The MCP endpoint |
| `oauth` | `true` to use the browser OAuth flow (requires the server to support dynamic client registration) |
| `bearerTokenEnvVar` | Name of an env var holding a static bearer token, instead of OAuth |
| `headers` | Extra static HTTP headers sent on every request |
| `enabled` | Set `false` to force-disable even when credentials exist |

> `stdio` (local-subprocess) servers are not wired through — the host drops
> non-HTTP entries — so an integration must target an HTTP endpoint.

### 2. Ship the skill

Create a skill directory (any [skills location](skills.md#locations), e.g.
`~/.optimus/agent/skills/acme/`) with the JS-skill layout:

```
acme/
  SKILL.md
  skill.js
  mcp-client.js   # copied from skills/linear/mcp-client.js
```

Copy `mcp-client.js` verbatim from a built-in MCP skill. It is duplicated into
every MCP skill on purpose: skills are loaded by absolute entry path from
independent roots (user dir, project dir, bundled dir) and may be installed
individually, so a relative import across skill directories isn't robust.

`skill.js`:

```js
/**
 * Acme integration: tools auto-discovered from Acme's MCP server.
 *
 * Usage in the REPL:
 *
 *     const widgets = await acme.list_widgets({ team: "Engineering" });
 */

import { createMcpSkill } from "./mcp-client.js";

export default function createSkill(ctx) {
	return createMcpSkill({ server: "acme", url: "https://mcp.acme.com/mcp" }, ctx);
}
```

That is the whole integration. `createMcpSkill` connects over Streamable HTTP,
resolves the URL and extra headers from the host (`hostRequest("mcp.config", …)`,
honoring the `mcpServers` entry), injects the bearer token read from `auth.json`
(refreshing via `hostRequest("mcp.refresh", …)` when stale), discovers and caches
the server's tools, and returns the proxied API. `server` must match the
`mcpServers` key and the `auth.json` credential id (`mcp:acme`). The REPL binds
the returned object under the skill name with hyphens converted to underscores.

For a server behind a static token, name the env var in the same call:

```js
return createMcpSkill(
	{ server: "acme", url: "https://mcp.acme.com/mcp", bearerTokenEnv: "ACME_TOKEN" },
	ctx,
);
```

There is no install step — add or edit the files, then start a fresh session (or
`/reload` for metadata) so the REPL preloads the module.

### Authentication

- **OAuth** (`"oauth": true`): the user runs `/login` → MCP Connections → your server (or
  `/mcp login acme`). Works when the server supports OAuth 2.1 dynamic client
  registration (RFC 7591); login discovers the auth server, registers a client,
  and runs PKCE. Servers requiring a pre-registered client id are not yet
  supported via `mcpServers`.
- **Static bearer token** (`"bearerTokenEnvVar": "ACME_TOKEN"`): no login needed;
  the integration is "connected" whenever that env var is set. Pass the matching
  `bearerTokenEnv: "ACME_TOKEN"` to `createMcpSkill`.

## The MCP skill API

Exported by `mcp-client.js`:

- `createMcpSkill({ server, url, bearerTokenEnv }, ctx)` — build the object a
  skill returns. `ctx` is the skill context (`hostRequest`, `env` are used).
- `McpClient` — the underlying client; also reachable as `linear.client`.
- `NotEnabled` — thrown when no usable credentials exist (not logged in).
- `McpToolError` — thrown when a tool call returns a result flagged as an error.

Methods on the returned object:

- `await list_tools()` — the server's tools as
  `[{ name, description, inputSchema }]`. Discovered once and cached for the
  life of the REPL process.
- `await call_tool(name, args)` — explicit call by exact name; the escape hatch
  for names that aren't valid JavaScript identifiers.
- `await <tool>(args)` — any other property is proxied to the matching tool,
  after checking that the server actually exposes it.

## Enable-by-login lifecycle

This auth-gating applies to the **built-in** integrations (Linear, Notion):

1. The built-in skill ships installed but **disabled** — excluded from the prompt
   and not preloaded into the REPL — because no credentials exist. (The host adds
   a `-<server>/SKILL.md` override for every built-in you aren't logged into.)
2. The user logs in; credentials land in `auth.json` under `mcp:<server>`.
3. A resource reload (automatic after `/login`/`/mcp login`, or `/reload`) detects
   the credentials and enables the skill; the next REPL start binds it as a global.
4. Logout (or losing credentials) disables it again.

If you log in mid-turn, the reload is deferred — run `/reload` after the turn to
activate the integration.

**User-authored integrations are not auth-gated this way.** A skill you drop into
a skills directory is loaded like any other skill — visible to the model and
bound in the REPL immediately, regardless of `auth.json`. It simply fails at call
time with `NotEnabled` until credentials exist. So make the skill's `SKILL.md`
tell the model how to connect when a call throws `NotEnabled`, matching the auth
mode you configured:

- **OAuth** (`"oauth": true`): instruct the user to run `/mcp login <server>` (or
  `/login` → MCP Connections). `/mcp login` only works for OAuth servers.
- **Bearer token** (`bearerTokenEnvVar`): instruct the user to set that env var —
  do *not* point them at `/mcp login`, which has no provider for a bearer-only
  server and reports "Unknown MCP integration".

## Caveats

- **Discover before assuming.** Tool names and argument schemas come from the
  server and can change; call `list_tools()` rather than hardcoding.
- **Binding-name collisions.** The REPL binding is the skill name with hyphens
  converted to underscores. Two loaded skills that map to the same binding warn
  and only one wins, so don't name a custom integration after a built-in skill.
- **Overriding a built-in name.** Declaring an `mcpServers` entry whose key matches
  a built-in (e.g. `linear`) with a custom `url` points the integration at your
  URL. A previously stored official credential is *not* reused for the override, to
  avoid sending the official token to your endpoint. Authenticate such an override
  via `bearerTokenEnvVar` only — OAuth credentials are not honored for a
  catalog-name override. (Use a name that isn't a built-in to get OAuth.)
- **Session state doesn't survive.** Each call opens its own MCP session, and the
  REPL's state snapshot is JSON, so a live client isn't restored across a resume —
  tools are simply rediscovered on the next call.
- **Multi-session daemon.** OAuth provider registration is process-global; a
  user-declared server unique to one daemon session is re-registered on that
  session's next reload.

See also: [Skills](skills.md), [Settings](settings.md).
