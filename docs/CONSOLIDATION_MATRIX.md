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
| Test harness | suite/harness.ts, helpers/daemon-harness.ts, helpers/{wait,temp,table,render}.ts | test/** | session vs daemon vs generic | one helpers/ layer | low | now (T/E2) |
| stripAnsi/ANSI helpers | tui + coding-agent copies | several | identical | one home (S audit 1/5) | low | now |
| File-lock retry | auth-storage + settings-manager private copies | 2 | DONE afdd9352e | core/file-lock.ts | done | done |
| Auth source fingerprint | auth-storage + model-registry | 2 | DONE afdd9352e | core/auth-source-fingerprint.ts | done | done |
| Abort scaffolding | edit/write-file/native tools | 13 sites | DONE afdd9352e | core/tools/abortable.ts | done | done |
| Git tree-sync vocabulary | merge/stash/rebase/branch/reset/log private copies | 7 modules | G Batch B in flight | objects/diff/worktree helpers | low | now |
