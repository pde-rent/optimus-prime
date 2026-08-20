---
name: check
description: Run the project's own checker. `await check()` -> `{ ok, results }`, each result `{ checker, ok, command, exitCode, tookMs, output }`; `await check("rust")` runs one; `await check.detect()` -> what would run, without running it. A missing toolchain is skipped, not failed. Use after edits, before claiming a change builds.
---

# Check

    await check()            // every checker this project declares
    await check("rust")      // just one
    await check.detect()     // what would run, without running it

Returns `{ ok, results }`, where each result carries `checker`, `ok`, `command`,
`exitCode`, `tookMs` and `output`. `ok` is false if any checker failed.

A checker whose binary is missing reports `skipped` rather than failing, so a
polyglot repository does not go red because one toolchain is not installed.

## Why the project's own checker

It answers whether the *project* is sound. A per-file answer can be clean while
the build is broken somewhere else, which is the failure worth avoiding after an
edit. Long reports are bounded head-and-tail with a count of the omitted lines.

Every diagnostic the project currently has is reported, including ones that were
already there before you started. That is deliberate: several agents may share
one working tree, and a checker that hides what it has already mentioned would
show you a clean result on a project another agent just broke.

## This is not proof that your change works

A clean check is necessary, not sufficient. It says the project compiles and
lints; it says nothing about whether the behaviour you changed is correct. Still
exercise the path you changed and read the diff you produced.
