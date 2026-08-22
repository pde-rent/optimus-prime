# Minimal Pure-TypeScript Git Client — Implementation Specification

Target: `packages/coding-agent/src/core/git/` in `optimus-prime`.
Zero runtime dependencies beyond `node:zlib`, `node:crypto`, and Bun built-ins
(`Bun.CryptoHasher`, `Bun.deflateSync`, `Bun.inflateSync`).

Scope: **read-mostly** client. Full object model, index read/write, refs,
status, diff, merge, smart HTTP fetch/push. No pack *writing* except what
send-pack requires (we may push existing objects verbatim; new trees/blobs/
commits are written loose).

Sources of truth:
- Official formats: <https://github.com/git/git/blob/master/Documentation/gitformat-loose.adoc>,
  `gitformat-pack.adoc`, `gitformat-index.adoc`, `gitprotocol-pack.adoc`,
  `gitprotocol-http.adoc` (verified against master at time of writing),
  plus git-scm.com/book/en/v2 ch. 10.1–10.3.
- Edge-case reference: isomorphic-git @ `main`
  (<https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/>…).

Global conventions
------------------
- All multi-byte integers in Git on-disk/wire structures are **big-endian**
  ("network byte order") unless explicitly marked little-endian (delta copy ops,
  ofs-delta offsets are a special hybrid — see §2).
- SHA-1 repository assumed throughout (SHA-256 out of scope). OID = 40 lowercase
  hex chars; raw form = 20 bytes.
- Every section lists: constants, layout/pseudocode, error cases, and
  isomorphic-git files worth reading.

---

## 1. Loose object storage

### Layout

Uncompressed payload of every loose object:

    "<type> <size-in-decimal-ascii>\0" || raw-content-bytes

Types: `blob`, `tree`, `commit`, `tag`. The whole buffer (header included) is
compressed with standard zlib (`windowBits = 15`, i.e. zlib wrapper, NOT raw
deflate) and stored at:

    $GIT_DIR/objects/<first 2 hex chars>/<remaining 38 hex chars>

OID = SHA-1 over the **uncompressed** wrapped buffer (header + content).

Example: blob containing `abc` stores `blob 3\0abc` deflated;
empty tree = `tree 0\0`.

### Pseudocode — write

```
function hashObject(type, content):
  wrapped = utf8(type) + " " + decimal(content.length) + "\0" + content
  oid = hex(SHA1(wrapped))            // Bun.CryptoHasher("sha1") or crypto.subtle
  return oid

function writeLoose(gitdir, type, content):
  oid = hashObject(type, content)
  path = gitdir/objects/oid[0..2]/oid[2..40]
  if exists(path): return oid         // immutable; identical object already there
  tmp   = path + ".tmp-" + rand       // write-then-rename, never partial objects
  write(tmp, deflate(wrapped))        // Bun.deflateSync / node:zlib.deflateSync
  mkdir -p dirname(path); rename(tmp, path)
  return oid
```

### Pseudocode — read

```
function readLoose(path):
  raw = inflate(readFile(path))       // zlib wrapper
  sp = indexOf(raw, 0x20); nul = indexOf(raw, 0x00)
  type = ascii(raw[0..sp]); size = int(ascii(raw[sp+1..nul]))
  body = raw[nul+1 ..]
  if body.length != size: throw LengthMismatch
  return { type, body }
```

### Constants & error cases
- Header separator exactly `" \0"`; size is plain ASCII decimal.
- Inflate failure ⇒ corrupt object (delete-safe: loose objects are content-
  addressed, safe to remove and re-fetch).
- Size mismatch after inflate ⇒ `InternalError` (isomorphic-git does the same).
- Do NOT create empty directory shards eagerly; harmless but noisy.
- Windows: shard dirs avoid too-many-files-per-dir problems — keep the sharding.

### isomorphic-git references
- `src/models/GitObject.js` — canonical wrap/unwrap incl. length assertion.
- `src/storage/writeObjectLoose.js`, `src/storage/readObjectLoose.js`.
- `src/utils/shasum.js` (incremental SHA-1), `src/utils/deflate.js`,
  `src/utils/inflate.js` (pako options worth mirroring: zlib wrapper mode).

---

## 2. Pack files: `.idx` v2 + `.pack`

### 2.1 `.pack` layout

    header : "PACK" | u32 version (=2; accept 3) | u32 object-count
    entries: object-count × object-entry
    trailer: 20-byte SHA-1 over ALL preceding bytes (the "pack checksum")

Object entry:

    n-byte type-and-size header
    [base-ref: 20-byte raw OID (type 7) | base-offset: offset-encoded varint (type 6)]
    zlib-compressed payload (delta data if type 6/7)

Type-and-size header (first byte):

    bit  7     : continuation (more size bytes follow)
    bits 6..4  : type  (1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta;
                       0 invalid, 5 reserved)
    bits 3..0  : low 4 bits of uncompressed size

Continuation bytes contribute 7 bits each, later bytes more significant:

```
size  = b0 & 0x0f; shift = 4
while b.continuationBitSet:
  b = next byte
  size |= (b & 0x7f) << shift; shift += 7
```

For delta types, the encoded "size" is the size of the *uncompressed delta*,
not the reconstructed object.

### 2.2 OFS_DELTA offset encoding (NOT the same as size encoding)

n bytes, all but last have MSB set. Concatenate lower 7 bits, then for
n ≥ 2 add 2⁷ + 2¹⁴ + … + 2^(7(n−1)). Equivalent closed form (isomorphic-git):

```
bytes = collected 7-bit chunks (most significant first)
offset = bytes.reduce((a, b) => ((a + 1) << 7) | b, -1)
```

Base position = (offset of the ofs-delta's own type byte) − offset. Bases are
always earlier in the pack ⇒ resolvable in one backward pass.

### 2.3 Delta payloads

Delta body:

    varint-le(source-size)      // 7-bit LSB-first groups, MSB = continue
    varint-le(target-size)
    instructions…

Instructions (first octet decides):

- `1xxxxxxx` COPY from base: bits 0–3 select presence of offset₁..₄ (LE), bits
  4–6 select size₁..₃ (LE). Absent bytes are 0. `size == 0` means **0x10000**.
  Positional semantics: omitted middle bytes do NOT shift later ones
  (`10000101 offset1 offset3` keeps offset3 at bits 16–23).
- `0xxxxxxx` INSERT: append the next `xxxxxxx` literal bytes (non-zero).
- `00000000` reserved ⇒ error.

### 2.4 REF_DELTA resolution

Base identified by 20-byte OID which may live outside the pack ("thin pack",
legal only over-the-wire). Resolution algorithm:

```
readAt(offset):
  parse type/size header at offset
  if type ∈ {commit,tree,blob,tag}: inflate payload; done
  if type == OFS_DELTA:
      rel = decodeOffset(); base = readAt(offset - rel)
      return applyDelta(inflate(delta), base.body)          // type inherited
  if type == REF_DELTA:
      oid  = 20 raw bytes; base = lookupEverywhere(oid)     // other packs, loose
      return applyDelta(inflate(delta), base.body)
```

Guard recursion depth (isomorphic-git counts `readDepth`; cap ≈ 50 and treat
exceeding as corrupt/cyclic pack). Cache resolved (offset → object) results.

### 2.5 `.idx` v2 layout (all u32 big-endian)

    "\377tOc"            4-byte magic  = FF 74 4F 63  (hex string "ff744f63")
    u32 = 2              version
    fanout[256]          cumulative counts; fanout[255] = N
    oid[N]               20-byte OIDs, ascending lexicographic
    crc32[N]             CRC-32 (zlib polynomial) of each packed object
                         INCLUDING its header and delta base reference bytes
    offset[N]            u31 pack offsets; MSB set ⇒ index into 64-bit table
    large-offsets[]      u64 entries (absent when pack < 2 GiB)
    pack-checksum        copy of the .pack trailer (20 bytes)
    idx-checksum         SHA-1 of everything above (20 bytes)

Lookup: binary search fanout[oid₀] range in oid table, then map row → offset.

### 2.6 Trailer checks
- On first open of a pack: verify pack trailer == idx-stored pack checksum, and
  (optionally, once) SHA-1 of pack[0..len−20] equals it. Verify once per pack
  per process, cache the flag (isomorphic-git `_checksumVerified`).
- CRC32 per object is for repack integrity; skip verifying on read (cost), but
  compute it when building idx ourselves.
- Reject packs > 2 GiB unless the 64-bit offset table is implemented.

### Error cases
- Bad magic/version in either file ⇒ unsupported, fall through to next pack.
- Missing `.pack` paired with an `.idx` ⇒ error naming the path.
- Unknown type nibble (0 or 5) ⇒ corrupt pack.
- REF_DELTA base missing everywhere ⇒ corrupt/incomplete fetch; surface as such.

### isomorphic-git references
- `src/models/GitPackIndex.js` — both varint decoders, idx v2 read/write,
  pack scan (`fromPack`), `readSlice` recursion, depth tracking.
- `src/utils/git-list-pack.js` — streaming pack entry walker.
- `src/utils/applyDelta.js` — exact delta interpreter incl. the `0x10000`
  quirk and positional offset/size bits.
- `src/storage/readObjectPacked.js` — pack iteration order, trailer +
  payload double-check, `getExternalRefDelta` hook for thin packs.

---

## 3. Index (dircache) v2 binary format

### 3.1 File layout

    header : "DIRC" | u32 version (=2) | u32 entry-count
    entries: sorted by path (memcmp byte order; ties broken by stage)
    extensions: signature(4) | u32 size | data
                first byte A..'Z' ⇒ optional, IGNORE unknown ones safely
    trailer: SHA-1 of everything before it (20 bytes)

### 3.2 Entry layout (62 fixed bytes + path + padding)

| field            | size | notes                                              |
|------------------|------|----------------------------------------------------|
| ctime sec/nsec   | 4+4  | stat                                               |
| mtime sec/nsec   | 4+4  | stat                                               |
| dev, ino         | 4+4  | stat (0 when unknown/not tracked for reuse)        |
| mode             | 4    | high 16 unused; 4-bit obj type (1000 regular, 1010 symlink, 1110 gitlink); 9-bit unix perm — only 0755/0644 valid |
| uid, gid         | 4+4  |                                                    |
| size (truncated 32-bit) | 4 |                                                 |
| oid              | 20   | raw                                                |
| flags            | 2    | b15 assume-valid · b14 extended (must be 0 in v2) · b13–12 stage · b11–0 name length (0xFFF sentinel if ≥ 0xFFF) |

Then: path bytes (UTF-8), 1–8 NUL bytes so that the entry length is a multiple
of 8 **including** the 12-byte header contribution:

    entryLen = ceil((62 + pathLen + 1) / 8) * 8

Parse padding defensively: every pad byte must be 0x00 (isomorphic-git throws
otherwise — keep that, it catches desync bugs early).

### 3.3 Extensions

We READ v2 indexes written by real git, so tolerate at least:
- `TREE` (cached tree — see below), `REUC` (resolve-undo), `EOIE`/`IEOT`
  (hash/offset tables), `link`, `UNTR`, `FSMN`, `sdir` — all optional; skip by
  signature+size without interpreting.
- If version is 3: honor the 16-bit extended flags word following flags when
  the extended bit is set (intent-to-add, skip-worktree). If version > 3 or
  version 4 (path compression): **do not silently mis-parse**; either implement
  v4 read or fail loudly. Recommendation: support v2/v3 read, rewrite as v2.

### 3.4 TREE cache extension

Signature `TREE`. Sequence of records, top-down depth-first (root first):

    NUL-terminated path component (relative to parent; "" for root)
    ASCII decimal entry_count SP ASCII decimal subtree_count LF
    20-byte oid                                  // absent when invalidated

Invalidated record: `entry_count = -1` (write literally "-1"), no oid, next
record starts right after the LF. We may DROP the whole TREE extension on
rewrite (always legal — it is a cache) or preserve valid subtrees. Simplest
correct v1: drop it; git rebuilds it lazily. Cost: none for correctness.

### 3.5 When git rewrites the index (and when we may)
- Any stage-0 change: add/rm/commit/reset/checkout/merge resolution.
- Protocol: write `$GIT_DIR/index.lock` (O_CREAT|O_EXCL), fsync, `rename` onto
  `index`. If the lockfile exists and is stale (> e.g. 5 s old with no owning
  process), refuse by default.
- Readers must treat `index.lock` as nonexistent; never block on it.
- After ANY mutation of entries, recompute the trailing SHA-1; a wrong
  checksum makes real git consider the repo corrupted.

### Error cases
- Empty file, bad magic, bad checksum, version ∉ {2,3}, path length < 1,
  non-zero pad byte, `..` inside a path component ⇒ reject (isomorphic-git
  raises `UnsafeFilepathError` for `../`-style entries — mirror it).

### isomorphic-git references
- `src/models/GitIndex.js` — complete v2 codec, flag packing, stage handling,
  the 8-byte alignment arithmetic, `entriesFlat` for conflicted staging.
- `src/managers/GitIndexManager.js` — lockfile + save-on-dirty discipline.
- `src/utils/normalizeStats.js`, `src/utils/comparePath.js`.

---

## 4. Refs

### 4.1 Loose refs
- One file per ref under `$GIT_DIR/refs/<namespace>/<name>`; contents =
  40-hex OID + `\n`, OR `ref: <target>\n` for a symbolic ref.
- Write atomically (lockfile + rename), same discipline as the index.

### 4.2 packed-refs
- `$GIT_DIR/packed-refs`, plain text:
  - header comment line: `# pack-refs with: peeled fully-peeled sorted \n`
  - records: `<40-hex oid> SP <full refname> LF`
  - peeled annotated-tag records immediately follow their tag:
    `^<40-hex commit-oid> LF` (modelled by isomorphic-git as key `ref^{}`)
- Precedence: **loose shadows packed**. Resolution order: loose file →
  packed-refs map → recurse into `ref:` targets with cycle detection.
- Deletion of a packed ref = rewrite packed-refs minus the line (+ delete any
  loose shadow).

### 4.3 HEAD
- Usually symbolic: `ref: refs/heads/<branch>`.
- Detached: contains a raw OID.
- Branch tip resolution = fully resolve HEAD's symref chain (cap depth, say
  10, against cycles).

### 4.4 Symbolic refs elsewhere
- `refs/remotes/<remote>/HEAD`, `ORIG_HEAD`, `MERGE_HEAD` (during merges),
  `FETCH_HEAD` — read as ordinary refs; MERGE_HEAD may contain multiple OIDs
  (octopus) — v1 can refuse >1 parent for merge.

### 4.5 Reflog (read-only for us)
- `$GIT_DIR/logs/<ref>` (and `logs/HEAD`); one record per line:

      <old-40hex> <new-40hex> <name> <email> <unix-time> <tz-offset>\t<message>\n

  e.g. `0000…  a1b2… Derp A <d@x> 1720000000 +0530	commit: msg`
- Parse tab-separated message loosely; missing logs/<ref> ⇒ no history (fresh
  branch). Never write reflogs in v1 (real git appends when
  `core.logAllRefUpdates`; absence is legal and git tolerates it).

### Error cases
- Ref name validation: reject names with `~^:?*[`, `..`, `@{`, component
  starting with `.", ending with `.lock` (see git-check-ref-format). Guard
  writes that could land on repo files (`index`, `config`, …) — isomorphic-git
  `assertWritableRef` exists precisely because a hostile refspec could target
  `.git/index`.
- Ambiguous short names: try `<name>`, `refs/<name>`, `refs/tags/<name>`,
  `refs/heads/<name>`, `refs/remotes/<name>`, `refs/remotes/<name>/HEAD` in
  that order (isomorphic-git `refpaths` mirrors git-rev-parse).

### isomorphic-git references
- `src/managers/GitRefManager.js` — resolution order, packed-refs interplay,
  `assertWritableRef`, prune logic.
- `src/models/GitPackedRefs.js` — parser preserving original lines for
  lossless rewrite.

---

## 5. Object grammar: commit / tree / blob / tag

### blob
Opaque bytes. No grammar.

### tree
Sequence of records:

    ASCII octal mode (NO leading zeros) SP name NUL raw-20-byte-OID

Modes: `100644`, `100755`, `120000` (symlink), `160000` (gitlink/submodule),
`40000` (directory, serialized WITHOUT leading zero as `40000`). Sorting is
NOT plain memcmp: compare names as if directories had a trailing `/`
(isomorphic-git `compareTreeEntryPath.js`). Getting this wrong breaks round-
tripping (git would rewrite the tree with a different hash).

### commit

    tree <40hex>
    parent <40hex>            // 0..n lines, in order
    author <name> <email> <ts> <tz>
    committer <name> <email> <ts> <tz>
    [encoding <charset>]      // rare
    [gpgsig -----BEGIN ...]   // multi-line, continuation lines start with SP
    [other headers…]          // e.g. mergetag
    \n
    <free-form message>

Header parsing must treat a line beginning with a space as a continuation of
the previous header (needed for gpgsig). Author/committer grammar:
`name SP <email> SP ts SP tz` where tz is `+HHMM`/`-HHMM`/`Z`-style forms;
names may contain almost anything except the delimiters — parse from the END
(`<ts> <tz>` then trailing `<email>`) rather than splitting from the front
(isomorphic-git `parseAuthor.js` does end-anchored regex).

### annotated tag

    object <40hex>
    type <commit|tree|blob|tag>
    tag <tagname>
    tagger <name> <email> <ts> <tz>
    \n<message>

Peeled value = dereference `object` until non-tag.

### Commit-graph: skipping is SAFE (verification note)
The commit-graph files (`objects/info/commit-graph`, `…/graphs/*.graph`) are
pure acceleration caches: precomputed generation numbers, parent lists, bloom
filters. Everything in them is derivable from the commit objects themselves,
so a client that parses commits straight from object storage computes an
identical DAG — only slower. Correctness caveat: generation numbers matter
only as pruning heuristics inside git's own algorithms; our merge-base walker
(§8) uses plain ancestry, which needs nothing but `parent` headers.
Two genuine behavioral gaps exist and are independent of commit-graph:
- `refs/replace/` (object substitution) — not implemented; we see original
  objects. Rare in practice.
- `info/grafts` — deprecated, ignored.
Conclusion: never read or write commit-graph; do not assume its presence; do
not fail if it exists (just ignore those files).

### isomorphic-git references
- `src/models/GitCommit.js` (header/body split, author parse/format),
  `src/models/GitTree.js` (entry codec + sort order),
  `src/models/GitAnnotatedTag.js`, `src/utils/parseAuthor.js`,
  `src/utils/formatAuthor.js`, `src/utils/compareTreeEntryPath.js`.

---

## 6. Status computation (HEAD-tree vs index vs worktree)

Three-way comparison, exactly what `git status` reports:

| comparison            | meaning                          |
|-----------------------|----------------------------------|
| HEAD tree ↔ index     | staged changes                   |
| index ↔ worktree      | unstaged changes                 |
| worktree ∉ index      | untracked (subject to ignores)   |
| index has stages 1–3  | unmerged/conflicted paths        |

### Algorithm
```
headFiles = flattenTree(resolveHead())          // path -> {mode, oid}
idxFiles  = readIndex(stage 0 entries)          // path -> {mode, oid, stats}

// staged
for path in union(headFiles, idxFiles):
  only-head ⇒ deleted(staged); only-index ⇒ added(staged);
  else mode!=mode or oid!=oid ⇒ modified(staged)

// unstaged — stat-cache fast path first
for path, entry in idxFiles (stage 0):
  st = lstat(worktree/path)
  missing ⇒ deleted(unstaged)
  if !statEqual(entry.stats, st):           // cheap gate, compareStats()
      oid = hashBlob(readFile)              // expensive confirmation
      oid != entry.oid or modeChanged ⇒ modified(unstaged)
  else: unchanged

// untracked: walk worktree (respecting ignores), subtract idxFiles
```

Stat-equality gate (from racy-git §4, mirrored in isomorphic-git
`compareStats`): equal iff `mode && mtime && ctime && uid && gid && ino &&
size` all match (`core.filemode=false` drops mode; on case-insensitive fs /
network mounts drop `ino`). On mismatch you MUST hash the content before
reporting modified — stat alone is advisory. Racy timestamps (file mtime ==
index write time) force hashing too; simply always hashing when the gate fails
covers this.

Type changes (file↔symlink↔dir) report as delete+add. Rename detection OFF for
v1: deletions and additions stay separate rows.

Conflict representation: index carries stage 1 (base), 2 (ours), 3 (theirs)
entries for the same path; status shows "both modified".

### Ignore rules for untracked listing
Reuse the existing repo matcher (`src/utils/ignore-matcher.ts` +
`addIgnoreRules` from `src/core/ignore-rules.ts`); see §10 for coverage and
gaps.

### isomorphic-git references
- `src/api/statusMatrix.js` + `src/commands/statusMatrix.js` — the three-way
  matrix ("0", "1", "2", "3" cells) is the cleanest known formulation.
- `src/utils/modified.js`, `src/utils/compareStats.js`,
  `src/models/GitWalkerFs.js`, `GitWalkerIndex.js`, `GitWalkerRepo.js`.

---

## 7. Diff algorithm choice

Requirement: blob-level line diffs for two surfaces —
(a) tree-to-tree (HEAD vs index / commit vs commit) and
(b) index-to-worktree.

**Recommendation: histogram diff** (JGit `HistogramDiff`, git `--histogram`)
for both surfaces, with these reasons at our scale (agent operating on repos of
~10⁴–10⁵ files, individual blobs ≤ a few MB):
- O(N·D) typical, worst case bounded better than naive Myers' O((N+M)²) space
  behavior on degenerate inputs (huge repeated boilerplate — common in
  generated code, lockfiles).
- Anchors on unique common lines ⇒ hunks align to real edits; far fewer
  nonsensical brace-juggling hunks than classic Myers. Better UX when we feed
  diffs to an LLM context.
- Deterministic output regardless of input direction (classic Myers output
  depends on traversal order).

Fallback: plain Myers O(ND) linear-space (the GNU-diff algorithm) is acceptable
if histogram proves complex; correctness is equivalent, only hunk aesthetics
and worst-case differ. Do NOT implement patience-only: it fails (needs
fallback) when no unique common lines exist — histogram is patience with a
guaranteed Myers-style fallback, which is why it wins.

Implementation shape: LCS on lines (never bytes); pre-hash lines to u32 for
the element-compare table. Post-process into hunks with 3 lines of context.
Binary detection: NUL byte in first 8 KiB ⇒ emit "binary files differ"
(isomorphic-git `utils/isBinary.js` heuristic).

---

## 8. Merge

### Merge base(s)
Walk ancestors of both tips with parallel BFS walkers, recording visit counts
(isomorphic-git `_findMergeBase`: N walkers, count passages; a commit visited
by all walkers whose descendants were all visited is a common ancestor; take
the maximal set). Output: one or more bases.

### Recursive-base simplification
```
function mergeBaseRecursive(a, b):
  bases = findMergeBases(a, b)
  if bases.length == 0: return null                    // unrelated histories
  if bases.length == 1: return bases[0]
  // multiple bases: pairwise-merge the bases (virtual base construction)
  virtual = bases[0]
  for i in 1..bases.length-1:
      virtual = makeVirtualMergeCommit(virtual, bases[i])   // tree-level only
  return virtual
```
One base ⇒ plain 3-way. Multiple bases ⇒ recursive strategy: merge the bases
into a virtual tree (recursively, same rule), then 3-way against that virtual
base. Virtual commits are in-memory only (no objects written). Cap recursion
(e.g. depth 8) and degrade to taking the first base — matches git's behavior
of falling back rather than looping.

### Tree merge
Per-path 3-way on (mode, oid) triples (base, ours, theirs):
- ours == theirs ⇒ take it; base == ours ⇒ take theirs; base == theirs ⇒ take ours.
- All differ ⇒ content merge (below) when both sides are blobs; otherwise conflict.
- Present on one side, deleted on the other ⇒ modify/delete conflict.

### Content merge (conflict markers)
diff3-style line merge. Marker width 7 (isomorphic-git `mergeFile.js`):

    <<<<<<< <ourLabel>
    <our lines>
    =======
    <their lines>
    >>>>>>> <theirLabel>

Non-conflicting hunks interleave cleanly; conflicting regions get the marker
block. Labels default to ref names/paths (`ours`/`theirs` acceptable v1).
Result flagged `cleanMerge=false`; conflicted paths recorded as index stages
1/2/3 and working-tree files get markers.

### Error cases
- Unrelated histories without explicit allow flag ⇒ refuse (match git default).
- MERGE_HEAD already present ⇒ "you have not concluded your merge".
- Binary or symlink conflicts ⇒ never textually merge; mark conflicted.
- D/F conflicts (file vs directory same name) ⇒ detect at tree-write time.

### isomorphic-git references
- `src/commands/findMergeBase.js` / `src/api/findMergeBase.js` — the
  multi-walker visit-count algorithm (documented as matching
  `git merge-base --all --octopus`).
- `src/utils/mergeFile.js` — diff3 merge + exact marker emission
  (markerSize = 7).
- `src/utils/mergeTree.js`, `src/commands/merge.js`, `src/api/abortMerge.js`,
  `src/errors/MergeConflictError.js`, `src/errors/UnmergedPathsError.js`.

---

## 9. Smart HTTP transport

### 9.1 pkt-line framing
- Data packet: 4 lowercase-hex digits = TOTAL length including the 4 itself,
  then payload. Max payload 65516 (total 65520). Non-binary lines SHOULD end
  with LF; receivers strip optionally.
- `0000` flush-pkt · `0001` delim-pkt (protocol v2) · `0004` empty packet
  (SHOULD NOT be sent; distinct from flush!).

```
encode(line)  = hex4(line.len + 4) || line
read(): len = parseInt(hex4, 16)
        len == 0 ⇒ FLUSH;  len == 1 ⇒ DELIM; else read(len - 4) bytes
```

### 9.2 Discovery: GET `{url}/info/refs?service=git-upload-pack`
- Request headers: optional `Authorization: Basic ...`; for protocol v2 add
  `Git-Protocol: version=2`. Add `no-cache` semantics (Cache-Control pragma)
  as git-http-protocol advises.
- Success response: `Content-Type: application/x-git-upload-pack-advertisement`
  (receive side: `application/x-git-receive-pack-advertisement`).
- Body: pkt-line `# service=git-upload-pack\n` → flush `0000` → ref
  advertisement: first line `<oid> SP <refname> NUL <capabilities>\n`
  (capabilities ride behind NUL on the FIRST advertised ref only; when the
  repo is empty: `<zero-oid> SP capabilities^{} NUL caps`), subsequent refs
  without NUL. Sorted by refname; `HEAD` first when valid. Peeled tags appear
  as `<ref>^{}` immediately after the tag.
- Wrong content-type ⇒ likely dumb server or HTML login page: capture body for
  the error message (isomorphic-git `SmartHttpError` pattern).
- 401 (also Azure's bogus 203) ⇒ run auth callback/retry once; 200 after
  provided-auth ⇒ success hook.

### 9.3 fetch-pack: POST `{url}/git-upload-pack`
Request headers: `Content-Type: application/x-git-upload-pack-request`,
`Accept: application/x-git-upload-pack-result`.

Body (v0/v1):

```
want <oid>[ capabilities…]\n     // FIRST want only carries capabilities
want <oid>\n                     // deduplicated
[shallow <oid>\n | deepen <n>\n | deepen-since <ts>\n | deepen-not <ref>\n]
0000                              // flush ends the want list
have <oid>\n                      // local tips we already have (up to 32/batch)
[have …]
done\n                            // terminates negotiation
```

Response: pkt-line stream — `shallow/unshallow` lines (if deepening),
then ACK/NAK negotiation:
- `ACK <oid> continue` per common commit (multi_ack modes),
- `NAK` after flush when nothing common yet,
- final `ACK <oid>` (common found) or `NAK` after `done`,
then the packfile — side-band-64k multiplexed when that capability was
requested: each pkt-line = 1 sideband byte + up to 65519 data bytes;
sideband `1` = pack data, `2` = progress (stderr), `3` = fatal error (abort,
surface the text). Demuxer feeds three channels; a sideband-3 kills the
transfer (isomorphic-git destroys the packfile FIFO).

Minimal viable negotiation: send ALL local ref oids as haves in batches of 32
with flush between, read ACK/NAK until `done`-response; or the trivial
one-shot (haves + `done` together) — servers accept it, at the cost of larger
packs. v1 capability set we advertise: `multi_ack multi_ack_detailed
side-band-64k thin-pack ofs-delta agent=<agent>` (omit what we don't
implement; `ofs-delta` lets the server use smaller packs — we DO implement
ofs-delta, so request it).

Feed received pack through §2 machinery; write `.pack`+`.idx` pair
(pack-<sha>.pack named by its own trailer checksum) or explode to loose
objects (simpler v1: explode; still legal).

### 9.4 send-pack: POST `{url}/git-receive-pack`
Discovery via `GET /info/refs?service=git-receive-pack`. Then POST with
`Content-Type: application/x-git-receive-pack-request`:

```
<old-oid> SP <new-oid> SP <refname> NUL <capabilities>\n   // first command only
<old-oid> SP <new-oid> SP <refname>\n                       // more commands
0000
[PACKFILE — raw, NOT side-band muxed; zero-id "old" creates, all-zero "new" deletes]
```

Capabilities: `report-status` (ask for it), `delete-refs`, `ofs-delta`,
`atomic` (optional), `agent=`. Response (with report-status):
`unpack ok\n` then `ok <ref>\n` / `ng <ref> <reason>\n` per command, flush,
then optional side-band progress. Treat `ng` as push rejection; propagate reason.

Force-push safety: client compares advertised old-oid against actual current
value; mismatch ⇒ refuse unless forced (prevents clobbering).

### 9.5 Auth & misc
- Basic auth header from credentials or URL userinfo (strip userinfo from URL
  before requests — isomorphic-git `extractAuthFromUrl`).
- Token auth = Basic with username `x-access-token` / token-as-password
  (GitHub) or bare token (GitLab PAT) — just produce `Authorization` headers;
  never implement challenge flows.
- Redirects: follow for GET; POST bodies need re-sending — rely on fetch
  redirect handling for GET only.
- Timeouts + abort: wrap fetch with AbortController.

### isomorphic-git references
- `src/models/GitPktLine.js` (codec + stream reader), `src/models/GitSideBand.js`
  (demux with sideband 1/2/3 routing), `src/managers/GitRemoteHTTP.js`
  (discovery, content-type handling, 401/203 auth retry loop),
  `src/wire/writeUploadPackRequest.js`, `parseUploadPackResponse.js`,
  `parseRefsAdResponse.js`, `writeReceivePackRequest.js`,
  `parseReceivePackResponse.js`, `src/utils/filterCapabilities.js`,
  `calculateBasicAuthHeader.js`, `extractAuthFromUrl.js`.

---

## 10. Config + ignore rules

### 10.1 INI parsing (git-config syntax)
Files: `$GIT_DIR/config`, then user `~/.gitconfig` (+ `$XDG_CONFIG_HOME/git/config`);
precedence: repo overrides user overrides system. Within one file, LAST value
wins for scalar gets.

Grammar essentials:
```
[section]                        // section: alnum + '-' + '.', case-INSENSITIVE
[section "subsection"]           // subsection: case-SENSITIVE, double-quoted
[name]                           // boolean true implied
[name = value]                   // value may be quoted; \-escapes inside quotes
# or ; comment                   // to end of line
[line continuation]              // trailing backslash
```
Key lookup is `section.name` or `section.subsection.name`; section and variable
names fold to lowercase, subsections don't. Multi-valued keys (e.g.
`remote.origin.fetch`) need getAll semantics.

Value coercion (mirror config.c, as isomorphic-git `GitConfig.js` does):
- bool true: `true|yes|on` (or bare); false: `false|no|off`; numeric suffixes
  k/m/g multiply by 1024ᵏ.
- Errors: unterminated quotes/sections ⇒ parse error naming file+line.

Writes: append/set with minimal disruption (isomorphic-git rewrites the file
via its parsed structure; acceptable). Never write while holding another
repo-wide lock.

### 10.2 Existing ignore matcher vs gitignore(5) — verified coverage

Repo matcher: `packages/coding-agent/src/utils/ignore-matcher.ts`;
loader: `packages/coding-agent/src/core/ignore-rules.ts`
(files: `.gitignore`, `.ignore`, `.fdignore`).

Covered correctly:
- comments, blank lines, trailing-whitespace trimming (incl. escaped `\`
  protection);
- `!` negation with last-match-wins; escaped `\#` / `\!` at start;
- anchoring (leading `/`, or any interior `/) vs basename-anywhere patterns;
- trailing `/` = directory-only (files of the same name unaffected);
- `*`/`?` never cross `/`; whole-segment `**/`, `/**/`, trailing `/**`;
- character classes incl. `[!…]` negation, unmatched `[` stays literal;
- excluded-directory-wins semantics (a file under an excluded dir cannot be
  re-included) — implemented as ancestor check in `ignores()`, which also
  reproduces git's "deeper .gitignore inside an excluded dir is unreadable"
  outcome;
- loader rewrites nested-`.gitignore` patterns relative to repo root, so one
  flat matcher emulates per-directory scoping.

Gaps (acceptable for v1; document, don't fix silently):
1. General backslash escapes inside patterns (`\*`, `\?`, escaped spaces)
   are NOT unescaped — `\*` currently matches a literal backslash followed by
   wildcard. Real-world impact low; hit only with exotic filenames.
2. POSIX bracket classes (`[[:alpha:]]`) not supported (would match literally).
3. Case sensitivity fixed ON (ignores `core.ignoreCase`).
4. Loader reads `.ignore`/.fdignore alongside `.gitignore` — broader than git
   (fine for our tooling, wrong if we ever need git-exact parity).
5. No `$GIT_DIR/info/exclude` / `core.excludesFile` global excludes — the
   status code must add those two sources explicitly (same matcher, extra
   `addIgnoreRules` calls; precedence order global → info → per-dir, deeper
   files later so they win).
6. Per-directory negation nuance: because rules are flattened at load time,
   a pattern negated in a sub-directory file must be loaded AFTER the root
   file's rules (loader call order = shallow→deep) — keep that invariant.

### isomorphic-git references
- `src/models/GitConfig.js` — full grammar incl. regexes for sections/variables
  and config.c-faithful bool/num coercion; `src/managers/GitConfigManager.js`
  (file layering). Ignore handling: `src/managers/GitIgnoreManager.js` +
  `src/api/isIgnored.js` (note: isomorphic-git tests ignore-file stacking
  order; useful test corpus).

---

## Appendix: module map proposal

```
packages/coding-agent/src/core/git/
  objects.ts        // §1 wrap/hash/read/write loose; zlib via Bun/node
  pack.ts           // §2 idx v2 + pack read, deltas
  index.ts          // §3 dircache v2 codec + lockfile writer
  refs.ts           // §4 loose/packed/symref/reflog-read
  grammar.ts        // §5 commit/tree/tag codecs
  status.ts         // §6 three-way status matrix
  diff.ts           // §7 histogram diff
  merge.ts          // §8 base finding + 3-way/diff3 + markers
  http.ts           // §9 pkt-line, sideband, discovery, fetch/send
  config.ts         // §10 INI
```

Test strategy (no new framework): fixture repos generated by the real `git`
binary checked into `__fixtures__`, plus round-trip property checks
(write→read equality) and golden hashes (empty blob/tree/commit well-known
oids: e.g. empty blob `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, empty tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
