# Tracking upstream

This fork diverged hard — Python removed, one Bun REPL instead of a kernel, Bun-only toolchain.
Upstream keeps fixing real bugs in code we still share. Neither of our upstreams reaches us on
its own, so this is a standing routine, not a one-off.

## Two upstreams, two mechanisms

| upstream | remote | relationship | how changes arrive |
|---|---|---|---|
| PrimeIntellect-ai/optimus | `optimus` | shares our history | `git merge optimus/main`, then resolve |
| earendil-works/pi | `pi` | **no shared history** | hand-port only |

The second one is the trap. optimus **vendors** pi's source — `packages/coding-agent` *is* a
copy of `@earendil-works/pi-coding-agent`. A pi fix reaches us only when optimus re-vendors
it, or when we port it ourselves. pi has also moved 0.7.2 → 0.84.2 and restructured, so a growing
share of its commits land in files we do not have.

## The routine

```sh
bun scripts/upstream-report.ts          # what is new since last triage, hot areas starred
bun scripts/upstream-report.ts --mark   # record these as triaged once you have judged them
```

The ledger (`docs/upstream-sync-ledger.json`) stores the last triaged head per upstream, so the
report only ever shows work nobody has looked at. Commits touching areas we rewrote — compaction,
context, tokens, cache, session, daemon, snapshot, REPL, prompts, credentials — are starred,
because those are simultaneously the most likely to matter and the least likely to apply cleanly.

Cadence: weekly, and before any release.

## Triage

Classify every commit or PR into one of four, and write down which:

- **PORT** — a real fix that applies to us. Note where it lands in our tree, and whether it
  applies cleanly or needs translating (a Python/kernel fix often has an exact analogue in the
  Bun REPL).
- **N/A** — Python or kernel specific, or in code we deleted. **Check the underlying bug before
  dismissing it**: a Python-specific fix frequently describes a logic error we faithfully
  reimplemented in JavaScript.
- **CONFLICTS** — touches code we rewrote in a way that makes porting risky. Record the collision
  rather than forcing it.
- **SKIP** — cosmetic, or against our direction (reintroducing Python, adding npm/node tooling).

Security and data-loss fixes are triaged first and ported even when awkward.

## Rules learned the hard way

- **Upstream PRs carry their own defects.** Observed: one double-counts cost and breaks
  component/total consistency, one has its rate maths wrong twice, one ships no migration and
  orphans worker descriptors, one reorders an auth check and kills bearer-token overrides. Read
  the diff; do not port on the strength of the title.
- **Sequencing matters.** Some PRs depend on a rename or a schema bump in another. Two separate
  ones both bump the same schema version. Merge order is part of the port.
- **A fix in deleted code is still a signal.** We inherited the logic, so we usually inherited
  the bug.
- **Keep the merge base.** The shared history with optimus is what makes its fixes a merge
  instead of a manual reapplication. Do not squash it away for tidiness.
- **Watch for recurring conflicts.** If the same file conflicts every sync, that is a standing
  divergence to resolve at the source, not to re-resolve monthly. The trimmed provider catalogue
  was one of these.
- **optimus closed its issue tracker** on 2026-08-15 and moved to Discussions. The
  substantive bug reports are in the closed pile; search it, not just the open list.
