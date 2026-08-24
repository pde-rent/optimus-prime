<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="Optimus Prime" src="assets/logo-light.svg" width="460">
  </picture>
</p>

<h1 align="center">Optimus Prime</h1>

<p align="center">
  A coding agent whose primary tool is a persistent Bun REPL.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &bull;
  <a href="#highlights">Highlights</a> &bull;
  <a href="#the-repl">REPL</a> &bull;
  <a href="#recursion-and-delegation">Delegation</a> &bull;
  <a href="#settings">Settings</a> &bull;
  <a href="#skills">Skills</a> &bull;
  <a href="#mcp">MCP</a> &bull;
  <a href="#supply-chain">Supply chain</a> &bull;
  <a href="#development">Development</a> &bull;
  <a href="#credits">Credits</a>
</p>

---

## Quick start

Prerequisites: [Bun](https://bun.sh) 1.4+ and `git`. The toolchain is Bun only —
`bun`, `bunx`, `bun run`, `bun install`; never npm/npx/node.

```sh
git clone https://github.com/pde-rent/optimus-prime.git
cd optimus-prime
bun install
bun run build          # typecheck + bundle
cd packages/coding-agent && bun link --global
```

`bun link --global` symlinks the global `optimus` at this checkout, so a rebuild updates the
command in place.

### Authenticate

Run `/login` inside the app, or export a key first:

```sh
export ANTHROPIC_API_KEY=...      # or OPENAI_API_KEY, OPENROUTER_API_KEY, OPENCODE_API_KEY, ...
```

Credentials live in `~/.optimus/agent/auth.json`; environment variables are read as a fallback.
`/models` picks the model, `/settings` everything else.

### Run

```sh
optimus                        # interactive
optimus "explain src/main.ts"  # one-shot
optimus -p "list the tools"    # print and exit
optimus --help                 # every flag
```

State lives in `~/.optimus/agent`. To update: `git pull && bun install && bun run build`, then
restart — the daemon keeps serving the previous bundle until its workers retire.

## Highlights

- **A persistent REPL as the primary tool.** Declarations, imports and helpers survive across
  turns and compaction. The whole Bun standard library is in scope with nothing to install:
  SQLite, Postgres/MySQL via tagged templates, Redis, S3, raw TCP/TLS, WebSocket, image decode,
  YAML/TOML, hashing, compression, `%%bash` cells.
- **Recursive delegation under a budget.** Spawn child agents that return at admission; depth,
  effort and context budget are runtime-adjustable dials. Reach is explicit and one-way per
  cohort. Idle kernels are snapshotted and reaped; finished children retire disk-only but stay
  resumable.
- **Native tools where a shell spawn adds nothing.** `grep`, `find`, `sed`, `wc`, `ln` run
  in-process and behave identically on Windows. Batched reads fetch up to 16 files in one call;
  re-reading an unchanged file costs one line instead of its tokens.
- **Diffs worth reading.** Expanded edits render syntax-highlighted diff blocks — side by side on
  wide terminals — and modal dialogs float over a dimmed transcript instead of blanking it.
- **Sessions you can move through.** `/rewind` returns to any earlier point of the session tree,
  `/effort` tunes reasoning mid-run, and `/js` / `/ts` / `/vars` drive the focused session's
  REPL kernel directly.
- **Live model discovery.** Fresh provider catalogs merge into the `/model` picker alongside the
  generated static list; built-in logins cover Anthropic, OpenAI, OpenRouter, Grok (SuperGrok),
  OpenCode Zen, Nous Portal, Z.ai, NVIDIA NIM, Qwen, GLM, Together AI and more.
- **MCP without the flattening.** Configured servers are reached from the REPL through one
  binding; their tools cost nothing until called. OAuth tokens are endpoint-bound, disk-verified
  on removal, and discovered per RFC 9728.
- **Honest failure surfaces.** Retries use capped exponential backoff with full jitter; provider
  errors are visible instead of swallowed; a degeneracy guard aborts output collapsed into
  repetition; a reasoning-loop guard steers, then stops, runs that plan without acting.
- **Charts and data frames.** Braille terminal charts and a pandas-shaped `df` API with
  NumPy-shaped vector math — both in-process, zero services.
- **Continual memory.** Skills, prompt notes, memories and subagent specs curated by the agent,
  retrieved through a local BM25F index — no embedding service, no network call.

## Numbers

| | |
|---|---|
| Runtime dependencies | **3**, each justified [below](#supply-chain) |
| Bundle | **~4.5 MB** |
| Default runtime | **Bun** |
| Type coverage | strict `tsgo --noEmit` over every package — CI fails on one `any`, one suppression |

## The REPL

One tool, `repl`. The Bun standard library is in scope with nothing to install:

| Need | Reach for |
|---|---|
| Local state, history, search | `Database` (`bun:sqlite`) |
| Postgres, MySQL, MariaDB | `SQL` / `sql` — tagged templates that parameterise |
| Cache, queues, shared state | `redis` / `RedisClient` |
| Object storage | `S3Client` |
| Raw protocols | `Bun.connect` / `Bun.listen`, `WebSocket` |
| Files, globs, processes | `Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.spawn`, `$` |
| Images | `Bun.Image` — decode, EXIF, resize, encode |
| Parsing, hashing, compression | `Bun.YAML`/`TOML`, `Bun.CryptoHasher`, `Bun.zstd*`, `HTMLRewriter` |
| Shell | ``%%bash`` cells |

Handles resolve lazily, so a cell that never opens a database pays nothing. REPL start is ~17 ms.

## Recursion and delegation

`await rlm('sub-task')` spawns a child and returns at admission, never the answer. Results
arrive as messages or files, so a parent is never blocked on a child.

| Capability | Surface |
|---|---|
| Spawn a child | `rlm('task')` or `spawn('task')` |
| Depth, adjustable at runtime | `rlm.get_max_depth` / `rlm.set_max_depth` |
| Reasoning effort per child | `rlm.get_effort` / `rlm.set_effort` |
| Context budget, session-scoped | `rlm.get_context_budget` / `rlm.set_context_budget` |
| Roster and teardown | `rlm.list_subagents` / `rlm.delete_subagent` |
| Talk to family | `agent_message.send(msg, { receiver_role })` — parent, child, sibling |
| Restrict who a child may reach | `rlm(task, { peers: [...] })` — one-way, `[]` for none |
| What each child has spent | `tokens_spent` on every `rlm.list_subagents` entry |
| Watch without mutating | `agent_observe.list_agents` / `get_agent` / `recent_messages` |
| Reusable roles | subagent specs in the harness, promoted by `refine` |

Reach is bounded to parent, siblings and children. Siblings talk directly, so a cohort can
reconcile without routing through the coordinator, and a repeated delegation role becomes a
saved subagent spec instead of prompt text retyped each session.

The agent also manages its own headroom. Compaction triggers by default at 500k tokens under a
666k context budget, itself hard-capped by whatever window the model actually has; both are
settings, and unless `dynamicContext` is switched off the agent can retune them mid-session —
session-scoped, never persisted, thrash-capped like every other self-adjustment it is allowed.

### Fan-out budget

By default one agent does the work. A task may fan out into a cohort when you raise the budget:

```sh
optimus --graph medium "audit every route handler for missing authz"
```

| Level | Ceiling | Cohort | Depth |
|---|---|---|---|
| `off` | — | — | unchanged |
| `low` | 3x | 2 | 1 |
| `medium` | 10x | 4 | 1 |
| `high` | 25x | 6 | 2 |
| `max` | 100x | 8 | 2 |
| `unlimited` | no ceiling | no cap | 2+ |

Escalation is evidence-led, never predicted: repeated check failures, changes that are hard to
undo, contradictory retrieval. Work that splits into independent units fans out one child per
unit and fans in through files; work that does not split gets another pass with more context
instead. Each cohort declares who may reach whom:

```js
await spawn('review the auth diff', { peers: ['worker-b'] });  // may message worker-b, nobody else
await spawn('audit the routes',     { peers: [] });            // reports only to the parent
```

Set it with `--graph`, `/graph`, `GRAPH_RESOLVER`, or the Graph row in `/settings`. At `off`
nothing renders into the prompt, so the default path pays nothing.

## Settings

Every session setting is reachable three ways — a flag for one run, a slash command mid-session,
and a row in `/settings` that persists — all generated from one table, so a flag cannot exist
that the runtime quietly ignores.

| Flag | Also | Sets |
|---|---|---|
| `--thinking`, `--effort <level>` | `/effort` | reasoning level |
| `--graph <level>` | `/graph` | multi-agent budget |
| `--graph-max-tokens <n>` | | lowers the graph ceiling |
| `--rlm-max-depth <n>` | `/rlm-max-depth` | recursion depth |
| `--dynamic-depth` / `--no-` | | let the agent raise its own depth |
| `--dynamic-effort <mode>` | | `off`, `banded`, `free` |
| `--service-tier <tier>` | | `auto`, `default`, `flex`, `scale`, `priority` |
| `--compact` / `--no-` | `/compact` | automatic context compaction |
| `--retry` / `--no-` | | retry on transient API failures |
| `--reasoning-loop-guard` / `--no-` | | steer or stop runs that plan without acting |
| `--degeneracy-guard` / `--no-` | | abort output collapsed into repetition |
| `--dynamic-context` | | let the agent retune its own context budget |

Settings without flags follow the same table: `toolTimeouts.replMs` /`toolTimeouts.bashSeconds`
(per-tool call timeouts), `replIdleTimeoutMinutes` (idle REPL kernels are snapshotted and
reaped), `idleEvictionMinutes` (daemon worker eviction), and `dynamicContext`.

Commands answer to the names other CLIs use for them: `/exit`, `/config`, `/cost`, `/connect`,
`/signin`, `/logout`, `/continue`, `/depth`, `/reasoning`. Opening a session plays a short
startup animation; `"ignition": false` turns it off.

## Skills

| Skill | What it does |
|---|---|
| `agent-message` | Send to parent, child or sibling |
| `agent-observe` | Read-only view of the family |
| `refine` | Promote what a session learned into skills, prompts, memory, subagent specs |
| `goal` | Persistent objective across turns |
| `compact` | Deliberate context cut |
| `edit` | Hash-anchored edits — a file that moved underneath is rejected, not corrupted |
| `check` | Verify through the project's own checker |
| `websearch` | Self-hosted [SearXNG](deploy/searxng/), Serper by flag |
| `attach-image` | Put an image in context |
| `skill-creator` | Write new skills |
| `chart` | Terminal charts — line, bar, candlestick, gauge, sparkline |
| `web3` | Chain RPC, wallet balances, DeFi TVL and volume — EVM, Solana, Tron |
| `stats` | Array statistics `Math` lacks — quantiles, stddev, correlation, describe |
| `df` | Data frames — a pandas-shaped API over columnar data plus NumPy-shaped vector math |

Memory retrieval is a local BM25F index: no embedding service, no network call.

## MCP

No MCP server ships enabled. The client is built in, so adding one is configuration rather than
installation:

```jsonc
// ~/.optimus/agent/settings.json      — every project
// <project>/.optimus/agent/settings.json — this project only
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "bearerTokenEnvVar": "GITHUB_MCP_TOKEN"
    }
  }
}
```

A project entry overrides a global one of the same name. Credentials are named, never inlined:
`bearerTokenEnvVar` reads a token from the environment, and `"oauth": true` uses the browser
login flow, storing the token with the harness's other credentials.

From inside a session, the REPL reaches every configured server through one binding:

```js
await mcp.servers();                              // what is configured, and what is authed
const tools = await mcp.tools("github");          // follows pagination
await mcp.call("github", "search_issues", { q: "is:open label:bug" });
```

Tools are **not** flattened into the model's tool list. A server exposing eighty tools costs
nothing until it is asked, which is also why server tool names cannot collide with the harness's
own. The client speaks both eras of the protocol — the stateless revision (`2026-07-28`) and the
handshake revisions (`2025-11-25` and earlier) — detected per endpoint and cached.

## Supply chain

Every dependency runs with your credentials, updates without you reading the diff, and loads
before the first prompt renders. So a dependency earns its place or gets written out.

| Dependency | Why |
|---|---|
| `@crafter/charts` | Terminal charts. Zero deps of its own |
| `@speed-highlight/core` | Highlighting rule data, zero deps |
| `proper-lockfile` | Cross-process file locking |

Everything else was written out instead, each differential-tested against what it replaced:
gitignore matching (1440/1440 identical), git URL parsing (20/20), globs (512/512), JSON Schema
and validation (12/12 byte-identical, 26/26 checks), Myers diff (exact, plus 400 randomised
reconstructions). Provider SDKs, ORMs and schema frameworks are gone.

Removing a dependency moves its work into `src` rather than deleting it. What shrank is the code
nobody here wrote and nobody here reviews.

## Development

```sh
bun run build          # typecheck and bundle
bun run check          # biome, tsgo, installer and browser smoke
bun run test           # every package
```

Per-package suites run from the package directory with the preload:

```sh
cd packages/coding-agent
bun test --preload ../../scripts/test-preload.ts --isolate test/bun-repl.test.ts
```

Type safety is total and enforced by CI: the whole repository typechecks with `tsgo --noEmit`
under strict settings, and a single `any`, double cast through `unknown`, or lint suppression
fails the build. See [CONTRIBUTING.md](CONTRIBUTING.md).


To test changes against a standalone instance instead of your live daemon, run `scripts/dev-instance.sh start` (see [packages/coding-agent/docs/development.md](packages/coding-agent/docs/development.md)).
## Credits

Optimus Prime is a hard fork of
[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) (RLM
architecture, refinement, skills, daemon), which builds on
[earendil-works/pi](https://github.com/earendil-works/pi) by Mario Zechner (agent loop, TUI,
provider layer, extension system). Both upstreams' copyright notices are kept in
[LICENSE](LICENSE) as MIT requires.

Further design influences, credited where a decision landed in the source: grok-build (TUI
action/effect loop, scrollback folding, compaction design), Claude Code (SKILL.md format,
tool-calling shape), oh-my-pi (hash-anchored editing, verification through the project's own
checker), Mem0 and Letta/MemGPT (memory curation patterns; lexical retrieval here stays local),
ponytail and pstack (verification-first working rules).

Research background: ReAct, Reflexion, Voyager, CodeAct, SWE-agent's agent-computer interface,
mini-swe-agent, Cognition's "Don't Build Multi-Agents" (why the fan-out budget defaults off),
OpenHands' stuck detector, and Erlang/OTP supervision trees.
