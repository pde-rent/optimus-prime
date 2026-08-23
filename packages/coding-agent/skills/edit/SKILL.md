---
name: edit
description: Use for existing-file edits, replacing sed gymnastics and whole-file rewrites. `await edit(path, oldStr, newStr)` swaps one unique string; pass `edit(path, [[old, new], ...])` to apply several at once. Line-addressed work goes through `edit.src(path)` then `edit.patch(path, tag, hunks)`, which rejects stale anchors. New files need write, not edit.
---

# Edit

Two entry points, for the two things you know when you want to change a file.

## `await edit(path, oldStr, newStr)`

Replace one exact, unique occurrence. Needs no prior read. `oldStr` must appear
exactly once; widen the snippet if it does not. Best when you know the text but
not the line, and when the hunk is small.

    await edit("pkg/file.ts", oldStr, newStr)

Pass an array of pairs to apply several replacements in one call - one read,
one diff, one write:

    await edit("pkg/file.ts", [
      ["const foo = 1;", "const foo = 2;"],
      ["import { bar }", "import { bar, baz }"],
    ])

Each old string must be unique in the file as it stands when its pair runs -
earlier pairs of the same call are already applied.

## `await edit.src(path, from?, to?)` then `await edit.patch(path, tag, hunks)`

`edit.src` prints the file with line numbers behind a header:

    [pkg/file.ts#3F38]
    1:function greet(name) {
    2:  const msg = 'hi ' + name;

`3F38` is a tag: a short hash of the whole file. Pass it back to `edit.patch`,
which refuses the edit if the file no longer hashes to it. That is what makes
line numbers safe — a stale anchor is rejected instead of silently corrupting
code, and the rejection tells you the current tag and the text now sitting at
each anchor, so you can usually retry without re-reading.

    const tag = "3F38";
    await edit.patch("pkg/file.ts", tag, [
      { at: [2, 3], text: "  console.log(`hi ${name}`);" },  // replace lines 2-3
      { after: 4, text: "greet('there');" },                  // insert after line 4
      { at: [9, 9] },                                         // delete line 9
    ]);

- `{ at: [a, b], text }` replaces original lines `a` through `b`, inclusive.
- `{ at: [a, b] }` with no text deletes them.
- `{ after: n, text }` inserts after line `n`; `after: 0` inserts at the head.

Every number indexes the tagged snapshot, so numbers **never shift between hunks
in the same call** — describe every change against what `edit.src` printed. Hunks
may not overlap, and the whole call is rejected if any hunk is invalid.

`edit.patch` returns the new tag, so a chain of edits needs one read, not one per
edit. A range windowed with `from`/`to` still returns the whole-file tag.

## Rules

- Keep ranges tight: name only the lines you are changing. Never widen a range
  over lines you intend to keep — they would be deleted and retyped.
- Use `after:` for pure insertion rather than replacing a line with itself plus
  more, which costs twice the tokens and risks dropping the line you retyped.
- A patch that changes nothing is an error, not a warning. It means the anchor is
  wrong, so re-read rather than widening the payload.
- The tag ignores trailing whitespace, so a formatter run does not invalidate it.
  Any other change does.
- There is no shell entry point: call these from a JS/TS cell, not a `%%bash` cell.
