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
- G: git client consolidation Batch B (cross-module commit-builder/tree-sync)
- E2: daemon trio scenario tables (15,231 -> 14,294 so far)
- S: selector boilerplate + dead-export sweep
- N: net stack SMTP/SSH delivery finalization
- T: harness rollout across big suites
- T DONE wave 1 (uncommitted->commit pending): helpers/{wait,temp,table,render,fetch}.ts canonical layer; 10 tool suites (getTextOutput x10 + temp rituals), stripAnsi x4, interactive-mode-status 5 private helpers, waitFor x10 files, fetch-stub x5 sections. Tests: ~-330 lines, production: 0. All touched suites green (web3+websearch 215 pass, interactive-status 131 pass).

## Behavior evidence policy
Each migration records which suites verify it; pre-existing baseline failures
are tracked separately and never counted as new.

## Risks / open questions
- orchestrator protocol (docs/rlm-orchestrator-spec.md): awaiting spec v2 synthesis from two adversarial reviews before implementation
- git tool surface not yet wired to agents
- IMAP/FTPS/JMAP queued behind net core landing