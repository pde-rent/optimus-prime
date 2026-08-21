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
  The most minimal harness we know of that still ships the full feature set — dynamic memory,
  context and effort management, recursive delegation, skills, MCP, charts, web search —
  because none of that requires bloat. Small is the discipline; features are the point.
</p>

<p align="center">
  <a href="#install">Install</a> &bull;
  <a href="packages/coding-agent/docs/index.md">Docs</a> &bull;
  <a href="#numbers">Numbers</a> &bull;
  <a href="#the-graph-resolver">Graph resolver</a> &bull;
  <a href="#settings">Settings</a> &bull;
  <a href="#what-changed">What changed</a> &bull;
  <a href="#supply-chain">Supply chain</a> &bull;
  <a href="#credits">Credits</a>
</p>

---

## Install

Prerequisites: [Bun](https://bun.sh) 1.4+ and `git`. No Node or npm in the toolchain or the
runtime — `bun`, `bunx`, `bun run`, `bun install`, never `npm`/`npx`/`node`.

```sh
git clone https://github.com/pde-rent/optimus-prime.git
cd optimus-prime
bun install
bun run build          # typecheck + bundle, ~1 min the first time
cd packages/coding-agent && bun link --global
```

`bun link --global` symlinks the global `optimus` at this checkout, so a rebuild here updates
the command in place — there is no second copy to keep in sync.

### Authenticate

Nothing works until a provider is configured. Either run `/login` inside the app, or export a
key before starting:

```sh
export ANTHROPIC_API_KEY=...      # or OPENAI_API_KEY, OPENROUTER_API_KEY, ...
```

`/login` stores credentials in `~/.optimus/agent/auth.json`; environment variables are read as a
fallback. `/models` picks the model, `/settings` everything else.

### Run

```sh
optimus                        # interactive
optimus "explain src/main.ts"  # one-shot
optimus -p "list the tools"    # print and exit
optimus --help                 # every flag
```

State lives in `~/.optimus/agent`. Nothing is inherited from an earlier install.

### Update

```sh
git pull && bun install && bun run build
```

Restart afterwards: the daemon caches the previous bundle and keeps serving it until its
workers are retired. There is no automatic update check yet.

`install.sh` at the repo root is a release installer for published tarballs. It is not wired up
for this fork, so build from source as above.

## Numbers

Measured on the same machine (M3, macOS); competitors on a 2026-08-19 clean clone, Optimus
re-measured 2026-08-21 after another round of removals. Install weight is a production install,
so it is what ships rather than dev tooling.

| | prime-agent | pi | **Optimus** |
|---|---|---|---|
| Runtime dependencies | 33 | 27 | **4** |
| Packages installed | 125 | 84 | **25** |
| `node_modules` | 197 MB | 140 MB | **4.8 MB** |
| Bundle | 13 MB | 11 MB | **4.5 MB** |
| Cold start, mean of 5 | 230 ms | 350 ms | **~60 ms** |
| Default runtime | Node | Node | **Bun** |

Startup includes the runtime difference; the dependency and size figures do not. Four runtime
dependencies, each with a written justification below. Everything else the harness needs ships
inside Bun itself.

## What changed

prime-agent introduced the RLM: an agent that programs in a persistent REPL and can call
itself. That REPL was a Python IPython kernel over ZeroMQ — an interpreter, a native module and a
socket hop bolted next to a runtime the TUI was already using. The fork exists in large part to
delete that: the REPL here is native Bun JS/TS, the same runtime that renders the editor, so
everything stays in one process, one language and one toolchain.

| | prime-agent | Optimus |
|---|---|---|
| REPL | Python IPython kernel over ZeroMQ | native Bun JS/TS |
| Telemetry | on by default, posted to a vendor endpoint | none — the code is deleted, not disabled |
| Provider access | 5 vendor SDKs | one fetch client, wire types vendored |
| Editor protocol | ACP mode | removed |
| Highlighting | highlight.js, ~350 ms import | rule data with a local tokenizer |
| Charts | none | braille terminal charts, a matplotlib-shaped API |
| Data work | ad hoc scripting in the kernel | `df` data frames with a pandas-shaped API and NumPy-shaped vector math |
| Continual memory | none | harness entries — skills, prompts, memories, subagent specs — curated by the agent, searched on demand |
| Subagent lifecycle | spawn and hope | idle kernels reaped with snapshot restore, adaptive passivation, disk-only retirement, a reasoning-loop guard |
| Delegation shape | assembled by the agent | resolved for it, under a budget dial |
| Cohort messaging | every sibling reachable | edges declared per child, one-way |
| Child token cost | folded into the parent's total | itemised per child, in the roster |
| Settings from the CLI | a few flags | every session setting, from one declarative table |

## The REPL

One tool, `repl`. Declarations, imports and helpers persist across turns and compaction. The
Bun standard library is in scope with nothing to install:

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
| Shell | `%%bash` cells |

Handles resolve lazily, so a cell that never opens a database pays nothing. REPL start is ~17 ms.

## Recursion and delegation

`await rlm('sub-task')` spawns a child and returns at admission, never the answer. Results
arrive as messages or files, so a parent is never blocked on a child.

| Capability | Surface |
|---|---|
| Spawn a child | `rlm('task')` |
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
reconcile without routing everything through the coordinator, and a repeated delegation role
becomes a saved subagent spec instead of prompt text retyped each session. The agents view
draws the live graph.

Children are managed, not just spawned. A REPL kernel is snapshotted and reaped after ten idle
minutes and transparently restored on the next cell, so finished subtrees stop costing memory.
In the daemon, passivation scales with the resident child population and finished children retire
disk-only after thirty idle minutes — their transcripts stay resumable. A reasoning-loop guard
watches every run, including every child: planning that never acts is steered toward a concrete
call once, then aborted with one clean continuation, then stopped.

The agent also manages its own headroom. Compaction triggers by default at 500k tokens under a
666k context budget, itself hard-capped by whatever window the model actually has; both are
settings. Unless `dynamicContext` is switched off, the agent can retune them mid-session —
tighter before a long mechanical run, wider before an open-ended one — session-scoped, never
persisted, and thrash-capped like every other self-adjustment it is allowed.

## The graph resolver

Every published comparison that holds spend constant puts one agent ahead of a cohort, and the
top SWE-bench systems are single loops with strong scaffolding. So the default here is one agent,
and this is **off unless you turn it on**.

What it changes when you do: a task may be resolved by several agents instead of one, and you set
how much that is allowed to cost.

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

One dial, not two: more budget means more tasks earn a cohort. `graphMaxTokens` only ever lowers
a level's ceiling, and a level needing depth 2 raises `rlmMaxDepth` with it, so a spawn cannot
throw against a depth the dial itself asked for. An explicit `/rlm-max-depth` pin still wins.

**Escalation is evidence-led, never predicted.** `check` failed twice on the same diagnostic; the
change is hard to undo; a shared symbol has more call sites than fit in one head; retrieval
returned contradictory sources. A model's self-rated chance of being wrong comes from the same
forward pass as the answer, and only half that error is observable — over-escalation shows up in
the bill, under-escalation looks like an ordinary wrong answer.

**Two shapes.** Work that splits into independent units fans out, one child per unit, fanning in
through files. Work that does not split gets another pass with more context instead — N children
on an indivisible problem return N restatements at N times the price — plus at most one checker
when the result cannot be verified mechanically. That checker sees the problem, never the
parent's answer.

**Each cohort declares its own edges.** The spawner says who may reach whom:

```js
await rlm('review the auth diff', { peers: ['worker-b'] });  // may message worker-b, nobody else
await rlm('audit the routes',     { peers: [] });            // reports only to the parent
```

Edges are one-way, so a reviewer returns a verdict without opening a debate. Omitting `peers`
leaves the family default alone; `peers: []` is explicit silence. The parent is always reachable.
The prompt teaches `[]` by default: delivery is `steer`, so a message interrupts the receiver
mid-turn and the first critique to land reframes whoever gets it — an anchoring cascade that
destroys the independence the cohort was for. Open an edge when a child needs another's output,
not so they can confer.

**Reconciling.** A pre-existing check written by someone other than the agent under review settles
it; a test written by the agent whose work it validates proves nothing. Otherwise disagreement is
the finding, surfaced with the differing lines rather than averaged away by a vote.

Set it with `--graph`, `/graph`, `GRAPH_RESOLVER`, or the Graph budget row in `/settings`. At
`off` the prompt block is not rendered at all, so the default path pays nothing for it.

Three limits, stated plainly: the ceiling is soft by one child (`rlm()` returns at admission, and
committed tokens cannot be refused retroactively); it is metered per agent per user turn, so the
worst case is the ceiling times the number of spawners; and the 1x baseline is a constant, not a
measurement, so the multiples are spend authority rather than a prediction.

## Settings

Every session setting is reachable three ways — a flag for one run, a slash command mid-session,
and a row in `/settings` that persists — and they are generated from one table, so a flag cannot
exist that the runtime quietly ignores.

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
reaped), `idleEvictionMinutes` (daemon worker eviction and child passivation), and
`dynamicContext` (the agent retuning its own headroom).

Commands answer to the names other CLIs use for them: `/exit`, `/config`, `/cost`, `/connect`,
`/signin`, `/logout`, `/continue`, `/depth`, `/reasoning`.

Opening a session blinks the mark's eyes and plays a short sting. It never gates input, and
`"ignition": false` (or `quietStartup`) turns it off. Playback uses whatever the platform already
has; no player, no sound, same startup time.

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
| `df` | Data frames — a pandas-shaped API over columnar data plus NumPy-shaped vector math, in-process |

Memory retrieval is a local BM25F index: no embedding service, no network call.

## MCP

No MCP server ships enabled. The client is built in, so adding one is configuration
rather than installation.

A server is a named entry under `mcpServers`, in either settings file:

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

A project entry overrides a global one of the same name. Credentials are named, never
inlined: `bearerTokenEnvVar` reads a token from the environment, and `"oauth": true`
uses the browser login flow instead, storing the token with the harness's other
credentials rather than in the settings file.

A server offering more tools than a project needs can be narrowed with `includeTools`
and `excludeTools`, named as the wider convention names them. Exclusion wins, so a
broad include list stays safe to narrow.

From inside a session, the REPL reaches every configured server through one binding:

```js
await mcp.servers();                              // what is configured, and what is authed
const tools = await mcp.tools("github");          // follows pagination
await mcp.call("github", "search_issues", { q: "is:open label:bug" });
```

Tools are **not** flattened into the model's tool list. A server exposing eighty tools
costs nothing until it is asked, which is also why a server's tool names cannot collide
with the harness's own or with another server's.

The client speaks both eras of the protocol — the stateless revision (`2026-07-28`) and
the handshake revisions (`2025-11-25` and earlier) — detected per endpoint and cached, over
Streamable HTTP. A `"type": "stdio"` entry is accepted and listed, but reports that the
transport is not reachable rather than going missing.

## Supply chain

Every dependency runs with your credentials and updates without you reading the diff, and it is
also startup cost — everything parsed before the first prompt renders. So a dependency earns its
place or gets written out. Twenty-five installed packages instead of a hundred and twenty-five
is an audit a person can actually perform.

| Dependency | Why |
|---|---|
| `@crafter/charts` | Terminal charts. Zero deps of its own; its `typescript` peer is no longer installed now that peer auto-install is off |
| `@speed-highlight/core` | Highlighting rule data, zero deps |
| `proper-lockfile` | Cross-process file locking |
| `extract-zip` | Bun's archive API is write-only |

Extensions load through a native Bun import path with virtual-module shims — the same TS
transpilation jiti provided, without the dependency.

Written out instead, each differential-tested against what it replaced: gitignore matching
(1440/1440 identical), git URL parsing (20/20), globs (512/512), JSON Schema and validation
(12/12 byte-identical, 26/26 checks), Myers diff (exact, plus 400 randomised reconstructions).
Provider SDKs, ORMs and schema frameworks are gone.

Removing a dependency moves its work into `src` rather than deleting it, so source lines did not
shrink. What shrank is the code nobody here wrote and nobody here reviews.

## Development

```sh
bun run build          # typecheck and bundle
bun run check          # biome, tsgo, installer and browser smoke
bun run test           # every package
```

Per-package suites run from the package directory with the Vitest-compat preload:

```sh
cd packages/coding-agent
bun test --preload ../../scripts/test-preload.ts --isolate test/bun-repl.test.ts
```

[CONTRIBUTING.md](CONTRIBUTING.md) · [docs/repl-parity.md](docs/repl-parity.md) for the
Bun-versus-kernel audit · [docs/upstream-sync.md](docs/upstream-sync.md) for tracking upstream.

## Credits

Everything below shaped this harness. The first two are upstream with code carried over (their
copyright notices are kept in [LICENSE](LICENSE) as MIT requires); the rest are influences — no
code taken, credited where a decision landed in the source.

| Project | Relationship | What it shaped |
|---|---|---|
| **[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)** | hard-fork parent | the RLM architecture, refinement and skills, the daemon and agents view |
| **[earendil-works/pi](https://github.com/earendil-works/pi)** (Mario Zechner) | upstream of the parent | the agent loop, TUI, provider layer and extension system |
| **[xai-org/grok-build](https://github.com/xai-org/grok-build)** | influence | TUI architecture (action/effect loop, scrollback folding), per-session storage layout, compaction design (prefire passes, tool-result pruning), the subagent task tool and coordinator |
| **[Claude Code](https://claude.com/claude-code)** | influence | tool-calling shape, SKILL.md skill definition format, overall loop conventions, session management UX |
| **[oh-my-pi](https://github.com/can1357/oh-my-pi)** | influence | hash-anchored editing, verification through the project's own checker, suppressing repeated agent messages (`edit.src`/`edit.patch`, `check`, `agent-messages.ts`) |
| **[Mem0](https://github.com/mem0ai/mem0)** | influence | extract-and-consolidate, retrieve-before-write, scoped recall; its per-query cost is why retrieval here stays lexical (`rlm.harness.search_memory`) |
| **[Letta / MemGPT](https://github.com/letta-ai/letta)** | influence | agent-managed memory tiers curated through tools (`rlm.harness` CRUD) |
| **[ponytail](https://github.com/DietrichGebert/ponytail)** | influence | reuse before adding code; what is never traded away; one runnable check for non-trivial logic (`CODE_CRAFT_PROMPT`) |
| **[pstack](https://github.com/cursor/plugins/tree/main/pstack)** | influence | verify against the real thing; blast-radius check before widening a shared change (`VERIFICATION_PROMPT`) |

Both prompt sections are always-on defaults, not plugins — nothing to install, nothing to drift
out of sync. A repository overrides them from its own `AGENTS.md` or `CLAUDE.md`.

### Research reading

Directional influences, listed honestly: not every conclusion is factored in yet. They set the
vocabulary for what the harness is trying at, and each will be reviewed and folded in or rejected
on evidence.

- ReAct (Yao et al., 2022) — interleaving reasoning and acting
- Reflexion (Shinn et al., 2023) — verbal self-review between attempts
- Voyager (Wang et al., 2023) — a growing library of reusable skills
- Executable Code Actions / CodeAct (Wang et al., 2024) — code as the action space; the RLM's foundation
- SWE-agent and the agent–computer interface (Yang et al., 2024) — tool interfaces decide outcomes
- mini-swe-agent — minimal scaffolding at competitive scores
- Don't Build Multi-Agents (Cognition, 2025) — the context-engineering case against fan-out; why the graph resolver defaults off
- The OpenHands stuck detector — semantic repetition detection for runaway runs
- Erlang/OTP supervision trees — restart intensity limits and escalation ladders for child tasks
