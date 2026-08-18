> Prime Agent can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that Prime Agent loads on demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Prime Agent implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient. It also supports JS-backed skills: a superset of markdown skills that ship a `skill.js` module preloaded into the persistent JavaScript REPL.

## Table of Contents

- [Locations](#locations)
- [Built-in Skills](#built-in-skills)
- [How Skills Work](#how-skills-work)
- [JS-Backed Skills](#js-backed-skills)
- [Creating Skills with Prime Agent](#creating-skills-with-prime-agent)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Prime Agent loads skills from:

- Global:
  - `~/.prime/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.prime/agent/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)
- Built-in: `skills/` shipped with the prime-agent package (lowest precedence)

Discovery rules:
- In `~/.prime/agent/skills/` and `.prime/agent/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

## Built-in Skills

Prime Agent ships with built-in skills that load by default:

- `agent-message` - JS-backed. Message an agent's parent, siblings, or direct children through the daemon (`await agent_message.send(...)`).
- `agent-observe` - JS-backed. Read-only observation of the agent's family: status and bounded recent-message previews.
- `attach-image` - JS-backed. Load an on-disk image into the model's context as a viewable attachment (`await attach_image.run("diagram.png")`).
- `compact` - JS-backed. Check context usage and schedule compaction from the REPL.
- `edit` - JS-backed. Replace one exact, unique string in a file: `await edit(path, oldStr, newStr)`.
- `goal` - JS-backed. Read, create, and complete the persistent thread goal.
- `linear` - JS-backed [MCP integration](mcp-integrations.md). Ships disabled until you log in.
- `notion` - JS-backed [MCP integration](mcp-integrations.md). Ships disabled until you log in.
- `prime-intellect` - markdown. Prime Intellect products and workflows via the prime CLI: verifiers environments and the Environments Hub, evaluations (local and hosted), Hosted Training and prime-rl, sandboxes, tunnels, Prime Inference, GPU compute, and storage. Reference docs for each area load on demand from the skill's `references/` directory.
- `refine` - JS-backed. Trigger continual harness refinement from the REPL.
- `skill-creator` - markdown. Teaches the agent to create new skills: markdown skill layout, frontmatter rules, placement and precedence, and the full JS-backed skill contract (`skill.js` detection, the factory signature, the skill context, verification) with a working template in `references/js-skills.md`.
- `websearch` - JS-backed web search and page reader. Backed by a self-hosted [SearXNG](https://docs.searxng.org) instance (free, keyless) or the [Serper](https://serper.dev) API.

Built-in skills behave like any other skill but have the lowest precedence: a user, project, package, or `--skill` skill with the same name overrides the built-in one.

### websearch

Search the web and read pages. Two backends; pick either.

**Option 1: self-hosted SearXNG (recommended - free, keyless, private)**

```bash
docker run -d -p 8888:8080 searxng/searxng
export SEARXNG_URL=http://localhost:8888
```

The JSON API is **off by default**, and the bot limiter blocks programmatic
clients, so set both in the instance's `settings.yml` and restart it:

```yaml
search:
  formats: [html, json]
server:
  limiter: false
```

**Option 2: Serper (hosted Google API)**

Get a free API key at [serper.dev](https://serper.dev), then run `/login`,
switch to **MCP Connections** using the displayed tab shortcuts, and choose
**Serper (web search)** to paste it. The key is stored alongside your other
credentials (in `auth.json`) and read by the skill on each call — no environment
variables required, and it works even if you add the key mid-session.
A `SERPER_API_KEY` in the environment, if set, takes precedence over the stored key.

**Why public SearXNG instances are not used**

Deliberately unsupported. A probe of the healthiest, fastest public instances
listed on [searx.space](https://searx.space) found effectively none that answer a
programmatic JSON query — they return `429`, `403`, or `418` on the first request
from a clean IP, because operators disable the JSON API and run a bot limiter.
Rotating between instances to work around that would be circumventing anti-abuse
controls on volunteer-run servers, so Prime Agent does not ship it. Self-host
instead: it is one command, faster, and rate-limit free.

**Backend selection**, in order: `options.backend` (or
`PRIME_AGENT_WEBSEARCH_BACKEND`) → `SEARXNG_URL` → a Serper key → a message
explaining both options. There is never a silent fallback. When neither backend
is configured, Prime Agent also shows a startup notice recommending SearXNG.

**Token cost.** Output is bounded because it goes straight into the agent's
context: results are deduplicated by URL and by domain (max 2 per site), HTML is
stripped, tracking params are dropped, and a hard character budget applies —
truncation is stated explicitly in the output.

| Call | Chars | ≈ Tokens |
|---|---|---|
| `run(q)` (defaults `count: 6`, `maxChars: 2400`) | 1300-1600 typical, 2400 cap | ~350-400 typical, ~600 max |
| `run(q, { count: 3, maxChars: 800 })` | ≤800 | ~200 |
| `read(url)` (default `maxChars: 4000`) | ≤4000 | ~1000 |

Once loaded, the model can call it directly in the REPL by binding name:

```js
console.log(await websearch.run("latest Prime Agent release"));
console.log(await websearch.run("bun test runner docs", { count: 3, maxChars: 800 }));
console.log(await websearch.run("rust async runtimes", { backend: "serper" }));
console.log(await websearch.read("https://docs.searxng.org/", { maxChars: 2000 }));
```

Until a backend is configured, web search returns a clear message describing both
setup paths rather than failing silently.

Disable only the built-in `websearch` skill in settings:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

To disable all built-in skills, set `enableBuiltinSkills` to `false` in `settings.json` (or toggle "Built-in skills" in `/settings`):

```json
{
  "enableBuiltinSkills": false
}
```

`--no-skills` also excludes built-in skills. To disable a single built-in skill without a dedicated setting, force-exclude it in the global `skills` array (patterns resolve against the built-in skills directory):

```json
{
  "skills": ["-prime-intellect/SKILL.md"]
}
```

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.prime/agent/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Prime Agent scans skill locations and extracts names, descriptions, type, and file locations
2. The system prompt includes visible skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses the `ipython` tool — the name is kept for compatibility, but it runs a persistent Bun JavaScript/TypeScript REPL — to load the full `SKILL.md` (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

Skills with `disable-model-invocation: true` are hidden from the startup skill list. They can still be invoked explicitly with `/skill:name`.

## JS-Backed Skills

A JS-backed skill uses the same `SKILL.md` metadata and invocation behavior as a markdown skill, but also ships an ESM module that Prime Agent preloads into the persistent JavaScript REPL and binds to a global. The full authoring contract lives in `skills/skill-creator/references/js-skills.md`.

```
web-search/
├── SKILL.md
└── skill.js
```

Detection rules:
- `SKILL.md` is still required
- a `skill.js` at the skill root marks the skill as JS-backed (`skill.mjs` and `skill.ts` are also accepted, in that order of preference)
- the binding name is the skill name with hyphens converted to underscores, and must be a valid JavaScript identifier (otherwise the skill loads as markdown-only, with a warning)

For `web-search`, Prime Agent exposes `web_search` in the REPL. The module is an ESM file exporting a factory:

```js
export default function createSkill(ctx) {
	return {
		/**
		 * Search the web and return a concise summary.
		 * @param {string} query Search query.
		 * @param {number} [limit] Maximum results to include.
		 * @returns {Promise<string>}
		 */
		async run(query, limit = 5) {
			return `searched ${query} (${limit} results)`;
		},
	};
}
```

```js
await web_search.run("prime agent skills");
Object.keys(web_search);
```

A named `export function createSkill(ctx)` takes precedence over the default export; the factory may be async. Whatever it returns is bound to the global: return an object of methods, or return a function (optionally with methods attached) to make the binding itself callable — that is how the built-in `edit` skill supports `await edit(path, oldStr, newStr)`. A module with no factory is bound as its own namespace. A skill that throws while loading is skipped with a warning on stderr; it never blocks the REPL from booting.

The factory receives one context argument:

| Field | Type | Purpose |
|---|---|---|
| `hostRequest(type, payload)` | `(string, object) => Promise<any>` | Call a host handler (`goal.get`, `compact.run`, `agent_message.send`, `mcp.config`, …) to reach session state owned by the host. |
| `display(payload)` | `({ mimeType, data }) => void` | Emit a display payload to the TUI. Image MIME types become context attachments; `application/vnd.prime-agent.diff+json` renders an inline diff. |
| `cwd` | `string` | The REPL's working directory. |
| `env` | `object` | The REPL child's environment. |

Write real JSDoc on every returned method: it is the skill's API documentation, and the agent reads it alongside `SKILL.md`.

Dependencies: prefer the Bun and web standard library (`Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.spawn`, `fetch`, `crypto`, `Buffer`, `TextEncoder`); Node builtins are available via `node:*` imports. Don't add npm dependencies for a bundled skill, and keep relative imports inside the skill directory — the module is loaded by absolute path.

There is **no install step**: the host hands the REPL child the list of skills to preload, and editing `skill.js` takes effect on the next REPL start. There is no venv, no `uv`/`pip`, and no build.

### No CLI Entry Points

Skills no longer ship CLI entry points. The Python-era `<skill> --help` shell command (console scripts declared in `pyproject.toml`) is **gone with no replacement** — a JS skill is reachable only as its REPL binding. If you want a skill usable from a shell, have the skill's `SKILL.md` document a script the agent runs with `bun`, and keep the callable API in `skill.js`.

### Verifying a JS Skill

Load the module standalone, outside the REPL, before relying on it in a session:

```bash
bun -e 'const f = (await import("./skill.js")).default; const api = await f({ hostRequest: async () => ({}), display() {}, cwd: process.cwd(), env: process.env }); console.log(await api.run("prime agent skills"));'
```

Then, in a fresh Prime Agent session, confirm the binding exists (`Object.keys(web_search)`) and that a real call works.

## Creating Skills with Prime Agent

Prime Agent ships with a built-in `skill-creator` skill that teaches the agent both the Agent Skills format and the JS-backed `skill.js` contract. You can ask for a skill in normal language:

```text
Create a project JS-backed skill named release-audit in
.prime/agent/skills/release-audit. It should expose
await release_audit.run(repository, targetVersion), include concise SKILL.md
instructions, use only Bun and web standard-library APIs, and verify the
callable in a fresh Prime Agent session.
```

To force the creation workflow explicitly, invoke the built-in skill command:

```text
/skill:skill-creator Create a personal markdown skill for reviewing database migrations.
```

Tell the agent three things:

1. **Scope:** use `.prime/agent/skills/<name>/` for a project skill committed with the repository, or `~/.prime/agent/skills/<name>/` for a personal skill.
2. **Kind:** ask for a markdown skill when the capability is primarily instructions; ask for a JS-backed skill when the agent should call reusable functionality from the REPL.
3. **Contract:** describe the intended JavaScript call, inputs, output, dependencies, credentials, and verification behavior.

The agent should create `SKILL.md` in both cases. For a JS-backed skill it should also create `skill.js` exporting a `createSkill(ctx)` factory, expose a documented (JSDoc'd) callable, and verify the module loads — standalone with `bun -e`, then as a REPL binding.

Use `/reload` to rediscover new or edited skill metadata. Start a fresh Prime Agent session after adding or editing a `skill.js` so the REPL preloads the new module.

### Installed Skills and Continual Harness Skills

An installed JS-backed skill is a real module on disk that adds executable functionality to the REPL. A continual harness skill entry is a persisted description of a reusable call, including its reference and argument contract. `/refine` (and the `refine` skill) can create or update the latter after a repeated procedure emerges, but it does not replace writing new functionality with `skill-creator`.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && bun install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Prime Agent validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && bun install
```

## Search

```bash
bun search.js "query"              # Basic search
bun search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
bun content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
