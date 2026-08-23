# CONSOLIDATION MATRIX

Living document: every worker extends it before broad slices (mission section 4).
| Concept | Implementations | Call sites | Differences | Canonical target | Risk | Migration order |
|---|---:|---|---|---|---|---|
| Agent loop | pi-agent-core AgentLoop + per-surface copies | interactive, daemon | streaming/pulse handling diverges | kernel (2.3) | high | late |
| Session state | AgentSession + daemon session mirrors + snapshot stubs | coding-agent core | hydration semantics | application runtime (2.2) | high | late |
| Events | TUI events, daemon wire events, agent runtime events | all surfaces | similar names, different lifecycle - keep distinct where semantics differ (mission 3) | canonical protocol (3) | high | after census |
| Tool execution | ToolDefinition factories x~20 tools + wrapper | src/core/tools | scaffolding duplication (S slice 3 collapsed abort/stat patterns) | canonical runner (7) | medium | mid |
| Provider streams | packages/ai providers/ decoders | ai | compat quirks per provider - normalization boundary already exists | provider normalization boundary | medium | mid |
| OAuth device flow | common.ts factory (was 2 hand-rolled) | ai/utils/oauth | DONE @4aaad6bf0 | createDeviceFlowOAuthProvider | done | done |
| Test harness | suite/harness.ts, helpers/daemon-harness.ts + helpers/{wait,temp,table,render,fetch}.ts | test/** | session vs daemon vs generic vs fetch stubs | one helpers/ layer | low | now (T/E2) |
| waitFor polling | 16 private copies in test/*.test.ts -> helpers/wait.ts | test/** | assertion-poll vs condition-poll variants kept as two fns | helpers/wait.ts | low | DONE wave 1 (7 files) |
| temp-dir fixture | ~12 mkdtemp+rmSync rituals in tool/session suites -> helpers/temp.ts makeTempDirs | test/** | tracked-afterEach vs withTempDir scoping | helpers/temp.ts | low | partial (tool suites done) |
| getTextOutput/result reader | 10 literal copies in tool suites -> helpers/render.ts | test/core/tools suites | identical | helpers/render.ts | low | DONE |
| fetch stub family | web3 x4 sections + websearch private stubFetch/response -> helpers/fetch.ts | skill suites | response() semantics differ per service (json-throw, contentType, text-mode) - only stubs unified, response shapes stay local where contracts differ | helpers/fetch.ts | low | DONE web3/websearch; other fetch-stubbing suites pending |
| stripAnsi/ANSI helpers | tui + coding-agent copies | several | identical | one home (S audit 1/5) | low | now |
| File-lock retry | auth-storage + settings-manager private copies | 2 | DONE afdd9352e | core/file-lock.ts | done | done |
| Auth source fingerprint | auth-storage + model-registry | 2 | DONE afdd9352e | core/auth-source-fingerprint.ts | done | done |
| Abort scaffolding | edit/write-file/native tools | 13 sites | DONE afdd9352e | core/tools/abortable.ts | done | done |
| Git tree-sync vocabulary | merge/stash/rebase/branch/reset/log private copies | 7 modules | G Batch B in flight | objects/diff/worktree helpers | low | now |
| Menu selector state machine | MenuSelector (new) replacing per-component selectedIndex/listLayout/listWindow/moveBy copies | extension-selector, oauth-selector (candidates: config-selector, tree-selector - verify contracts first; model-selector excluded: grouped selectable semantics differ) | row rendering + scroll indicator stay per-component by design | components/menu-panel.ts MenuSelector<T> | low | done for 2; audit others before adopting |
| stripAnsi/ANSI width utils | tui/src/utils.ts (optimized) vs coding-agent/src/utils/ansi.ts (regex) + color impls | tui is component-facing; utils/ansi is headless (daemon/CLI safe, no pi-tui import) | different perf targets + chalk-replacement role lives with regex copy | keep two homes, documented; revisit only if headless path can import pi-tui cheaply | low | parked |
