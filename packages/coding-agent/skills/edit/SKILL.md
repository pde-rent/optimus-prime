---
name: edit
description: Replace an exact, unique string in an existing file with `await edit(path, oldStr, newStr)` (also `edit.run(...)`). Use for targeted single-occurrence edits to files from the REPL instead of rewriting the whole file.
---

# Edit

Make a targeted edit to an existing file by replacing one exact, unique
occurrence of a string. `oldStr` must appear exactly once in the file.

Call directly from a REPL cell:

    await edit("pkg/file.ts", oldStr, newStr)

The arguments are positional: `path` (relative to cwd, absolute, or
`~`-prefixed), then the exact text to find, then its replacement. Build
`oldStr`/`newStr` from inspected file slices when the text contains backticks or
`${...}`, so a template literal does not interpolate them. Returns a short
confirmation; throws if the file is missing, or if `oldStr` is absent or matches
more than once (widen the snippet to make it unique).

`edit.run(path, oldStr, newStr)` is the same function under an explicit name.
There is no shell entry point: call it from a JS/TS cell, not a `%%bash` cell.
