# Network Stack — Implementation Specification

Target: `packages/coding-agent/src/core/net/` in `optimus-prime`.
Companion to `docs/git-client-spec.md`.

Scope: SSH, FTPS (explicit + implicit TLS), SMTP, IMAP, JMAP as first-class
agent capabilities: run commands on remote hosts, move files over FTP(S),
send and read mail.

Non-goals: SOCKS/HTTP proxying, SSH tunneling APIs beyond what the system
client already offers, full MIME composition/parsing libraries, CalDAV/WebDAV,
POP3.

---

## 0. Design constraints

1. **Zero npm dependencies.** Everything is Bun built-ins, `node:net`/`node:tls`
   where a Bun primitive cannot do the job, and `fetch` for HTTP-based
   protocols.
2. **SSH is NOT pure TypeScript.** SSH2 wire crypto (curve25519, chacha20,
   host-key verification, KEX) is a multi-thousand-line security surface we do
   not want to own or audit. The client spawns the **system `ssh` binary** as a
   subprocess pipe — the same philosophy as the clipboard using `osascript`
   (`packages/coding-agent/src/utils/clipboard-image.ts`): delegate to the
   platform's maintained implementation.
3. **Everything else is a thin protocol speaker.** FTPS, SMTP and IMAP are
   line-oriented request/response protocols over TCP/TLS; they share one
   primitives layer and differ only in grammar. JMAP is JSON-over-HTTP.
4. **One tool per protocol family**, typed op enums (same pattern as the git
   tool plan), house factory pairs, TypeBox schemas with
   `additionalProperties: false`.
5. Every protocol module stays **under ~1200 lines** by limiting the op
   surface, not by compressing style. Estimates per module in §7.

---

## 1. Module map

```
packages/coding-agent/src/core/net/
  core.ts        // §2 shared primitives: tcpConnect, starttls, LineProtocol,
                 //    CredResolver, errors, timeouts
  ssh.ts         // §3 subprocess-pipe SSH (system ssh / scp)
  ftp.ts         // §4 FTP + FTPS client (control + passive data conns)
  smtp.ts        // §5 SMTP submission client
  imap.ts        // §6 IMAP4rev1/rev2 mailbox client (+ IDLE)
  jmap.ts        // §8 JMAP over fetch
  tools/
    ssh-tool.ts    // §9.1 createSshToolDefinition(cwd)
    ftp-tool.ts    // §9.2 createFtpToolDefinition(cwd)
    mail-tool.ts   // §9.3 createMailToolDefinition(cwd)  — SMTP+IMAP+JMAP
```

---

## 2. Shared primitives layer (`core.ts`, ~350 lines)

All four TCP protocols (FTP control/data, SMTP, IMAP) are built from the same
four pieces. Nothing else may open a socket.

### 2.1 `tcpConnect(options)`

Thin wrapper that returns a `NetConnection`: `{ socket, read(buf), write(data),
close(), upgradeTls() }`.

- Plain TLS from the start (FTPS implicit 990, SMTPS 465, IMAPS 993):
  `Bun.connect({ tls: {...} })` — one call, no node imports.
- Plaintext that upgrades later (FTP `AUTH TLS`, SMTP STARTTLS, IMAP
  STARTTLS): Bun cannot do mid-stream TLS upgrade on its own handle, so the
  wrapper falls back to `node:net.connect()` and `starttls()` wraps the raw
  socket with `node:tls.connect({ socket })`. This is the only place
  `node:net`/`node:tls` appear.
- Common options: `host, port, tls?: { rejectUnauthorized?: boolean } `
  (default `rejectUnauthorized: true`; an explicit opt-out is logged into the
  result details, never silent), `connectTimeoutMs` (default 10_000).

### 2.2 `LineProtocol`

CRLF line reader/writer over one `NetConnection`, plus byte-exact passthrough:

- `readLine(timeoutMs)` → one CRLF/LF-terminated line as string (utf-8).
- `writeLine(line)` → appends CRLF, flushes.
- `readBytes(n | untilIdleMs)` → for FTP data streams and IMAP literals;
  never re-splits lines the parser asked for as bytes.
- A single internal buffer; no per-line allocation churn. Backpressure via
  the connection's natural stream flow.
- Every read takes a deadline; on timeout the socket is destroyed and a
  `NetTimeoutError` thrown (see 2.5). AbortSignal plumbed through every call:
  abort ⇒ destroy socket ⇒ `NetAbortedError`.

### 2.3 `CredResolver`

Mirrors `resolveEnvOrLiteral` semantics from
`packages/coding-agent/src/core/resolve-config-value.ts` (the same helper
pattern env-api-keys consumers use):

- Input shape: `{ user?: string; secret?: string }` where either field may be
  an environment variable name or a literal value. Resolution order: set
  non-empty `process.env[name]` wins; otherwise treat input as the literal
  value. Set-but-empty ⇒ missing credential error, never silently the var
  name (same rule as resolve-config-value).
- Passwords may also arrive via `secretCommand` ("!"-prefixed shell command,
  cached, same contract as `resolveConfigValue`) so users can keep secrets in
  their keychain instead of env vars.
- Hard rules: resolved secrets are used at most once per operation, never
  echoed into errors, details, or logs; schema descriptions tell the model to
  pass env-var *names*, not literal passwords.

### 2.4 Response parsers

Small shared regexes/helpers, one owner each:

- `parseStatusLine(re)` generic first-token matcher (FTP "xyz-", IMAP tag+
  status, SMTP "xyz-").
- Multi-line continuation collector (FTP "xyz " terminator, SMTP
  "250-…"/"250 ", IMAP tagged response) — one function parameterized by
  terminal-line predicate.
- Literal-block reader for IMAP `{n}` blocks (bytes, then resume lines).

### 2.5 Errors & conventions

One `NetError` family: `NetConnectError`, `NetAuthError`,
`NetProtocolError` (unexpected server reply — always includes the verbatim
reply line), `NetTimeoutError`, `NetAbortedError`. Tool layers catch these
and format messages exactly like the house tools do:
\"Could not connect to <host>:<port>. Error code: <code>.\",
\"Authentication failed for <user> (check <ENV_VAR>).\", etc.

Output caps reuse `src/core/truncate.ts` (`truncateHead`) with per-tool caps
stated in the output contracts below.

---

## 3. SSH (`ssh.ts`, ~300 lines)

### Approach

Spawn the system OpenSSH client as a subprocess with piped stdio:

```
Bun.spawn(["ssh", ...opts, "--", host, command], { stdio: ["pipe","pipe","pipe"] })
```

No SSH wire code at all. Host-key policy, agent auth, config files
(`~/.ssh/config`), ProxyJump, FIDO2 keys all come free because they are the
system binary's behavior.

### Options mapping

| Op-level option | ssh flag |
|---|---|
| port | `-p` |
| user (via `user@host`) | target string |
| identityFile | `-i` |
| batchMode (no prompts) | `-o BatchMode=yes` |
| strictHostKeyChecking opt-out | `-o StrictHostKeyChecking=accept-new` (default `yes`; never skip) |
| connect timeout | `-o ConnectTimeout=<s>` |
| extra args | `sshArgs: string[]` passed through verbatim |

Default flags: `-o BatchMode=yes` (fail fast instead of hanging on a password
prompt the agent can never answer) unless the caller explicitly disables it.

### Operations

- **exec**: spawn `ssh … host — <argv…>` (argv array, never a shell-joined
  string on our side; the remote side still runs the login shell, which is
  inherent to ssh). Stream stdout/stderr, enforce timeout, kill process tree
  on abort. Return `{ exitCode, stdout, stderr, truncated }` with the standard
  50KB/2000-line cap.
- **put/get**: file transfer via the system `scp` binary (`scp -O -P … src
  dst`); local paths resolved against cwd with `resolveToCwd`. We deliberately
  do not implement SFTP packet protocol — scp covers the need and keeps this
  module ~300 lines.

### Failure modes

Missing binary ⇒ `Could not find ssh on PATH.`. Non-zero exit ⇒ include exit
code and stderr tail. Auth prompt hang is impossible under BatchMode; if the
caller disabled it, the connect timeout kills it.

---

## 4. FTP / FTPS (`ftp.ts`, ~900 lines)

Single class `FtpClient` over §2 primitives. One control connection per
operation batch; passive-mode data connections opened per transfer.

### Connection lifecycle

1. `connect(host, port, { implicitTls })` — implicit TLS for port 990,
   plaintext otherwise; expect greeting `220`.
2. Explicit upgrade: send `AUTH TLS`, expect `234`, `starttls()` on the
   control socket, then `PBSZ 0` + `PROT P` (data-channel privacy). PROT
   clear is rejected by default.
3. Login: `USER`/`PASS` via CredResolver; accept 230 (logged-in) or 331→PASS.
4. UTF-8 negotiation: `FEAT` check, `OPTS UTF8 ON` when offered.
5. Keepalive NOOP between ops; close sends `QUIT` and drains.

### Command surface (op enum drives it)

| Op | Commands | Notes |
|---|---|---|
| ls | PASV/EPSV + LIST or MLSD | MLSD when FEAT advertises it; parse machine-listing into {name, size, mtime, type}; fall back to Unix LIST parser |
| get | PASV + RETR | stream to temp file, write-then-rename (house convention); ASCII mode never used — always binary `TYPE I` |
| put | PASV + STOR | same temp-file discipline |
| append | PASV + APPE | |
| mkdir / rmdir | MKD / RMD | |
| rm | DELE | |
| rename | RNFR/RNFR+RNTO | |
| cd / pwd | CWD / PWD | |
| stat / size / mdtm | SITE? SIZE / MDTM | guarded by FEAT |

Passive data connection: prefer `EPSV`, fall back to `PASV` (parse
`h1,h2,h3,h4,p1,p2`). Data connections inherit the control channel's TLS
state (after AUTH TLS they must also be TLS). Read the data stream to EOF
*before* consuming the final 226 on the control channel — the classic FTP
deadlock; the reader ordering is encoded once in the shared
`transferWithPasv()` helper.

Replies: multi-line handled by §2.4 collector. First digit classes: 1xx
(interim, wait), 2xx success, 3xx intermediate-auth, 4xx transient retryable
(surfaces as error with retry hint), 5xx permanent.

---

## 5. SMTP (`smtp.ts`, ~550 lines)

Submission client aimed at port 587 (STARTTLS) / 465 (implicit TLS) / relay.

### Session

1. Greeting `220`, `EHLO <local-hostname>` (fallback HELO).
2. STARTTLS when advertised and not already TLS; require it on port 587
   unless explicitly disabled.
3. `AUTH PLAIN [base64]` or `AUTH LOGIN` (two-step) — pick server-advertised
   mechanism, credentials via CredResolver. CRAM-MD5 out of scope.
4. `MAIL FROM:<>` with optional `BODY=8BITMIME`, `SMTPUTF8` only when both
   sides advertise it.
5. One `RCPT TO` per recipient (to/cc/bcc expanded by the tool layer).
6. `DATA` → send RFC 5322 message with dot-stuffing (leading-`.` escaping),
   terminate `\.\r\n`, expect `250`.

### Message assembly (kept minimal)

Headers built locally: From, To, Cc, Subject (RFC 2047 encode when
non-ASCII — small encoder, ~40 lines), Date, Message-ID (crypto.randomUUID),
MIME-Version. Body: single text part, quoted-printable or 8bit depending on
negotiation. Attachments are out of scope for v1; the op enum reserves
`attachPaths` for later multipart work.

Reply handling uses the §2.4 continuation collector; enhanced status codes
(`250 2.0.0 …`) are surfaced verbatim in results.

---

## 6. IMAP (`imap.ts`, ~1100 lines — the hard ceiling case)

Tagged command/response protocol. This is the largest module; it stays under
1200 lines because parsing is narrow (see limits below).

### Session

1. Greeting `* OK`; optional STARTTLS before LOGIN when on 143 and
   advertised; CAPABILITY after connect (and after TLS).
2. LOGIN via CredResolver (PLAIN-only; SASL mechanisms out of scope).
3. Tag generator `A001…`; every command's completion result matched by tag;
   untagged responses dispatched to the current-command parser or IDLE
   listener.

### Op surface

| Op | Command | Untagged parsing |
|---|---|---|
| listMailboxes | LIST "" "*" (or XLIST namespace) | {delim, name, attrs}; decode modified-UTF-7 names |
| select / examine | SELECT/EXAMINE | EXISTS, RECENT, UIDVALIDITY, UIDNEXT, unseen |
| fetchHeaders | UID FETCH range (UID FLAGS INTERNALDATE ENVELOPE) | ENVELOPE subset: subject/from/to/date |
| fetchBody | UID FETCH uid (BODY[TEXT] / BODY[1]) bounded by BODY.PEEK[TEXT]<offset.count> | literal blocks via §2.4; size-capped windows |
| search | UID SEARCH (FROM/SUBJECT/SINCE/UNSEEN…) simple AND of terms | sequence-set parser → uid[] |
| storeFlags | UID STORE ±FLAGS.SILENT | |
| copy / move | UID COPY / MOVE | |
| expunge / close | EXPUNGE / CLOSE | |
| idle | IDLE | done+continuation handling, max 29 min, re-issue loop |

Literal syntax `{n}` and `~{n}` handled in the §2.4 reader: read
exactly n bytes, then resume line parsing on the remainder.

Parsing limits that buy the line budget: ENVELOPE parsed as flat fields, not
full recursive bodystructure; BODYSTRUCTURE requested never; header fields
limited to the fixed fetchHeaders set; search terms limited to the six listed
(no OR/nested queries v1).

---

## 7. Size budget

| Module | Est. LOC | Ceiling |
|---|---|---|
| core.ts | ~350 | — |
| ssh.ts | ~300 | — |
| ftp.ts | ~900 | 1200 |
| smtp.ts | ~550 | 1200 |
| imap.ts | ~1100 | **1200 (hard)** |
| jmap.ts | ~300 | — |
| tools/* (3 files) | ~200 each | — |

If IMAP exceeds the ceiling, cut before compressing: drop fetchBody windows
first, then move/copy. Never merge modules to hide size.

---

## 8. JMAP (`jmap.ts`, ~300 lines)

JSON-over-HTTP; zero new sockets — plain `fetch`.

- Discovery: `GET {server}/.well-known/jmap` (or a configured session URL)
  with Basic auth (username + CredResolver secret) or Bearer token. Response
  = session object: `accounts, primaryAccounts, apiUrl, downloadUrl,
  uploadUrl, eventSourceUrl, state`.
- Request: `POST apiUrl` with `{ using: ["urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail"], methodCalls: [[name, args, callId]] }`;
  response `methodResponses` returned mostly verbatim to the tool layer
  (we do not model every JMAP method — the op passes `methodCalls` through a
  whitelist: Email/query, Email/get, Email/parse, Mailbox/query, Mailbox/get,
  Identity/get, Email/set, Mailbox/set).
- Download: templated `downloadUrl` GET (blobId) — returns bytes; write to
  temp file like ftp.get.
- Upload: POST to `uploadUrl`, receive blobId.
- State sync: pass-through `state` strings; no delta-cache in v1 (the agent
  re-queries).

---

## 9. Tool surface

Three tools, one per protocol family. Each is a house-style factory pair
(`createXToolDefinition(cwd)` returning `ToolDefinition<Schema, Details>`),
TypeBox schemas with `additionalProperties: false`, description written in
the house template — what / when to use / when NOT / constraints / exact
output contract with failure-message examples — plus `promptSnippet`,
`kind`, `read_only`, registered alongside the other core tools in
`src/core/tools/index.ts`.

Op enums follow the git-tool plan: a discriminated TypeBox union on a literal
`op` field, so the LLM picks one verb per call and validation rejects the
rest.

### 9.1 `ssh` — `createSshToolDefinition(cwd)`

- kind: `"execute"`, read_only: false, executionMode: `"sequential"`.
- Schema: `op: "exec" | "put" | "get"`, `host`, optional
  `port/user/identityFile/sshArgs`, per-op fields (`command` for exec;
  `localPath/remotePath` for put/get), `timeoutMs?` (default 30_000).
- Output contract: exec → captured stdout/stderr with exit code and
  truncation notice; put/get → `copied <n> bytes <local> ↔ <remote>`.
- Description highlights: use for running commands on hosts configured in
  `~/.ssh/config` or reachable by key auth; NOT for bulk file sync (use rsync
  via bash), NOT interactively (BatchMode fails fast). Credentials are never
  taken as literals — keys come from the agent's own ssh setup.

### 9.2 `ftp` — `createFtpToolDefinition(cwd)`

- kind: `"edit"` for mutating ops; read_only computed per-op is impossible in
  the house shape, so the tool declares read_only: false and treats ls/stat
  as safe reads internally.
- Schema: `op: "ls" | "get" | "put" | "append" | "mkdir" | "rmdir" | "rm" |
  "rename" | "cd" | "pwd" | "size"`, `host`, optional
  `port/user/secret/secretCommand/secure: "implicit"|"explicit"|"plain"
  (default "explicit-if-available")`, per-op paths.
- Output contract: ls → one line per entry `type size mtime name` capped at
  2000 lines; transfers report bytes and destination path. Failures name the
  FTP reply verbatim: `Server refused STOR: 553 Could not create file.`

### 9.3 `mail` — `createMailToolDefinition(cwd)` (SMTP + IMAP + JMAP)

One tool, three transports, discriminated union:

```
Type.Union([
  Type.Object({ transport: Type.Literal("smtp"), op: Type.Union([
      Type.Literal("send")]), ...smtpFields }, { additionalProperties: false }),
  Type.Object({ transport: Type.Literal("imap"), op: Type.Union([
      Type.Literal("listMailboxes"), Type.Literal("select"),
      Type.Literal("fetchHeaders"), Type.Literal("fetchBody"),
      Type.Literal("search"), Type.Literal("storeFlags"),
      Type.Literal("copy"), Type.Literal("move"), Type.Literal("idle")]),
      ...imapFields }, { additionalProperties: false }),
  Type.Object({ transport: Type.Literal("jmap"), op: Type.Union([
      Type.Literal("query"), Type.Literal("get"), Type.Literal("changes"),
      Type.Literal("set"), Type.Literal("download"), Type.Literal("upload")]),
      ...jmapFields }, { additionalProperties: false }),
])
```

- kind: `"edit"` overall (send/storeFlags mutate); query-shaped ops are
  treated as reads for truncation purposes.
- Constraints baked into the description: sending mail requires explicit
  recipient confirmation already present in conversation; bcc is consumed but
  never echoed into message headers; idle is capped at 25 minutes per call;
  fetchBody windows are capped (64KB) — large bodies must be paged.
- Output contract: smtp.send → `queued to <n> recipients; server: <enhanced
  status code>`. imap.fetchHeaders → `uid<TAB>from<TAB>date<TAB>subject` rows
  capped at 500; imap.search → UID list; jmap.* → compact JSON of
  methodResponses, capped like other tools. Failures carry protocol detail:
  `IMAP select failed: <tag> NO [NONEXISTENT] Mailbox doesn't exist: Foo`.

### Why not five tools

SSH, FTP and mail are the three families a coding agent acts across (remote
execution, file transfer, correspondence). Splitting SMTP/IMAP/JMAP into
three tools would triple roster noise for ops the model rarely mixes in one
call; the discriminated union gives identical validation guarantees with one
description block. If JMAP usage grows a distinct workflow (calendars,
contacts), promote it to its own tool then — the transport object boundary is
already the seam.
