DEBATER 2 - FINAL RECOMMENDATION (pragmatism/stability position)

DEBATE STATUS: V1 (subagent-debate-ergonomics-v1) NEVER CONTACTED ME.
Two sends failed with 'No sibling matches subagent-debate-ergonomics-v1' -
it is absent from agent_message.list_agents() roster. This recommendation
is therefore from my independent blind grading alone. No agreed list exists.

=== GRADES (P=predicts unaided, S=short, C=consistent, RC=rename cost, 1-5) ===
- rlm (namespace):        P2 S5 C3 RC5 - opaque acronym; cited in src/core/prompts/rlm.ts, src/core/rlm-runtime.ts, src/core/rlm-max-depth.ts, plus persisted memories/skills
- rlm('sub-task'):        P2 S4 C1 RC4 - magic-string dispatch on call operator; weakest name in the set
- rlm.get/set_effort:     P4 S4 C5 RC3 - good symmetric verb_noun
- rlm.get/set_max_depth, get/set_context_budget: P4 S3 C5 RC3 - clear pairs
- rlm.harness.search_memory etc.: P3 S3 C4 RC4 - 'harness' is defined jargon, chains are long but explicit
- rlm.harness.create_subagent:     P3 S3 C2 RC4 - third vocabulary for children
- agent_message.send(msg,{receiver_role}): P5 S3 C5 RC2 - self-documenting
- edit.src/edit.patch:    P3 S4 C4 RC2 - terse, skill doc carries routing
- read/write:             P5 S5 C5 n/a - gold standard; proof native verbs need zero description
- pi.diff/pi.truncateHead/Tail: P2 S3 C3 RC2 - product jargon, tiny rarely-used surface
- $, cd(), env:           P4 S5 C4 n/a - conventional shell idiom

=== KEEP-LIST (no change) ===
1. rlm namespace root - RC=5. Renaming churns system prompt text, SKILL.md files,
   persisted cross-session memories/skills citing rlm.*, and every transcript.
   Routing rides on descriptions, not etymology; the prose already teaches it.
2. rlm.get/set_effort, get/set_max_depth, get/set_context_budget - already ideal verb_noun pairs.
3. rlm.harness.* memory/skill/note CRUD - explicit and stable.
4. agent_message.send - verbose but precise; verbosity buys exactness at a trust boundary.
5. read, write, $, cd(), env - already model-native or conventional.

=== ALIAS-LIST (additive only; the single concession) ===
1. spawn() as an alias for rlm('sub-task'). Cost: small - one binding + one prompt line.
   Why here and nowhere else: the current form is a magic string inside a call operator
   (worst C score), 'spawn' sits in model pretraining distribution, and it makes the async
   contract (handle now, result via messaging) legible without reading docs.
   CONDITION: ship alias + teach ONLY spawn() in new docs; never document both side by side.
   An alias documented twice becomes two names forever.

=== RENAME-LIST (none now; one scheduled) ===
Now: none. Every candidate fails cost/benefit - highest predictability deficits are exactly
the highest-rename-cost items (rlm, harness).
Scheduled for next breaking surface change (do NOT do ad hoc): collapse the three child-
agent vocabularies - rlm.harness.create_subagent (spec), rlm('sub-task') (runtime),
rlm.list_subagents (roster) - into one consistent family, e.g. rlm.spawn/rlm.subagents.*.
Cost if done now: incompatible prompt/wire change, breaks persisted memories referencing old
names, invalidates skills mid-session. Cost if deferred near zero; inconsistency is annoying,
not blocking.
pi.* : rename not worth it; fix by strengthening its description instead. RC low but benefit lower.

=== CORE CLAIM ===
Descriptions carry routing. A model routes on the prose bound to a name, not the name's
etymology - read/write being perfect names does not mean all names must be. Stability is a
feature: every session's muscle memory, every persisted memory entry, and every skill file
is denominated in current names. Concede exactly one alias where jargon blocks comprehension
(spawn), schedule vocabulary unification for a real breaking window, rename nothing else.