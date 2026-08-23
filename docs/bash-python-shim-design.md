# Bash + Python Shim Design (Bun REPL Kernel)

Status: architecture gate — no implementation yet.
Date: 2026-07-19
Scope: give agents the *belief* that `bash` and `python` exist as first-class cell languages with ~50 stdlib functions each, while execution actually happens inside the Bun REPL kernel, sharing ONE variable space across bash / python / JS, with pipes, and falling back to real process spawn only on error or unsupported constructs.

---

## 1. Research findings

### 1.1 just-bash (vercel-labs/just-bash)

Verified against the repo at HEAD `main` and npm `just-bash@3.4.2`.

| Question | Answer |
|---|---|
| What it is | A simulated bash environment: full bash lexer+parser (`re2js`) + interpreter, virtual filesystem, ~90 built-in commands implemented in TypeScript. |
| Virtual FS | Yes — `InMemoryFs` (default), `OverlayFs` (copy-on-write over a real directory), `ReadWriteFs` (direct disk access). All pluggable via the `fs` constructor option. |
| Pipes / redirection | Yes. Pipes between any commands, `>`, `>>`, `2>`, `2>&1`, `<`, heredocs, `&&`, `||`, `;", variables incl. `${VAR:-default}`, positionals, globs, if/elif/else, functions, `local`, for/while/until, symlinks. Commands receive a `ResolvedCommandContext` with `fs`, `cwd`, `env`, `stdin` (bytes), `exec` (subcommands). |
| Extension point | `defineCommand(name, async (args, ctx) => ({ stdout, stderr, exitCode }))`. Custom commands are registered **after built-ins so they can override** (`packages/just-bash/src/Bash.ts` line 523 comment, verified in source). A `commands?: CommandName[]` allow-list can restrict built-ins to a minimal set. This is exactly the hook needed to point command execution at our native tool implementations instead of its own virtual-FS implementations. |
| Weight | npm unpacked **22.6 MB** (includes vendored `vendor/cpython-emscripten/` WASM CPython for the optional `python3` command). 16 runtime deps including two WASM packages (`quickjs-emscripten`, `sql.js`). The WASM runtimes are lazy/gated (`python: true`, `javascript: true` flags), so a core-only install pays disk cost but not startup cost. |
| State model | Each `exec()` gets **isolated shell state** (env, cwd, functions reset); the **filesystem is shared** across calls. Cross-call variable persistence must be done by us: read back env after exec, pass it into the next `exec({ env })`. |
| License | Apache-2.0 (package.json + README; note: no LICENSE file at repo root, license API returns 404 — attribute via package metadata). |
| Vendorable? | Yes as an npm dependency. Its own docs call it beta software. It also has an experimental `@just-bash/executor` companion package (tool-invocation hook), currently on a different major track (5.x). |

**Verdict: vendor as a dependency.** Writing our own bash parser is the single highest-risk item in this project and just-bash has already solved it (lexer, parser, interpreter, pipe/redirection scheduling, glob expansion, limits/abort). We use it purely as a shell-syntax engine: restrict built-ins to a small allow-list, override the commands we implement natively via `defineCommand`, and bridge fs/env to the kernel.

### 1.2 PyJS (yzyzsun/PyJS)

Verified from `grammar.txt`, `src/builtin.js`, `src/object.js`, README at `master`.

| Question | Answer |
|---|---|
| Coverage | Grammar supports: int/float/bool/str/list/dict/set/None, arithmetic/comparison/boolean ops, ternary, assignment/aug-assign, del/pass/return/break/continue, if/while/for (+else), def, class. **Missing everything agents actually need**: no f-strings, no comprehensions, no try/except, no import system, no lambda, no keyword/default args, no generators, no with/raise/assert, no slicing grammar, no string methods beyond dunder dispatch. |
| Builtins | ~15 (`abs all any bool chr filter len map max min ord pow range repr round sum type`). `range()` eagerly materializes a list. `round()` is plain `Math.round` (wrong vs Python banker's rounding). |
| Eval quality / safety | Author's own words in the README: *"Do not use it for serious business."* Course project (Zhejiang University PL course), last meaningfully touched 2017-era toolchain (Jison-generated LALR parser, Babel-to-ES5, CommonJS). No sandbox story, no error taxonomy beyond a tiny `error.js`. |
| Weight | ~55 KB of source (54 KB of that is generated parser code). MIT. |
| Stars | 31 (not community-hardened). |

**Verdict: reject PyJS.** It fails on the exact subset named in the goal (f-strings, comprehensions, imports).

### 1.3 Python-subset transpiler (the alternative)

A hand-written tokenizer + recursive-descent parser emitting JS AST-free source strings, restricted to the common agent subset:

- literals incl. f-strings → template literals
- list/dict/set displays, **comprehensions** (list/dict/set/gen) → IIFE over `.map/.filter` or a for-loop emit
- slicing, negative indices, `dict[k]`, `in`, chained comparison, tuple packing/unpacking
- `print`, `def` (with default args), `for ... in`, `while`, `if/elif/else`, `try/except/finally` (mapped to JS try/catch with a `PyError` wrapper), `break/continue/return`
- truthiness rules adjusted where cheap (empty container falsy — matches JS already; ints/floats are JS numbers)
- `import math, json, os.path, re, itertools, collections, statistics, random, datetime` → prelude objects bound in kernel scope

Estimated size: **~500–700 LOC** transpiler + **~600–800 LOC** stdlib mocks. Runs inside the existing kernel vm, so python names ARE JS bindings in the same variable space — sharing is free, which is the whole point of the exercise.

Risk: silent miscompiles on constructs outside the subset. Mitigation: hard fail (never guess) on unrecognized syntax → triggers the documented fallback path; snapshot corpus of agent-typical snippets tested against real CPython behavior.

**Verdict: transpile, do not interpret.** A full interpreter buys nothing here because the target runtime is JS in the same realm; the interpreter's only advantage (exact Python semantics) is out of scope by definition since we mock stdlib anyway.

### 1.4 Existing assets we map onto

- Kernel: `packages/coding-agent/src/core/bun-repl/` — `cell.ts` parses `%%bash`/`%%js` magic; `repl-script.ts` routes bash cells to `Bun.spawn` and JS cells to the vm; shared `cwd`/`env` across cells already exists.
- Skills/bindings usable as mock backends: `df` (pandas-shaped table ops), `stats` (statistics/numpy-ish array math), `chart` (matplotlib.plt-shaped plotting).
- Native tools under `packages/coding-agent/src/core/tools/native/` (`grep.ts`, `sed.ts`, `wc.ts`, `find.ts`, `head-tail.ts`, ...) provide reference implementations and output formats for the bash stdlib layer.

---

## 2. Recommended architecture

```
agent writes %%bash or %%python cell
        │
        ▼
kernel cell router (cell.ts)
        │
        ├─ %%bash ──► just-bash (vendored dep)
        │                parser + pipes + redirection + vars
        │                every command = defineCommand wrapper
        │                └─► kernel-native impl (TS fn over shared state,
        │                     reusing tools/native logic where it exists)
        │
        ├─ %%python ► py-subset transpiler (~600 LOC)
        │                emits JS → evaluated in the SAME vm scope
        │                stdlib = prelude of mocked modules
        │                └─ pandas→df skill, matplotlib→chart skill,
        │                     statistics/numpy→stats binding
        │
        └─ fallback: parse error / unsupported construct / shim crash
                      → transparent Bun.spawn of real bash/python
                        (real python only if installed; else clear error)
```

One kernel object (`K`) is the single variable space. All three languages read/write it:

- **JS**: direct bindings (existing behavior).
- **bash**: variables are strings; `export FOO=...` / `$FOO` map to `K.__env.FOO`. On every exec boundary we sync: seed just-bash env from `K.__env`, harvest env changes back after exec (just-bash isolates shell state per exec, so WE own persistence — this is required anyway). Non-string kernel values are exposed to bash as their string form only (write-back never clobbers structured values; bash sees a shadow copy).
- **python**: transpiled names become bindings in the same vm scope, so `x = [1,2,3]` in python and `x.map(...)` in the next JS cell operate on the same object. Module-level python code runs top-level in the cell scope; function-local scoping handled at transpile time (Python function args/locals get a per-function scope object to avoid leaking — simplest correct approach: transpile `def` bodies referencing locals through destructured parameters).

### Shared-variable-space contract

| Direction | Rule |
|---|---|
| JS → bash | `K.__env.NAME = String(value)`; visible as `$NAME` |
| bash → JS | harvested env vars land in `K.__env`; files written in the bash virtual FS are harvested into `K.__files` so JS can read them without spawning |
| JS ↔ python | identical bindings (same scope); python containers are JS arrays/objects/Maps |
| python → bash | via explicit `export` helper or `K.__env` |

Virtual FS policy: seed just-bash `InMemoryFs` from cwd snapshot lazily OR run `OverlayFs` rooted at the session cwd (reads hit disk, writes stay in memory until the cell ends, then we choose to commit or discard — default: keep in-memory, expose via `K.__files`, matching the sandbox posture just-bash recommends). Start with InMemoryFs + explicit seeding; OverlayFs is a follow-up.

### Pipe execution strategy

Pipes live entirely inside just-bash: bytes flow between `defineCommand` wrappers through `ctx.stdin`/`stdout`. No real processes. Special forms:

- `python3 -c '...' | cmd`: register a `python3` custom command whose wrapper transpiles+evaluates in the kernel scope and returns stdout bytes. Stdin available as `sys.stdin.read()` (prelude reads ctx.stdin).
- `js-exec` equivalent: optional `node` custom command evaluating a JS snippet in the kernel scope.
- Mixed real/virtual: any command NOT registered as a shim falls back immediately to `Bun.spawn` for that pipeline segment (just-bash supports host-provided commands doing arbitrary work, so the segment spawns and re-enters the pipe as bytes).

### Fallback rules (ordered)

1. Transpiler/parser throws or hits an unsupported construct (heredoc edge cases, process substitution, arithmetic $((...)) gaps) → rerun the whole cell through real `bash -c` via Bun.spawn (current %%bash path, kept intact).
2. Python cell uses anything outside the subset → same-cell fallback to real `python3` if present on PATH; otherwise a precise "unsupported construct X" error naming the line.
3. A shim command crashes at runtime → log, retry that one command via real spawn, merge output. Never silently swallow.
4. Timeouts/abort: reuse existing kernel abort machinery; just-bash `executionLimits` set conservative defaults (30s wall clock, output caps).

Fallbacks are surfaced in the result frame (`shim: false` marker) so the agent knows semantics changed.

### The ~50-function stdlib lists

**bash (override via defineCommand; allow-list keeps just-bash's remaining builtins minimal):**
cat ls head tail wc grep sed sort uniq tr cut paste awk jq echo printf seq date basename dirname pwd cd export env printenv mkdir touch rm cp mv find tee xargs true false which sleep md5sum sha256sum base64 rev tac column diff stat tree — ≈50. Each wraps either existing native-tool logic (grep/sed/wc/find/head-tail) or a small TS implementation over the virtual FS. Everything else (curl, tar, gzip, sqlite3...) stays as just-bash built-ins behind the allow-list or falls back to spawn.

**python builtins (~25):** print range len sorted reversed sum min max abs enumerate zip map filter round int float str bool list dict set tuple isinstance type open(→kernel fs) input(→error w/ guidance) any all repr format divmod
**modules:** math (~15 fns), json (loads/dumps/dump/load), os.path (join/exists/basename/dirname/getsize), re (match/search/sub/findall/split/compile), collections (Counter/defaultdict/deque), itertools (chain/product/combinations/permutations/groupby/islice/count), statistics (mean/median/stdev/variance — delegates to stats binding), random (random/randint/choice/shuffle/seed), datetime (now/timedelta/date), sys (argv/stdin/stdout/path stubs), io.StringIO
**mock-heavy modules:** numpy (array/arange/zeros/ones/shape/mean/std/sum/dot/concatenate/linspace → stats binding + plain JS arrays), pandas (DataFrame/Series/read_csv/read_json/groupby/merge/head/describe/to_csv → df skill), matplotlib.pyplot (plot/bar/hist/scatter/title/xlabel/ylabel/legend/show/savefig → chart skill; show() renders into the kernel attachment channel like attach-image does today)

Counting rule for "~50": builtins + module functions exposed in the prelude; the doc-visible promise to agents is "~50 stdlib functions covering 99% of usage", delivered as ~25 builtins + the listed module surfaces.

---

## 3. LOC estimates

| Component | Estimate |
|---|---|
| just-bash integration shim (env sync, fs seed/harvest, cell routing, abort wiring) | 300–450 |
| ~50 bash command wrappers over native logic | 400–600 (mostly thin) |
| Python-subset transpiler (tokenizer + parser + emitter) | 500–700 |
| Python stdlib prelude (builtins + modules) | 600–800 |
| numpy/pandas/matplotlib mocks | 300–400 |
| Tests (transpiler corpus, pipe cases, fallback paths, var-space sharing) | 500–700 |
| **Total** | **~2,600–3,650 LOC** |

Phasing: (1) bash shim + var-space bridge; (2) python transpiler core; (3) stdlib prelude; (4) numpy/pandas/matplotlib mocks; (5) fallback hardening + corpus tests.

---

## 4. Risks

1. **Semantic drift**: mocked python ≠ CPython. Agents may learn wrong behaviors (e.g., integer division, string immutability quirks, float formatting). Mitigation: corpus tests against real CPython for the supported subset; hard-fail rather than approximate on ambiguous cases.
2. **Transpiler miscompiles**: silent wrong output is worse than an error. Mitigation: strict mode — unknown node types raise; golden-file tests; fallback marker in results.
3. **just-bash beta churn**: v3 (shell) vs v5 (executor) split signals API instability; Apache-2.0 attribution needed; pin exact version, wrap behind our own thin interface so swapping/porting later is contained.
4. **Custom-command override semantics**: verified in source today ("registered after built-ins so they can override", Bash.ts:523), but this is behavioral, not contractual — add an upgrade test.
5. **Weight**: just-bash pulls 16 deps (~22 MB unpacked incl. vendored CPython WASM). Acceptable as a dev dependency of coding-agent; verify Bun bundling doesn't choke on its Node-targeted code (browser bundle exists, so likely fine). If install weight is unacceptable, plan B is porting only its parser+interpreter (MIT-equivalent notice required, Apache-2.0) — est. +800 LOC of glue.
6. **Env-string flattening**: bash sees stringified kernel values; agents passing structured data bash→JS must go through JSON files/jq. Document this explicitly in the tool description.
7. **Two-truths problem**: when fallback spawns REAL bash/python, results differ from shim semantics (real python has no df/chart skills). Keep fallback rare and marked.

---

## 5. Decision record

| Decision | Choice | Runner-up |
|---|---|---|
| bash engine | **Vendor just-bash** as dependency, commands overridden via defineCommand | Port parser patterns (+risk, +LOC) |
| python engine | **Hand-written subset transpiler → JS**, executed in kernel vm | PyJS (rejected: missing f-strings/comprehensions/imports, unmaintained, author says don't) |
| variable space | Single kernel scope object; bash env synced per-exec; python shares JS bindings directly | Separate namespaces + marshal layer (more code, worse UX) |
| pipes | Inside just-bash between shim commands; python/js segments as custom commands | Real process pipelines (defeats purpose) |
| fallback | Whole-cell re-run via real spawn, marked in output | Per-statement mixing (unpredictable) |
