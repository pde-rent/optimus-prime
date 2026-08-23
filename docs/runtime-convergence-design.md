# Runtime convergence design (mission 2.2 / 3)

Status: DESIGN ONLY - implementation waits for root sequencing.
Author: Team S. Evidence base: full-session audits (daemon trio, interactive
decomposition wave 1, dead-code detectors) - all numbers measured, not estimated
unless marked ~.

## 1. Census: current implementations

### Command dispatch (4 implementations)
| Surface | Entry | Semantics |
|---|---|---|
| AgentDaemon (daemon-mode.ts ~7.0k) | `handleLine` | ~50 command types dispatched in-process against ActiveSessionState map; worker-auth fencing for nested workers |
| DaemonSupervisor (daemon-supervisor.ts ~5.1k) | `handleLine` | admission/generation gating, worker proxying via requestData, owned-worker cleanup scheduling |
| InteractiveMode (interactive-mode.ts ~9.3k) | slash handlers -> session/runtime calls | local UX commands + delegation to connection |
| RPC mode (modes/rpc) | line protocol | thin proxy to AgentSession |

Shared already: parse envelope (`parseCommandAndRegisterPromptAdmission` -
divergent signatures), `failure()`/`salvageDaemonCommandId` envelopes,
DAEMON_COMMAND_TYPES table.

### Session model (3 representations)
- `ActiveSessionState` (daemon-mode): runtime + clients set + event sequence +
  catchup/pending bookkeeping.
- `ResidentWorker` (supervisor): process handle + descriptor + owner-cleanup
  timers + passivation state.
- In-process sessions (TUI/RPC): AgentSessionRuntime held directly by the mode.

### Event protocol (3 representations)
- Daemon wire events (`DaemonOutbound` union, sequenced, catchup-replayable).
- AgentSession runtime events (subscribe/emit inside runtimes).
- TUI invalidation (requestRender calls, no event objects).

## 2. Canonical targets (mission 2-3)

1. **One command protocol**: extend the existing daemon wire union to cover every
   operation each surface needs (slash commands and UI intents become commands;
   TUI-local-only commands stay client-side but are declared in the same table).
2. **One dispatcher**: `CommandDispatcher` interface with two adapters:
   `LocalDispatcher` (in-process runtimes - absorbs AgentDaemon's in-process arm)
   and `ProxyingDispatcher` (worker routing - absorbs DaemonSupervisor's arm).
   Auth/fencing become middleware stages, not handler branches.
3. **One session registry**: `SessionRegistry` owning id->runtime mapping,
   attach/detach sets, event sequencing. Daemon-mode's ActiveSessionState map and
   supervisor's worker-resident registry merge behind it; TUI holds one entry.
4. **One event bus**: canonical domain events; DaemonOutbound becomes a serializer
   view over them (catchup = replay from sequence cursor), TUI requestRender stays
   an adapter side effect.

Non-goals: changing wire bytes on the socket (clients keep protocol compat);
merging TUI key handling; touching provider normalization.

## 3. Strangler slices, risk-ordered

| # | Slice | Absorbs | Est. LOC delta | Risk |
|---|---|---|---|---|
| R1 | SessionRegistry extraction (attach/detach/sequence/catchup state from both classes; daemon-client-connection.ts already owns the pure transitions) | ~600 lines out of both god classes | -200 (net of new module) | medium |
| R2 | Dispatcher middleware chain (auth, generation fence, update-restart fence as stages) | fencing branches in both handleLines | -150 | medium |
| R3 | LocalDispatcher: move AgentDaemon's in-process command handlers to standalone functions taking (registry, command, client) | ~2.5k of daemon-mode.ts | -800~-1,200 | high |
| R4 | ProxyingDispatcher: supervisor's forward/admit paths behind same interface | ~1.5k of supervisor | -400~-700 | high |
| R5 | Event bus: replace direct stream.push fan-out with bus; DaemonOutbound serializer on top | fan-out loops in both classes + interactive invalidate sprinkles | -300~-500 | high |
| R6 | TUI slash commands join the declared-command table | interactive-mode handler arms | -200~-400 | low-medium |

Sequence R1->R2 before R3/R4 (they need the interfaces), R5 after R3 (bus needs
the dispatcher's event contract), R6 independent/any time.

Total realistic yield: **~2,100-3,200 LOC** plus the unblock of further collapse
(interactive-mode drops below 6k; daemon pair below 9k combined).

## 4. Verification gates per slice

Baseline suites: daemon-mode.test (194/4 recorded baseline),
4601-worker-snapshot-cache regression, daemon-session-* suites,
daemon-supervisor-process (env-excluded, cite at HEAD). Behavior evidence:
socket-level replay tests must assert identical wire bytes pre/post (snapshot
test on catchup sequences recommended in R1).
