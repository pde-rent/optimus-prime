---
name: agent-observe
description: Use before acting on another family agent - check its status or recent output without steering it, instead of tailing transcripts by hand or interrupting it. Read-only - `await agent_observe.get_agent(target)`, `recent_messages(target)` for bounded previews, `list_agents()` for the roster. To message it use agent-message.
---

# Agent Observe

Observe the current agent's nuclear family through the local daemon: parent,
siblings, direct children, and self. Observation is currently limited to family
members in the same worker; root siblings in other workers are not observable yet.
This skill is read-only: it can list family sessions, inspect one session, and fetch
bounded recent message previews. It cannot prompt, steer, clear, kill, rename, or
otherwise mutate another session.

Call directly from the REPL:

```js
const children = await rlm.list_subagents();
const child = children.find((item) => item.active_session_id);
if (child) {
  const worker = await agent_observe.get_agent(child.session_name);
  const recent = await agent_observe.recent_messages(child.session_name, 6);
  // Deletion is a parent-owned RLM operation, not an observe mutation:
  await rlm.delete_subagent(child);
}
```

## API

- `await agent_observe.list_agents()` returns `current` and `agents`. Each
  agent includes active session id, session id, optional name, runtime kind,
  cwd, status, streaming state, message count, pending count, and a latest
  message preview. The list is restricted to self, parent, siblings, and direct
  children. For direct children, `await rlm.list_subagents()` also exposes
  parent-owned lifecycle handles.
- `await agent_observe.get_agent(target)` returns `agent`, where `agent`
  contains one agent summary. `target` is resolved like other live-session
  selectors: active id, session id/name, or unambiguous suffix.
- `await agent_observe.recent_messages(target, limit = 8, maxChars = 800)`
  returns up to `limit` recent bounded message previews for the target session.
  `limit` must be 1-50, and `maxChars` must be 80-2000.

## Safety

- This skill is read-only and exposes no mutation commands.
- Targets outside the nuclear family are rejected; transcript reads follow the
  same family rule as messaging.
- Message access is bounded by count and per-message character limit.
- Prefer status and recent previews for orchestration. Ask the user before
  using observed context to steer or message another session.
