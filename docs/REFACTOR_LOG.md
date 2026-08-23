# REFACTOR LOG

Baseline (campaign start): 372,720 total LOC. Current: ~345,600.
Target: <=250,000 total. Numbers always reported split by category.

## Completed migrations
- models.generated compaction: 29,860 -> 1,981 generated lines, bit-for-bit expansion proof (@e80a8fb53)
- memory governance: usage tracking v2 schema, consolidation pass, budgets (@e80a8fb53 + 1caeeb1a2)
- oauth device-flow factory: 4 files -> common.ts factory (@4aaad6bf0)
- interactive decomposition wave 1: 9 modules out of the god object (@220509f74)
- tool abort/stat scaffolding collapse (@afdd9352e, 001825592)
- daemon test harness wave 1 (@0b9e70d6a)
- auth-source fingerprint + file-lock retry dedup (@001825592)
- menu selector state machine: MenuSelector<T> replaces duplicated selection/layout/windowing in extension-selector + oauth-selector; physical LOC +48 in the three files (controller API surface), semantic win = one state machine where two divergent copies existed; adopters under audit (S slice 4)

## In flight
- E2: daemon trio scenario tables (15,231 -> 14,294 so far)
- S: selector boilerplate + dead-export sweep
- N: net stack SMTP/SSH delivery finalization
- T: harness rollout across big suites

## Git client consolidation - final report (G, @ce5c657b8 + c9190da20 + 93dd7e57a)

src/core/git: 5054 -> 4740 LOC (-314, -6.2%), 20 -> 16 files, zero behavior change.
Per-file before -> after:
repository 436->516 (+lock/revision folds) | merge 707->691 (+log fold, minus serializers/conflict-staging)
remote 618->547 | transport-http 448->428 | pack-write 491->479 | objects 279->313 (+shared builders)
diff 342->378 (+writeTreeFromFiles/walkers) | stash 275->211 | branch 155->118 | rebase 196->147
reset 113->105 | refs 122->144 (+listRefNames) | worktree 88->100 (+assertNoLocalEdits/rebuildIndexFromTree)
pack-read 216->220 (+shared decoders) | index 195->187 | config 156 (untouched per instruction)
DELETED: lock.ts, revision.ts, log.ts.

Techniques: shared commit-builder (serializeCommitMessage), serializeTag,
parseCommitAt/commitTree methods (replaces 5 copies), commitParents (2),
headTreeFiles/sameTreeFile, writeTreeFromFiles (2 builders), listRefNames (2
walkers), hardResetTo->materializeTree, landMergeConflicts (4 sites),
rebuildIndexFromTree (3 sites), assertNoLocalEdits (4 sites), postService (2
POSTs), packEntryHeader+decodeOfsDistance (reader+scanner), u32Section,
concatBytes unification (3 private copies), writeFileAtomic-style dedupe via
existsSync, dead exports/functions removed (10).

Why not 3800-4000: remaining mass is dense protocol/algorithm code with no
textual duplication left (pack delta encoder/decoder, pkt-line transport,
three-way merge + recursive base, idx builder). Removing ~800 more lines means
removing capability (stash/rebase/shallow/push...) or changing bytes on the wire
- both forbidden by the hard rules. scanPack vs PackReader.resolveAt share only
structure with divergent failure contracts (lazy+idx vs sequential+diagnostics);
merged would be a parameterized hybrid - kept distinct per mission §1/§5.
config.ts untouched (tests import it directly; folding would break suites).
serializeCommit retained beside serializeCommitMessage: different trailing-
newline contracts (append-always for repository.commit round-trips vs normalize
for command layer); merging changes object bytes.

Verification: git-client 21p/0f, git-pack-write 7p/0f, git-network green on
unloaded re-runs; rotating ~12s localhost timeouts under campaign load occur on
pristine HEAD too (verified via clean worktree comparison). tsgo 0 errors in
src/core/git; biome clean. Comments touched: 0 stripped; 6 doc-comments added/
extended to document the new shared helpers.