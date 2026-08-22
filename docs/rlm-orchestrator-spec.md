# RLM Orchestrator Protocol — ancestors, root authority, resource requests

## Problem
Depth-N agents cannot ask for help beyond their direct parent. Resource knobs
(depth, effort, context budget) are frozen at spawn time and only the root has
coordinator context, yet the gates that refuse a child's own raise
(no_trigger on `_effortEscalationTriggered`) also block the one actor who
actually knows the workload: the root team lead. Result: children die on walls
the root could lower in one action.

## Current mechanics (audited)
- Reach policy: `agentFamilyRelationship()` (src/core/agent-messages.ts:322) —
  nuclear family only: parent / child / sibling over persisted parent-edge
  snapshots (`parentSessionId`/`parentSessionPath`). Anything else throws
  AGENT_FAMILY_REACH_ERROR at assertAgentFamilyReach().
- Send path: `agent_message.send` handler (src/core/agent-messages.ts ~610-680)
  validates `receiver_role` ∈ {parent,sibling,child}, matches roster entries by
  relationship+selector, delivers via controller.sendAgentMessage.
- Depth resolution per session: `_resolveRlmMaxDepth()`
  (src/core/agent-session.ts:1592): persisted state > inherited config >
  global setting > env > default 1. Model-source raises are gated by
  no_trigger unless `_effortEscalationTriggered`; chat/user source pins and
  bypasses the graph floor entirely.
- Children inherit RLM_DEPTH/RLM_MAX_DEPTH env at admission (frozen snapshot).

## Design

### 1. Ancestor reach ("root" relationship)
Extend `AgentFamilyRelationship` with `"ancestor"`. `agentFamilyRelationship`
returns "ancestor" when target.depth < current.depth - 1 AND target lies on the
current agent's parent chain (walk persisted parent edges through the catalog;
all edges are already persisted per entry). Depth-0 target => relationship is
"ancestor" with `atRoot: true` in the roster entry.
- `assertAgentFamilyReach` accepts it; AGENT_FAMILY_REACH_ERROR text updated to
  "limited to parent, siblings, children, and ancestors".
- `agent_message.send` accepts receiver_role "ancestor"; selector required when
  multiple ancestors exist (depth alone disambiguates: prefer nearest).
- Prompt text (src/core/prompts/rlm.ts:270-298) updated to document ancestor
  reach and the request protocol below.
- Observation rights UNCHANGED (still nuclear family) — messaging ≠ inspection.

### 2. Resource-request protocol
New REPL binding method: `await rlm.request({ maxDepth?, effort?,
contextTokens?, reason })`.
- Validates args locally (same ranges as set_max_depth/set_effort/
  set_context_budget); bad args throw TypeError caller-bug style.
- If the request can be satisfied locally WITHOUT a gated raise (lowering,
  or a raise whose trigger latched), apply locally and return
  {granted: true, local: true} immediately — protocol is only for gated paths.
- Otherwise serialize as a control envelope:
  { kind: "resource_request", requestId, requested: {...}, reason,
    requester: {id, name, depth, sessionId}, chain: [ids from requester up] }
  and send to nearest ancestor. Each intermediate ancestor forwards upward
  unchanged (it may append an endorsement note). Root (depth 0) is terminal.
- Root receives the envelope as an ordinary agent message prefixed with a
  structured header it can act on; root decides and replies
  { kind: "resource_decision", requestId, granted, applied } back DOWN the
  chain (delivery uses existing child-role routing from root to each hop).

### 3. Applying a grant (no cross-process handles needed)
When an agent receives a resource_decision addressed to its requestId, its
kernel applies the change LOCALLY via the existing setters using
source: "chat" semantics — i.e. a root-approved grant is treated as a
user-authority pin for that session only:
- depth: setRlmMaxDepth(granted, { source: "model" }) is NOT used; instead a
  new internal applyRlmMaxDepthGrant() marks the persisted state with
  source: "root" which _resolveRlmMaxDepth treats like "chat" (stands even
  against graph floor) but records provenance for audit.
- effort: applies next turn (existing contract), never mid-cell.
- contextTokens/compactAt: existing dynamic-context setter, same rules.
The grant travels with an expiry/one-shot semantic: one grant, one apply;
re-requests need a fresh reason. Root-side rate guard: max N pending requests
per requester (default 3) to prevent loops.

### 4. Non-goals
No change to observation rights. No automatic grants. No grandchild→grandparent
direct delivery (routing stays strictly along the chain). Root cannot reach INTO
a subtree uninvited except by replying along an open chain.

## Files touched
- src/core/agent-messages.ts: relationship + routing + control envelopes
- src/core/agent-session.ts: applyRlmMaxDepthGrant, request forwarding hooks
- src/core/bun-repl/repl-script.ts + repl-types.ts: rlm.request surface
- src/core/prompts/rlm.ts: prompt documentation blocks
- tests: relationship matrix incl. depth-2 chains, envelope round-trips,
  grant application, refusal paths, loop guard

## Acceptance
1. Depth-2 agent sends rlm.request({maxDepth:2}) -> root sees structured
   request -> approves -> depth-2 session resolves maxDepth 2 afterwards.
2. Nuclear-family behavior byte-identical for all existing tests.
3. Observation still refuses across non-family nodes.
