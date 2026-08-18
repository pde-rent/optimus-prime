# Bun REPL parity with the Python/IPython kernel

The fork replaced a persistent Python/IPython kernel (`src/core/kernel/*`,
`prime-agent-runtime/src/rlm/*`, the `ipython` tools) with a persistent Bun JS/TS REPL
(`packages/coding-agent/src/core/bun-repl/`). Parity was assumed rather than proven. This
document is the audit: every capability the old kernel had, what the Bun REPL does today,
and — where it was missing — what was implemented.

The old implementation was recovered from git history at `875aba965` (the commit before the
deletion) and read as the specification.

## Verdict counts

| Verdict | Count |
|---|---|
| Present already | 21 |
| Implemented in this pass (was missing/partial) | 17 |
| Deliberately dropped | 12 |
| Accepted divergence (recorded, not closed) | 4 |

## Execution semantics

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| Serialized execution, one cell at a time | `executionQueue` promise chain | **present** | `BunReplManager._executionQueue`; tool declares `executionMode: "sequential"` |
| Auto-start on execute | `start()` inside `enqueueExecute` | **present** | |
| Pre-flight abort short-circuit | 3 checkpoints | **present** | |
| `durationMs` on every result | `Date.now() - started` | **present** | |
| Last-expression value as the cell result | `execute_result` `text/plain` | **present** | `transformTopLevel` returns `lastExpression` |
| Top-level declarations persist across cells | IPython `user_ns` | **present** | `transform.ts` rewrites decls onto the vm global |
| `internal` flag excluding host cells from attribution | `ExecuteOptions.internal` | **implemented** | `BunReplExecuteOptions.internal` |
| TypeScript cells | n/a (Python) | **implemented** | The tool advertises TypeScript but `node:vm` evaluates JS only, so `const x: number = 5` returned a bare `SyntaxError`. Cells are now retried once through Bun's transpiler *after* a parse failure — never before, because the transpiler drops statements it considers dead (a bare `({a:1})`), which would silently change valid JS |
| Malformed top-level declaration | IPython raises | **implemented** | `const = ;` produced empty output and reported the cell as a **success**. The transform now keeps the original source when the rewriter cannot read a declaration, so the engine raises |
| Silent execution / `execution_count` / `user_expressions` / stdin | — | **n/a** | The old kernel had none of these either |

## Output

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| Separate stdout / stderr / result | 3 buffers | **present** | |
| Per-stream truncation at 65536 chars | `DEFAULT_MAX_OUTPUT_CHARS` | **implemented** | There was **no cap at all**: a cell printing 500 KB put all of it into the model's context. Same constant, same verbatim marker `\n[... output truncated at N chars ...]`, applied independently to stdout, stderr and result |
| `maxOutputChars` per-call override | `ExecuteOptions.maxOutputChars` | **implemented** | |
| Live streaming callback, untruncated | `onStream(chunk, name)` | **implemented** | Was absent; a long cell showed nothing until it finished. Wired to the tool's `onUpdate` |
| Console output formatting | Python `print` | **implemented** | `console.log("a","b")` printed `["a","b"]` and `console.log(new Error("e"))` printed `{}` — the whole argument list was passed as one value. Now strings print bare and everything else through `util.inspect` |
| Result value rendering | Python `repr` | **implemented** | `JSON.stringify` flattened `Map`/`Set`/`Error`/class instances to `{}`. Now `util.inspect` (depth 4, bounded), the JS analogue of `repr`. Strings keep JSON quoting, so `"woof"` still renders as `"woof"` |
| ANSI-free output | `NO_COLOR=1`, `colors="nocolor"` | **implemented** | The REPL child now inherits `NO_COLOR=1` / `FORCE_COLOR=0`, so `%%bash` output and anything it shells out to stays plain text. `inspect` runs with `colors: false` |
| Child stderr consumed | kernel stderr tail, `[kernel] ` diagnostics | **implemented** | The child's stderr pipe was created and **never read**. Skill-load failures vanished, and once the child wrote ~64 KB the unread pipe would block it. Now drained into a 4 KB rolling tail exposed as `manager.childStderr` |

## Errors

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| `{ename, evalue, traceback[]}` shape | IPython `error` message | **present** (shape) / **implemented** (content) | `ename` was hardcoded `"Error"` and `traceback` was always `[]` |
| Real error class name | `ename` | **implemented** | Cells run in a separate vm realm, so `err instanceof Error` is always false there; the error is now described structurally |
| Traceback limited to the cell's frames | Python traceback | **implemented** | Frames below the last `evalmachine` frame (the vm entry, the stdin pump, node internals) are dropped — they are the REPL's plumbing, not the agent's code. Capped at 32 lines |
| `errorEname` in tool details | `IpythonToolDetails.errorEname` | **implemented** | The TUI reads it for the collapsed error summary; the Bun tool never set it |
| Host errors surface as catchable exceptions | `RuntimeError` in the cell | **present** | |

## Interrupt, abort, restart

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| Cooperative interrupt | `interrupt_request` on control | **present** | fixed in `819eccc5` |
| Abort grace then force | 1000 ms grace | **present** | |
| Hard-kill + respawn on runaway | manual `kill()` | **present** | Bun goes further: the old kernel had no runaway detection |
| Snapshot survives a runaway restart | — | **present** | fixed in `819eccc5` |
| Model told its state was reset | `<ipython_kernel_reset>` notice | **implemented** | Same class of defect as the three just fixed. After a hard kill the *next* cell ran against an empty namespace and the model was never told. `kernelRestarted` now rides on the next result and the tool prepends the notice. The aborted result itself is not flagged — it already explains itself in its `evalue` |
| `kernelRestarted` in tool details | present | **implemented** | |
| Busy-kernel wait/kill user prompt | `KernelBusyAfterInterruptError` + UI choice | **dropped** | The Bun REPL serializes through one queue and hard-kills a child that ignores the interrupt, so a cell can never be wedged behind a previous one. The prompt has nothing to ask about |
| Orphaned child processes on exit | `liveKernels` + signal handlers | **implemented** | The REPL is a separate `bun` process that does not die with its parent; any exit path skipping `dispose()` stranded it. A live-manager registry with one synchronous `process.on("exit")` hook now kills them. SIGINT/SIGTERM are deliberately **not** intercepted — that would change how the whole app shuts down, which is not this module's call |

## State: snapshot and restore

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| Debounced auto-snapshot (1500 ms) after a successful cell | present | **present** | |
| Atomic write, owner-only permissions | tmp + rename, `0600`/`0700` | **present** | hardened in `819eccc5` |
| Injected/host-owned names excluded | `always_skip` set | **present** | `INJECTED` |
| **`failed` reported on restore** | `RestoreResult.failed` | **implemented** | The headline gap. The old kernel told the model which names did not revive; the Bun REPL reported only `restoredNames`. Because the snapshot is JSON, **every function, class and closure is silently gone** — exactly the case the model most needs told. Now: the snapshot records what it could not carry (`manifest.droppedNames`), restore reports per-name assignment failures, the manager unions the two into `failed`, and `AgentSession._onIpythonStateRestored` names them: *"These did NOT survive and are gone: … redefine any you still need before using them."* |
| Snapshot size cap | 256 MiB, per-variable | **implemented** | There was no cap; one large variable could write an unbounded snapshot. Charged per name so one offender is reported rather than the whole save failing |
| Bounded final snapshot on dispose | `SNAPSHOT_DISPOSE_TIMEOUT_MS` 5000 | **implemented** | `dispose()` awaited the snapshot with no timeout, so a wedged child held shutdown open forever |
| Manifest back-compatibility | version 1 | **present** | `droppedNames` is an additive optional field; snapshots written before it still load and report nothing lost, rather than being discarded |
| Restore ordering (live handles win over revived ones) | restore before bootstrap | **present** | `INJECTED` names are refused during restore and reported as failed |
| `listNamespaceNames` | present | **present** | |

## Host-request bridge

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| Generic typed bridge, `{status:"ok",...}` / `{status:"error",error}` | comm on `host.request` | **present** | NDJSON over stdio instead of Jupyter comms |
| Reply path not blocked by the running cell | control channel | **present** | stdin pump is independent of cell execution |
| Unknown request type is a clean error | `... is not available in this session` | **present** | |
| `cellSourceCode` injected into every payload | present | **implemented** | Handlers received the bare payload, so `rlm.run` — which destructures `cellSourceCode` — could never show which cell spawned a child agent. Now injected first so a payload key of the same name cannot be overridden by it |
| Attribution of detached requests to the last cell | `lastCellCode` | **implemented** | Tracked as `_lastCellCode`, skipped for `internal` cells |
| Full `rlm.*` / `harness.*` verb surface | present | **present** | |
| Handler capability branding (`createHostRequestHandler`) | staged, unused | **dropped** | The old dispatcher called handlers unary and never passed the context the branding protected; it was scaffolding for an unused feature |
| No client-side request timeout | none | **accepted divergence** | Matches the old kernel exactly: a host that never replies hangs the cell until interrupt. Worth revisiting, but changing it is a behaviour change, not a parity fix |

## Display channels

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| Diff display (`application/vnd.prime-agent.diff+json`) | present | **present** | same MIME, same snake_case wire keys |
| Agent-message display | present | **present** | |
| Late agent messages after the cell settled | LRU of 256 handlers | **present** | bounded FIFO of 64 correlation ids |
| Image attachments into model context | `ATTACHMENT_DISPLAY_MIME` wrapper | **present** (redesigned) | The wrapper MIME is **dropped**: `display({mimeType, data})` now carries the real image MIME directly, and the `attach-image` skill was ported to JS. Simpler, one less indirection |
| Attachment size cap, loud on overflow | 10 000 000 base64 chars, cell → error | **implemented** | No boundary cap existed; the skill caps itself but any cell can call `display()` directly. Over-cap attachments are dropped, the cell fails, and stderr gains the verbatim `attachment dropped: exceeds 10000000 base64 chars` |
| `path` on attachments | `KernelAttachment.path` | **accepted divergence** | The type still carries it; the JS `attach-image` skill does not emit it. Only affects a TUI label |

## Shell cells

| Capability | Old kernel | Verdict | Notes |
|---|---|---|---|
| `%%bash` must be the first line | regex-anchored | **present** | |
| Throw-away subshell per cell | present | **present** | |
| `commandPrefix` prepended to the body | present | **present** | |
| `shellPath` for bare cells | rewritten to `%%script <shell>` | **present** | |
| `%%bash` magic arguments | forwarded to the magic | **accepted divergence** | `%%bash -s foo` parses the arguments but discards them. The old path forwarded them to IPython's magic; there is no equivalent here and no known caller |
| Persistent cwd / env across cells | `%cd`, `%env`, `os.environ` | **present** | `cd()`, `pwd()`, `env` — the REPL is its own process, so `process.chdir` is safe and JS and `%%bash` cells share one cwd |

## Deliberately dropped, with reasons

| Dropped | Reason |
|---|---|
| `dill` snapshot of closures, classes and live objects | No JS equivalent. The snapshot is JSON, which is why reporting `failed` matters so much |
| matplotlib / rich-display MIME capture | The old kernel had no such path either — images only ever reached the model through the explicit `attach-image` skill |
| `%%time`, `%%capture`, `%%script`, `!cmd`, IPython magics generally | IPython-specific. `%%bash`, `cd()`, `pwd()` and `env` cover the capabilities that mattered |
| `nest_asyncio`, `asyncio` in the namespace | JS has native promises and top-level await |
| Jupyter wire protocol: ZeroMQ, HMAC signing, connection files, 5 ports, heartbeat | Replaced by NDJSON over the child's stdio. No sockets, no key material, no port allocation — strictly less attack surface |
| Fork server (`fork-server.ts`, COW pre-import, `gc.freeze()`) | Existed because a Python kernel took seconds to boot. A Bun child starts in tens of milliseconds |
| Boot concurrency gate (`boot-gate.ts`, semaphore, `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS`) | Same reason: it throttled expensive Python venv boots. Nothing to throttle |
| Python venv bootstrap: `uv`, `pyproject.toml` parsing, editable installs, `PRIME_AGENT_KERNEL_PYTHON`/`_VENV`, `setup-kernel-venv.sh` | No interpreter to provision. Skills preload from `PRIME_AGENT_REPL_SKILLS` as ESM modules |
| `_PrimeAgentCallableSkillModule` / `sys.modules` rewriting / `inspect.signature` copying | Python module mechanics. A JS skill is already a plain callable object |
| `tyro` CLI dual-surface for skills (`rlm/skill.py`) | Python packaging (`console_scripts` + `tyro`). No JS equivalent shipped and no caller |
| `global_` keyword workaround | `global` is reserved in Python, not in JS |
| Busy-kernel wait/kill prompt and `KernelBusyAfterInterruptError` | See the interrupt table above — structurally unreachable now |

## Verification

- `bun run build` — clean
- `bunx tsgo --noEmit` — clean
- `bun run check` — clean
- `packages/coding-agent`: 4048 passed, 37 skipped (baseline 4036; +11 new parity tests, +1 pre-existing)
- `packages/agent`: 70 passed · `packages/tui`: 750 passed · `packages/ai`: 328 passed, 731 skipped (network tests skip without credentials)

New coverage lives in `packages/coding-agent/test/bun-repl-parity.test.ts`.

Three tests in `harness-bridge.test.ts` and `skill-preload.test.ts` were updated rather than
worked around: they asserted that a cell's result value was JSON-parseable, which was only
true while results were `JSON.stringify`'d. Results are now `inspect`-rendered — the same
"for reading, not parsing" contract the old kernel had with `repr` — so those cells
stringify their own data. No production code parses a result value.
