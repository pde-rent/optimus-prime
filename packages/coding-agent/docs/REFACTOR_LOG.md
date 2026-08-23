# Refactor log

Deferred breaking changes, with the plan for the one PR that lands each window.
Additive renames and prompt-text renames are not recorded here; only changes that
break an existing model-facing or user-facing key.

## Naming standard (ruled 2025-07, naming-architecture pass)

Rules:

1. Name = the verb the model thinks. `spawn`, `send`, `search`. If a surface needs
   its description to explain what the name abbreviates, the name is wrong.
2. Description = the answer to the inner monologue ("when do I reach for this?"),
   not a restatement of the signature.
3. Contracts fit in working memory: one line per call in taught text; full detail
   lives in the SKILL.md the text routes to.
4. Jargon is allowed only where it is an ecosystem term of art AND the routing text
   carries the meaning (e.g. REPL, REPL cell). Internal coinages ("continual
   harness", "graph") do not qualify in model-facing text.
5. Alias-first: new names ship as pure additions and docs/prompts teach only the
   new name; existing names keep working until the next breaking window.
6. Prompt text may rename freely; settings keys, wire commands, tool schema
   literals, and persisted store formats may not (they need the breaking window).

Vocabulary decisions already landed additively:

- `spawn(...)` alias for `rlm(...)` as the taught spawn form (both bind to the same
  function; `src/core/bun-repl/repl-script.ts`).
- Prompt text teaches `spawn('<task>')` instead of the `'sub-task'` placeholder
  literal, "fan-out budget" instead of "graph budget", and plain words instead of
  "continual harness" (`src/core/prompts/rlm.ts`, `src/core/refinement/refinement.ts`
  harness-state block).

## Breaking window: unify graph -> fan-out keys

One future PR, minor release (API-breaking under lockstep rules). Scope:

1. Settings key `graphResolver` -> `fanoutBudget` in
   `src/core/settings-manager.ts` (field, `getGraphResolver`, validation) plus a
   read of the old key as a deprecated fallback so saved settings files survive.
2. Slash command `/graph` -> `/fanout` (`src/core/slash-commands.ts`), keep `/graph`
   as a hidden alias for one release.
3. Rename module `src/core/graph-resolver.ts` -> `fanout-budget.ts` and its exports
   (`GraphResolverLevel` -> `FanoutLevel`, `admitsGraphNode` -> `admitsFanoutNode`,
   `graphResolverBudget` -> `fanoutBudget`). Callers: `agent-session.ts`,
   `prompts/rlm.ts`, `settings-manager.ts`.
4. Spawn-rejection error text stays "Fan-out budget exhausted" (already renamed);
   update any test asserting the old string.
5. Daemon protocol check: if the setting or command appears in the daemon wire
   schema, classify the rename as incompatible, bump `DAEMON_PROTOCOL_VERSION`,
   and update the compatibility maps; otherwise no bump.

Cost flag: the settings key touches settings-manager, agent-session, the TUI
command path, and docs/settings.md. Estimated at a day including tests; do not
attempt incrementally with other renames because the old/new key mapping must be
exactly one release wide.

## Breaking window candidates (evaluate together, same release)

- `rlm.list_subagents` / `rlm.delete_subagent` host request names and the
  ``{ subagents: [...] }`` shape: tolerable but abbreviated; candidate
  `rlm.list_children` returning `{ children: [...] }`. Additive alias first, flip
  taught forms, remove old name one release later.
- Todo tool op literals (`add`/`update`/`remove`/`claim`...): schema literals;
   renaming requires a tool-schema migration and daemon compatibility review. Only
  worth it if the ops ever grow beyond CRUD + claim.
- /refine subsystem internal prompts still say "continual harness" as their defined
  term-of-art (`src/core/refinement/refinement.ts` REFINEMENT_SYSTEM_PROMPT); rename
  there only alongside user-facing /refine output strings, never alone.
