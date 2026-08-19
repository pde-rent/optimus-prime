<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="Optimus Prime" src="assets/logo-light.svg" width="460">
  </picture>
</p>

<p align="center">
  A coding agent whose primary tool is a persistent Bun REPL.
</p>

<p align="center">
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

Requires [Bun](https://bun.sh) 1.4+. No Node, npm, or Python in the toolchain or the runtime.

```sh
git clone https://github.com/pde-rent/optimus-prime.git
cd optimus-prime && bun install && bun run build
cd packages/coding-agent && bun link --global
```

Gives you `optimus` and `optimus-prime`:

```sh
optimus                        # interactive
optimus "explain src/main.ts"  # one-shot
optimus -p "list the tools"    # print and exit
```

State lives in `~/.optimus/agent`. Nothing is inherited from an earlier install.

## Numbers

Same machine (M3, macOS), 2026-08-19, clean clone of each. Install weight is a production
install, so it is what ships rather than dev tooling.

| | prime-agent | pi | **Optimus** |
|---|---|---|---|
| Direct dependencies | 33 | 27 | **6** |
| Packages installed | 125 | 84 | **19** |
| `node_modules` | 197 MB | 140 MB | **34 MB** |
| Lockfile entries | 443 | 395 | **93** |
| Bundle | 13 MB | 11 MB | **6.7 MB** |
| Cold start, mean of 5 | 230 ms | 350 ms | **74 ms** |
| Default runtime | Node | Node | **Bun** |

Startup includes the runtime difference; the dependency and size figures do not.

## What changed

prime-agent introduced the RLM: an agent that programs in a persistent REPL and can call
itself. That REPL was a Python IPython kernel over ZeroMQ. This fork replaced it with a native
Bun REPL, which takes an interpreter, a native module and a socket hop out of every tool call.

| | prime-agent | Optimus |
|---|---|---|
| REPL | Python IPython kernel over ZeroMQ | native Bun JS/TS |
| Python in repo | 968 lines | none |
| Snapshots | JSON — `Map`/`Set`/`Date` returned as `{}` | structured clone; functions restored from source |
| Live handles | captured, restored hollow | never captured, reported by name |
| Provider access | 5 vendor SDKs | one fetch client, wire types vendored |
| Editor protocol | ACP mode | removed |
| Telemetry | on by default, posted to a vendor endpoint | none — the code is deleted, not disabled |
| Session upload | `/traces` uploaded whole transcripts | removed |
| Highlighting | highlight.js, ~350 ms import | rule data with a local tokenizer |
| Charts | none | braille terminal charts |
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

One dial, not two. A strategy enum plus a spend multiplier contradict each other — "aggressive at
2x" means nothing — and the intent moves both together: more budget means more tasks earn a
cohort. `graphMaxTokens` is a clamp that only ever lowers a level's ceiling.

**Depth is reconciled, not left to collide.** A cohort's children sit one level below whoever
spawned them, so a level whose shapes need depth 2 raises `rlmMaxDepth` to 2 for as long as that
level is set. Without this the dial would appear to work and every worker spawn would throw
against the default depth of 1. It is resolved once, with the depth setting itself, rather than
raised and restored around each graph: raising depth mid-run rebuilds the system prompt and voids
that agent's prompt cache, and a child captures its depth budget when it is spawned, so a restore
could not reach children already running. An explicit `/rlm-max-depth` pin still wins — the graph
then simply cannot use its deeper shapes.

**Escalation is triggered by evidence, never by a prediction.** `check` failed twice on the same
diagnostic; the change touches something hard to undo; a shared symbol has more call sites than
fit in one head; retrieval returned contradictory sources. Asking a model to rate its own chance
of missing something yields a number from the same forward pass that would have produced the
answer. Worse, only half that error is observable — escalating trivia shows up in the bill, while
failing to escalate looks exactly like an ordinary wrong answer, so tuning against the visible
half alone drifts toward under-escalating, the failure the dial exists to prevent.

**Two shapes.** Work that splits into units sharing no state fans out, one child per unit, fanning
in through files. Work that does not split does **not** fan out — fan-out divides work, and an
indivisible problem has none to divide, so N children return N restatements of one line of
reasoning at N times the price. That case gets another pass with more context, plus at most one
child when the result cannot be checked mechanically and is hard to undo. That child is given the
problem statement alone, never the parent's answer, because a child shown an answer agrees with
it.

**Each cohort declares its own edges.** Communication is a property of the graph, not a global
switch, so the spawner says who may reach whom:

```js
await rlm('review the auth diff', { peers: ['worker-b'] });  // may message worker-b, nobody else
await rlm('audit the routes',     { peers: [] });            // reports only to the parent
```

Edges are one-way. Listing B in A's peers does not let B reach A, so a reviewer can return a
verdict without opening a debate. Omitting `peers` leaves the family default alone; `peers: []` is
an explicit silence. The parent is always reachable.

The default the prompt teaches is `[]`, because of how the message layer behaves. Delivery is
`steer`, so a message interrupts the receiver mid-turn: the first critique to land reframes
whoever gets it, which is a serial anchoring cascade, and it destroys the independence that was
the only reason to run more than one child. The rate limiter (3/s per pair) and the 20-message
pending cap make a wide mesh throw rather than merely slow, and the duplicate filter drops an
exact repeat while returning a success receipt, so agreement in a later round would vanish from
the transcript and from any tally. Open an edge when a child needs another's output, not so they
can confer — otherwise let the parent relay it as the input of a second spawn.

**Reconciling.** A check that already existed, written by someone other than whoever is being
checked, settles it; a test written by the same agent whose work it validates proves nothing.
Otherwise disagreement is the finding, surfaced with the differing lines rather than averaged away
by a vote — three diffs against one file do not fall into buckets to count.

Set it with `--graph`, `/graph`, `GRAPH_RESOLVER`, or the Graph budget row in `/settings`. At
`off` the prompt block is not rendered at all, so the default path pays nothing for it and the
cached prefix is untouched.

Three honest limits. The ceiling is soft by one child, because `rlm()` returns at admission and
tokens already committed cannot be recovered by refusing later. It is metered per agent and per
user turn, so a worker that splits again draws on its own ceiling rather than its parent's, and the
reachable worst case is the ceiling times the number of spawners. And the 1x baseline is a fixed
constant rather than a measurement — the single-agent run it compares against never happens — so
the multiples are spend authority, not a prediction.

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

Commands answer to the names other CLIs use for them: `/exit`, `/config`, `/cost`, `/connect`,
`/signin`, `/logout`, `/continue`, `/depth`, `/reasoning`.

Opening a new session lights the brand mark under a red scan and plays a five-second sting. It
never gates input — the prompt is live from the first frame and the first keystroke ends it — and
`"ignition": false` in settings, or `quietStartup`, turns it off.

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

The client speaks both eras of the protocol: the stateless revision (`2026-07-28`) and
the handshake revisions (`2025-11-25` and earlier), detected per endpoint and cached.
That matters more than it sounds — roughly seven in eight client connections were still
handshake-era three weeks after the stateless revision shipped. Transport is Streamable
HTTP. A `"type": "stdio"` entry is accepted and listed, but reports that the transport
is not reachable rather than going missing.

## Supply chain

Every dependency is code that runs with your credentials, in your repositories, and updates
without you reading the diff. In 2026 that is the realistic attack surface for a developer tool
— not the model, the install graph. It is also the startup cost: everything that has to be
found, parsed and evaluated before the first prompt renders.

So a dependency earns its place or gets written out. Nineteen packages instead of a hundred and
twenty-five is an audit a person can actually perform.

| Kept | Why |
|---|---|
| `@crafter/charts` | Terminal charts. Zero deps of its own, but a `typescript` peer that package managers install — 23 MB of the 34 MB |
| `@speed-highlight/core` | Highlighting rule data, zero deps |
| `jiti` | Extension loading; `Bun.plugin` does not intercept bare specifiers at runtime |
| `proper-lockfile` | Cross-process file locking |
| `extract-zip` | Bun's archive API is write-only |
| `@mariozechner/clipboard` | Optional, native clipboard with images |

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

Two upstreams, both copyright notices kept in [LICENSE](LICENSE) as MIT requires:

- **[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)** — the
  direct parent: the RLM architecture, refinement and skills, the daemon and agents view.
- **[earendil-works/pi](https://github.com/earendil-works/pi)** (Mario Zechner) — what
  prime-agent was built from: the agent loop, TUI, provider layer and extension system.

An independent hard fork. Neither project endorses it, and bugs here are ours.

### Influences

No code taken. These shaped decisions, and are credited in the source where they landed:

| Project | What it shaped | Where |
|---|---|---|
| **[ponytail](https://github.com/DietrichGebert/ponytail)** | Reuse before adding code; what is never traded away (validation at trust boundaries, error handling, security); one runnable check for non-trivial logic | `CODE_CRAFT_PROMPT` |
| **[pstack](https://github.com/cursor/plugins/tree/main/pstack)** | Verify against the real thing — a green build and the agent's own summary are not evidence. Blast-radius check before widening a shared change | `VERIFICATION_PROMPT` |
| **[oh-my-pi](https://github.com/can1357/oh-my-pi)** | Hash-anchored editing, verification through the project's own checker, and suppressing repeated agent messages | `edit.src`/`edit.patch`, `check`, `agent-messages.ts` |
| **[Mem0](https://github.com/mem0ai/mem0)** | Extract-and-consolidate, retrieve-before-write, scoped recall. Its per-query cost is why retrieval here stays lexical | `rlm.harness.search_memory` |
| **[Letta / MemGPT](https://github.com/letta-ai/letta)** | Agent-managed memory tiers curated through tools | `rlm.harness` CRUD |

Both prompt sections are always-on defaults, not plugins — nothing to install, nothing to drift
out of sync. A repository overrides them from its own `AGENTS.md` or `CLAUDE.md`.
