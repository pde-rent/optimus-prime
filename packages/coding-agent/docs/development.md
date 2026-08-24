# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Optimus Prime requires [Bun](https://bun.sh) 1.3.0 or newer. Bun is both the build toolchain and the runtime for the agent's REPL, so no separate interpreter is needed.

```bash
git clone https://github.com/PrimeIntellect-ai/optimus
cd optimus
bun install
```

Run from source:

```bash
/path/to/optimus/optimus.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Product and Source Names

Optimus Prime is the product, public CLI, release artifact, and repository name. The monorepo still retains inherited `@earendil-works/pi-*` npm workspace names, a source-package `pi` bin entry, the `pi` package manifest key, and some `PI_*` compatibility environment variables. These names are source and compatibility details, not a signal that contributors should install or develop against pi-mono.

Public releases are currently versioned tarball artifacts installed by the stable and beta installer scripts. `scripts/pack-optimus-release.mjs` rewrites the coding-agent package name, executable, config metadata, and internal dependency URLs for that distribution. Do not document the inherited npm workspace package as the public Optimus Prime install path.

## Local Configuration

User configuration lives under `~/.optimus/agent/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.optimus/agent/` in the project root. Override the user config directory with `OPTIMUS_CODING_AGENT_DIR` and the session directory with `OPTIMUS_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
OPTIMUS_CODING_AGENT_DIR=/tmp/optimus-dev /path/to/optimus/optimus.sh
```

## Standalone Dev Instance

To exercise harness or daemon fixes from the current working tree without touching your live daemon or `~/.optimus/agent` state, use `scripts/dev-instance.sh`. It starts a detached daemon from source with its own agent state directory and socket, in a temp directory (override with `OPTIMUS_DEV_INSTANCE_DIR`).

```bash
scripts/dev-instance.sh start    # replaces any previous dev instance
scripts/dev-instance.sh status   # shows socket, state dir, and how to address it
scripts/dev-instance.sh cli --print -p 'hello'   # one-shot run against the instance
scripts/dev-instance.sh cli      # interactive TUI against the instance
scripts/dev-instance.sh stop     # graceful shutdown; state is kept
scripts/dev-instance.sh destroy  # stop and delete all dev-instance state
```

Every `cli` invocation gets `OPTIMUS_CODING_AGENT_DIR` and `--daemon-socket` pointed at the instance, so sessions, logs, and cron jobs stay fully isolated. The default daemon and default socket are never touched. A fresh agent dir has no credentials, so one-shot runs need a provider key (for example `--provider <name>` plus its environment variable, or copy an `auth.json` into the instance's agent dir).

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package Asset Resolution

Optimus Prime runs from source, Node.js package output, and standalone release artifacts. Always use `src/config.ts` helpers for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Do not resolve packaged assets directly from `__dirname`.

## Debugging

The hidden `/debug` command writes `~/.optimus/agent/optimus-debug.log` with rendered TUI lines, their visible widths, and the current agent messages. Daemon, worker, client, and provider diagnostic logs live under `~/.optimus/agent/logs/`.

Useful service commands:

```bash
optimus status
optimus doctor
optimus doctor --fix
optimus shutdown
```

## Validation

After code changes, run the repository check from the root:

```bash
bun run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
bun test --preload ../../scripts/test-preload.ts test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.
