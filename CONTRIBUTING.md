# Contributing

Optimus Prime runs on your machine and executes code with your permissions, so changes are
reviewed with that in mind.

## Before a pull request

Open an [issue](https://github.com/pde-rent/optimus-prime/issues) first for anything beyond a
small fix, so the approach can be agreed before the work. Include what you are trying to do,
what you tried, and how to reproduce a bug. Never paste API keys, tokens or private prompts.

Security vulnerabilities go through [SECURITY.md](SECURITY.md), not a public issue.

## The bar

1. One focused change. No drive-by refactors or dependency bumps.
2. A new dependency needs a reason that survives the question "why not write it?" — see the
   supply-chain section of the [README](README.md).
3. Behavioural changes come with a test.
4. `bun run check` and the affected suites pass locally. Say in the PR what you ran.
5. Comments explain constraints the code cannot show, not what the code already says.

## Setup

```sh
bun install && bun run build
bun run check
```

Per-package suites run from the package directory and need the preload:

```sh
cd packages/coding-agent
bun test --preload ../../scripts/test-preload.ts --isolate test/bun-repl.test.ts
```

More in the [development guide](packages/coding-agent/docs/development.md).
