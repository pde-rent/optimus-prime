# Bench

Offline, Bun-only measurements behind the fork's "lighter / faster" claims.

```bash
bun run bench                              # report
bun run bench --json scripts/bench/baseline.json   # (re)record a baseline
bun run bench --check scripts/bench/baseline.json  # CI guardrail
bun run bench --runs 10 --concurrency 16
```

Run `bun run build` first — the bundle and CLI numbers read build output and
report `not built` / `0` without it. `bun run build:binary` (in
`packages/coding-agent`) additionally fills in the compiled-binary size.

## What is measured

| Metric | Source |
|---|---|
| bundle / dist / binary size | `packages/coding-agent/dist/**` |
| node_modules size | repo root `node_modules` |
| runtime dep count | `dependencies` + `optionalDependencies` per package (devDeps excluded — they never ship) |
| source LOC | non-blank, non-comment lines under each `packages/*/src` plus the bundled skills |
| REPL start / first cell | `BunReplManager.start()` and the first `execute()` |
| REPL idle RSS | `ps` on the REPL child after one cell |
| REPL fan-out | wall time to start N REPLs concurrently |
| CLI `--version` | `bun dist/bundle/cli.js --version`, process spawn + module graph only |

## What is NOT measured yet

- **Time to first prompt.** `--version` is a floor: it skips session, settings,
  provider, and TUI setup. A real cold-start number needs a scripted run against
  a mock provider (boot -> ready -> one turn -> `/compact` -> `/resume`).
- **A/B against stock optimus or Claude Code.** The numbers here are
  self-relative; comparing requires checking out the other tree on the same box.
- **Feature-parity matrix.** Parity is asserted by the test suite, not by this
  bench.

Timings are machine- and load-dependent. The `--check` budget gives timings a
wide band on purpose; size and dependency counts are the hard gates.
