# MISSION: SEMANTIC COMPRESSION OF THE AGENT PLATFORM

Adapted for optimus-prime (fork of prime-agent): TypeScript/Bun agent platform,
packages: ai (providers/models), tui (terminal toolkit), coding-agent
(interactive TUI, daemon, REPL, tools, persistence), agent (protocol types).
Toolchain is Bun-only. Baseline 372,720 LOC; current ~345,600; TARGET <=250,000
total lines. You do not stop before 250k.

The repository provides an agent experience through multiple surfaces (TUI,
REPL, daemon, CLI), provider integrations, tools, persistence, and test
harnesses.

Your mission is to make the codebase substantially smaller, simpler, and more
coherent by eliminating duplicated concepts and implementations.

Target: roughly 40-50% reduction in meaningful source and test-harness code
where the reduction follows from real consolidation. The line-count target is
a pressure signal, not permission to delete behavior, weaken tests, hide
complexity, or produce unreadable code.

Primary optimization target:

> Fewer concepts, fewer state machines, fewer execution paths, fewer
> representations of the same data, and fewer implementations of the same
> behavior.

Physical line reduction is secondary to semantic reduction.

---

## 1. Absolute requirements

Preserve all supported user-visible behavior unless explicitly identified as
obsolete AND approved by root (the depth-0 coordinator agent) in the refactor
log. Preserve where applicable: CLI behavior and exit codes; TUI behavior;
REPL behavior; daemon behavior and transport semantics; streaming; tool
invocation and argument handling; approval/rejection; cancellation;
timeouts; retries; persistence and resume; session history; compaction;
provider-specific compatibility; configuration precedence; environment
handling; error categories and diagnostics; security and permission
boundaries; extension/plugin behavior; logging contracts; public APIs unless
migration is planned.

Do not claim behavior is preserved merely because it compiles or tests pass.
Establish explicit behavior evidence.

MULTI-WORKER RULES still apply (shared worktree): commits carry explicit
pathspecs; scope restores to your own paths and announce them; boundary
disputes go to root; announce reusable helpers before building private copies.

## 2. Architectural end state

### 2.1 Client adapters - TUI/REPL/daemon/CLI are adapters. They may own input
decoding, key bindings, CLI parsing, terminal rendering, transport,
serialization, connection lifecycle, surface presentation. They must NOT own an
alternative agent loop, alternative session state machine, provider stream
handling, tool execution policy, duplicated approval logic, duplicated
persistence or conversation orchestration.

### 2.2 Application runtime - one runtime owns session create/load, command
dispatch, event broadcast, lifecycle, persistence coordination, replay,
subscriptions. (Today this role is split across AgentSession,
interactive-mode.ts orchestration and daemon-mode.ts - converge it.)

### 2.3 Agent kernel - one canonical kernel owns model invocation, normalized
streaming, assistant/tool state transitions, tool lifecycle, approval,
cancellation, timeouts, retries, error classification, compaction, finish
conditions. (Today: @earendil-works/pi-agent-core AgentLoop + per-surface
copies.) The kernel must not import TUI, REPL, daemon, terminal or transport
code.

### 2.4 Ports and adapters - external concerns via explicit ports: model
provider, filesystem, process execution, network, clock, workspace,
persistence, logger, telemetry. Production adapters may use Bun APIs; domain
logic must not be coupled directly to Bun globals.

## 3. Canonical protocol

One canonical command protocol and one canonical event protocol. Every surface
communicates through them. Typed discriminated unions covering: user input,
slash commands, tool approval/rejection, interruption, cancellation, resume,
text deltas, assistant messages, tool requests/lifecycle, approval requests,
status, usage, warnings, errors, completion. If two event types have the same
meaning, merge them; if similar but with different lifecycle/error semantics,
keep distinct and document why.

## 4. Mandatory discovery phase

Before broad architectural changes, extend docs/CONSOLIDATION_MATRIX.md (see
below) with: production/test/fixture/generated LOC by directory; all entry
points; all agent loops; all session state representations; all command and
event representations; all provider adapters/decoders; all tool registries and
execution paths; all fs/process/network abstractions; all persistence
implementations; surface-specific logic; duplicated test setup; overlapping
utilities; dependency graph and import cycles; high fan-in/out modules; dead
code candidates; compatibility-sensitive areas.

## 5. Baseline and measurement

Report numbers SEPARATELY: production code / tests / fixtures / generated /
config / docs. Current split is tracked in docs/REFACTOR_LOG.md. Generated
files (models.generated.ts et al) count separately from hand-written code.

## 6. Canonical data flow

    client command -> application runtime -> agent kernel ->
    model/tool ports -> normalized domain event -> application runtime ->
    client adapter

    provider response -> decoder -> normalized model event -> kernel ->
    canonical agent event

No core branches like if(provider==="x") or if(runningInTui/Daemon/Repl);
surface and provider behavior belongs at boundaries.

## 7. Tool consolidation

One authoritative definition per tool deriving: name, description, schema,
validation, execution, permissions, timeout policy, cancellation, display
metadata (kind/read_only envelope), model-facing schema, test registration.
Prefer small declarative definitions and plain functions. Do not build a
framework that makes simple tools more verbose. The canonical runner owns
validation, authorization, lifecycle events, cancellation, timeout, error and
result normalization.

## 8. Capability consolidation

Canonical ports for filesystem, process execution, network, clock, workspace,
persistence, logging. Use Bun-native implementations where they reduce code
and preserve semantics. A wrapper is justified ONLY by: dependency injection,
security control, testability, normalization, cancellation, lifecycle,
portability, observability. Do not wrap every Bun API mechanically.

## 9. Migration method - strangler, not rewrite

Per capability: document current behavior -> define canonical interface ->
implement canonical path -> characterization tests -> adapter for one caller ->
compare outputs/traces -> migrate remaining callers -> delete old implementation
-> remove compatibility code -> update metrics. Never leave two active
implementations without a named owner, documented reason, removal condition.
Vertical slices, each runnable and testable.

## 10. Test consolidation

Classify tests: unit / contract / provider-normalization / capability /
kernel-transition / adapter / integration / e2e / regression / fixtures.
Consolidate only when tests exercise the same behavior with different data.
Scenario matrices for state transitions, streams, tool lifecycles, permission,
cancellation, retry, persistence, malformed inputs, subprocess failures.
Preserve assertions on exact error categories, event order, arguments,
approval, cancellation, timeout, persistence, exit codes, visible output. No
weak snapshots replacing strong assertions. One canonical harness setup path
(test/helpers/) for fake models/tools/fs/processes/clock/persistence/event
collection.

## 11. Generalization rules

Generalize by SEMANTIC OWNERSHIP, not textual resemblance. Justified when code
implements the same invariant, lifecycle, domain concept, must stay
synchronized, shares failure/cancellation semantics, or exposes the same
external contract. NOT justified by: similar names, similar control flow,
similar shapes with different meanings, coincidental parameter lists, shared
formatting, one-time reuse. Every abstraction answers: what invariant does it
own; which duplicates does it replace; what does it standardize; who may depend
on it; what invalidates it.

## 12. Readability and complexity rules

Explicit, typed, debuggable, idiomatic TS/Bun. Forbidden: any to bypass design,
unsafe casts, disabled checks, dense one-line control flow, hidden side
effects, magic global state, giant utility modules, universal base classes,
excessive generic machinery, obscuring metaprogramming, ownerless
abstractions. A reduction that makes behavior harder to trace is invalid.

## 13. Dependency direction

domain/kernel -> ports/types -> application runtime -> adapters -> surfaces.
Forbidden: kernel imports TUI/daemon transport; domain logic imports terminal
formatting; provider types leak into kernel; adapters instantiate competing
runtimes; low-level utils importing policy; test helpers becoming production
dependencies. Resolve cycles by moving types toward the lower boundary.

## 14. Verification gates

After every slice: formatter, typecheck, lint, focused tests, affected
integration tests, full suite (batched), build. Verify startup/shutdown/
streaming/cancel/timeout/retry/approve/reject/persist/resume/compaction/
malformed-provider/tool-failure/subprocess-failure/fs-failure/network-failure/
daemon-reconnect/TUI-resize behaviors for touched areas. Compilation alone
never completes a migration.

## 15. Stop conditions

Stop and request root review when: behavior differences cannot be explained;
compatibility contract unclear; provider edge case not understood; coverage
declines unexpectedly; an abstraction needs unsafe typing; the canonical model
needs surface-specific exceptions; LOC target conflicts with readability; two
implementations differ undocumented; persistence/migration compatibility
uncertain; security/permissions may change; unrelated subsystems would need
rewrites. Document uncertainty, isolate, continue after risk is understood.

## 16. Completion criteria

All of: one canonical runtime across surfaces; one session model; one
command/event protocol; one agent loop; one tool lifecycle; one provider
normalization boundary; one capability boundary; duplicates deleted; legacy
paths removed or justified; test strength preserved; behavior preserved; type
safety preserved; dependency direction improved; metrics show concept/path
reduction; LOC reported by category. Final report: before/after metrics,
deleted implementations, canonical replacements, migrated surfaces, behavior
evidence, test evidence, risks, remaining duplication, retained abstractions,
behavior changes, deferred work.