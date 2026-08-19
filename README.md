<h3 align="center">Optimus Prime</h3>

<p align="center">
  A self-improving RLM coding agent that runs on Bun, with a persistent JavaScript/TypeScript REPL as its primary tool.
</p>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="#what-is-different-here">What is different</a> &bull;
  <a href="#measured-against-both-parents">Measurements</a> &bull;
  <a href="#credits">Credits</a>
</p>

---

## Install

Requires [Bun](https://bun.sh) 1.4 or newer. There is no Node, npm, or Python anywhere in the
toolchain or the runtime.

```sh
git clone https://github.com/pde-rent/optimus-prime.git
cd optimus-prime
bun install
bun run build
cd packages/coding-agent && bun link --global
```

That puts three equivalent commands on your PATH — `optimus`, `optimus-prime`, and `pi` (kept so
existing muscle memory and scripts keep working):

```sh
optimus                       # interactive session in the current directory
optimus "explain src/main.ts" # one-shot with a message
optimus -p "list the tools"   # print a response and exit
```

Configuration, sessions, auth and installed packages live in `~/.optimus/agent`. An install that
predates the rename is moved from `~/.prime/agent` on first run; if that move fails you are told
rather than started with an empty profile.

## What is different here

This is a hard fork of [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent), which is
itself built on [pi](https://github.com/earendil-works/pi). Both are credited below. The fork
exists to push two things much harder than either parent: **dependency surface** and **Bun-native
execution**.

### The REPL is the tool

The agent's single built-in tool is `repl` — a persistent JavaScript/TypeScript sandbox whose
variables, functions and imports survive between turns and across compaction. Upstream ran a
Python IPython kernel over ZeroMQ for this; that is gone, along with its 968 lines of Python and
the `zeromq` native module.

The whole Bun standard library is in scope from a cell: `Bun.file`, `Bun.write`, `Bun.Glob`,
`Bun.spawn`, `Bun.$`, `Bun.Transpiler`, `Bun.CryptoHasher`, `Bun.YAML`/`TOML`, `Bun.Image`,
`Bun.stringWidth`, `Bun.semver`, `Bun.zstd*`/`gzip*`, `fetch`, `HTMLRewriter`, and `%%bash` cells
for anything shell-shaped.

### Session state that actually survives

REPL snapshots use structured clone rather than JSON, so `Map`, `Set`, `Date`, `RegExp`, `BigInt`,
typed arrays and circular references come back intact instead of as `{}`. Functions are carried as
source and re-evaluated, so helpers defined once are still callable next turn. Live handles — a
`Bun.serve` server, a timer — are never captured, and the model is told by name what it lost
rather than finding a hollow object later.

### Recursive language model

`await rlm('sub-task')` spawns a child agent that returns at admission rather than completion,
with results arriving as messages or files. Recursion depth is adjustable at runtime rather than
fixed (`core/rlm-max-depth.ts`), and refinement can promote what a session learned into reusable
skills, prompts and memory (`/refine`). Memory retrieval is a local BM25F index over weighted
fields (`core/refinement/memory-search.ts`) — no embedding service, no network call.

### Skills

Twelve skills ship in the REPL by default: `chart`, `edit`, `websearch`, `agent-message`,
`agent-observe`, `attach-image`, `compact`, `goal`, `refine`, `skill-creator`, `linear`, `notion`.

`chart` renders line, scatter, bar, column, candlestick, sparkline and histogram output straight to
the terminal using braille (2×4 dots per character cell) and eighth-block elements. It is written
here, not installed — the drawing is the small part of any library that does this.

`websearch` defaults to a self-hosted [SearXNG](deploy/searxng/) instance (free, keyless, no
third party sees your queries) and falls back to Serper by flag or environment variable. It emits
the same JSON shape either way.

### No telemetry

Upstream defaulted analytics **on**, posting run timings, token counts, tool and turn counts,
model categories and a persistent installation id to `api.primeintellect.ai`; `/traces` uploaded
whole session transcripts to the same host. Both subsystems are deleted outright, not merely
switched off. No code path in this fork phones home.

## Measured against both parents

Measured on the same machine (M3, macOS) on 2026-08-19, from a clean clone of each project at
that date. Install weight is a production install (`--omit=dev` / `--production`), so it reflects
what actually ships rather than developer tooling.

| | prime-agent | pi | **Optimus Prime** |
|---|---|---|---|
| Direct runtime dependencies | 33 | 27 | **5** |
| Packages in a production install | 125 | 84 | **18** |
| Production `node_modules` | 197 MB | 140 MB | **11 MB** |
| Entries in the lockfile | 443 | 395 | **93** |
| Shipped bundle | 13 MB | 11 MB | **6.7 MB** |
| `--version` cold start, mean of 5 | 230 ms | 350 ms | **74 ms** |
| `--version` cold start, best of 5 | 130 ms | 270 ms | **60 ms** |
| Python in the repo | 968 lines | none | **none** |

Two honest caveats, because the numbers are only useful if you can trust them:

**Startup is not a like-for-like runtime comparison.** Optimus runs on Bun; both parents run on
Node. Some of that 3–5× is Bun rather than this codebase. The dependency and install-size figures
have no such caveat.

**Source lines did not shrink.** Optimus is ~149k lines of source against prime-agent's ~148k and
pi's ~121k. Removing a dependency does not delete its work — it moves that work into `src`, where
it is auditable, tree-shaken and typed against the rest of the codebase. Anyone claiming both
"fewer dependencies" and "less code" is usually counting one of them wrong. What shrank is the
code you did not write and cannot see: **93 lockfile entries instead of 443**.

### The five remaining dependencies

| Package | Why it stays |
|---|---|
| `@speed-highlight/core` | Syntax highlighting rule data, zero dependencies of its own. Its matcher is re-implemented here synchronously so highlighting runs inside the render pass and uses the active theme |
| `jiti` | Module loading for extensions. Bun handles TS and cache-busting natively, but `Bun.plugin` does not intercept bare specifiers for runtime dynamic imports, which extensions need to resolve workspace packages and bundled virtual modules |
| `proper-lockfile` | Cross-process file locking |
| `extract-zip` | Zip extraction; Bun's archive API is write-only |
| `@mariozechner/clipboard` | Optional, native clipboard including images |

Everything else was replaced with Bun builtins or local code, each differential-tested against the
package it replaced before removal: gitignore matching (1440/1440 identical), git URL parsing
(20/20), glob matching (512/512), JSON Schema emission and validation (12/12 byte-identical
schemas, 26/26 identical checks), Myers line diff (exact, plus 400 randomised reconstructions).

## Why this matters

**Performance.** Startup cost is dominated by how much code has to be found, parsed and evaluated
before the first prompt renders. Eighteen packages parse faster than a hundred and twenty-five.
Replacing `cli-highlight` alone removed a ~350 ms import of the whole of highlight.js.

**Supply-chain control.** Every one of the 443 packages a `prime-agent` install pulls in is code
that runs with your credentials, in your repositories, on your machine, and that updates without
you reading the diff. In 2026 that is the realistic attack surface for a developer tool — not the
model, the install graph. Ninety-three entries is not zero, but it is an audit a person can
actually perform. The five direct dependencies above each earn their place with a reason, and
provider SDKs — `openai`, `@anthropic-ai/sdk`, `@mistralai/mistralai`, `@aws-sdk/*`, `@google/genai`
— are all gone: one fetch client speaks every provider, with the wire types vendored.

## Development

```sh
bun run build          # typecheck + bundle every package
bun run check          # biome, tsgo, installer and browser smoke checks
bun run test           # every package's suite
bunx tsgo --noEmit     # types only
```

Per-package suites run from the package directory, and need the Vitest-compat preload:

```sh
cd packages/coding-agent
bun test --preload ../../scripts/test-preload.ts --isolate test/bun-repl.test.ts
```

## Credits

This project stands on two upstreams and keeps both copyright notices in
[LICENSE](LICENSE) as MIT requires:

- **[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)** — the
  direct parent. The RLM architecture, the refinement and skills system, the daemon and agents
  view, and most of the harness this fork rewrites.
- **[earendil-works/pi](https://github.com/earendil-works/pi)** (Mario Zechner) — the foundation
  prime-agent itself was built from: the agent loop, the TUI, the provider layer and the
  extension system.

Optimus Prime is an independent hard fork. Neither project endorses it, and bugs here are ours.
