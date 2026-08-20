---
name: rpc
description: JSON-RPC 2.0 over HTTP for any chain. `await rpc.call(chain|url, method, params?, opts?)` -> the `result`, or `{error, code?, status?}`. Given a chain (EVM id/name, `"solana"`, `"tron"`) it picks a live endpoint and rolls to the next on a timeout, 429 or 5xx, so rate limits handle themselves. `await rpc.batch(chain|url, [{method, params}, ...])` -> results in order, ONE round trip. `await rpc.endpoints(chain)` -> `[{url, ok, ms, detail, tier}]`, healthiest first. `await rpc.pick(chain)` -> best URL. `await rpc.tron(chain|base, "wallet/getnowblock", body?)` -> Tron REST. Exact `rpc.toBigInt(hex)`, `rpc.fromUnits(raw, dec)` -> string, `rpc.toUnits(v, dec)` -> BigInt. No ABI or signing.
---

# RPC

A JSON-RPC 2.0 client that is one `fetch` POST and nothing else, plus endpoint discovery and the
big-number helpers that keep chain values exact.

## Chain-agnostic on purpose

There is no bundled chain table, no ABI encoder, no signer, and no key handling. `method` is
whatever the node speaks; you compose the params. Discovery (below) reads a live registry at
call time rather than shipping a list that goes stale.

    await rpc.call(1, "eth_blockNumber")                              // by chain: endpoint handled for you
    await rpc.call(url, "eth_call", [{ to, data }, "latest"])         // EVM, pre-encoded calldata
    await rpc.call("solana", "getBalance", [address])                 // Solana
    await rpc.call(url, "getblockcount")                              // Bitcoin
    await rpc.call(url, "status")                                     // anything else

`eth_call` takes calldata you build yourself (a 4-byte selector plus 32-byte words). This skill
does not encode it, and does not sign or send transactions.

## Calls

### `await rpc.call(chain|url, method, params?, opts?)`

The first argument is either an endpoint URL, used exactly as given, or a chain - an EVM id or
name, `"solana"`, `"tron"` - in which case an endpoint is discovered, memoised and **replaced on
the fly when it rate-limits or dies** (see Failover). Anything starting with `http` is a URL;
everything else names a chain.

Returns the `result` field of the response - which may legitimately be `null`, for an unknown
transaction hash or an empty slot.

On a JSON-RPC error, an HTTP error, a timeout, or a network failure, it returns an object
instead of throwing:

    { error: "rpc: eth_call failed: execution reverted", code: -32000, data: "0x..." }
    { error: "rpc: https://node.example returned HTTP 429: rate limited", status: 429 }
    { error: "rpc: request to https://node.example timed out (raise { timeout })" }

So check for it before using the value:

    const head = await rpc.call(url, "eth_blockNumber");
    if (head?.error) return head.error;
    const height = rpc.toBigInt(head);

A bad argument - a non-string `url` or `method`, params that are not an array or object -
throws a `TypeError`. That is a bug in the call, not a condition to handle.

`opts`: `{ timeout }` in seconds (default 15, enforced with `AbortSignal.timeout`) and
`{ headers }` merged over the JSON content-type headers, for an API key or an auth token.

### `await rpc.batch(chain|url, calls, opts?)`

N calls, ONE round trip, using a JSON-RPC batch array. Fifty sequential calls cost fifty times
the network latency; a batch costs it once. Same first argument, same failover as `rpc.call`.

    const [head, chainId, balance] = await rpc.batch(1, [
      { method: "eth_blockNumber" },
      { method: "eth_chainId" },
      { method: "eth_getBalance", params: [address, "latest"] },
    ]);

Each entry may be `{method, params}`, `[method, params]`, or a bare method name.

**When one call in a batch errors**, only that entry is affected: it holds its own
`{error, code?}` object and every other entry still holds its result. The array always has one
entry per call, in the order the calls were given - responses are re-matched by request id,
because a server is free to return them in any order.

**When the request itself fails** (network down, timeout, HTTP 500), there are no per-call
results at all, so every entry holds that single error object. The return shape never changes,
so `results.map(r => r?.error ?? r)` is always valid.

    for (const [i, r] of results.entries()) {
      if (r?.error) console.log(`call ${i} failed: ${r.error}`);
    }

## Failover

Public endpoints degrade constantly. When you pass a **chain**, `call`, `batch` and `tron`
advance to the next ranked endpoint on a failure that is the endpoint's fault, up to **3
distinct endpoints**, and hand back the answer as if nothing happened. You do not check for
`429` and re-pick; that is the whole point.

What is *not* the endpoint's fault is the larger half:

| Result | Retried? | Why |
|---|---|---|
| network error, non-JSON body, timeout | yes | the endpoint, not the question |
| HTTP 429, HTTP 5xx | yes | rate limit or a sick node |
| HTTP 401, HTTP 403 | yes | that node's key check or paywall - `403 archive requests require a paid plan` is one endpoint's policy, and its neighbours serve the same call |
| JSON-RPC `error` object (reverted, bad params, `-32000`) | **no** | the chain answered; ten nodes give the same answer |
| JSON-RPC `-32601 method not found` | yes | which methods a node exposes (`trace_*`, `debug_*`) is that node's choice |
| any other HTTP status | no | the request is wrong, not the node |
| bad arguments | no - throws `TypeError` | a bug in the call |

A `Retry-After` on a 429 is obeyed only while it is **under 2 seconds** - long enough for a
courtesy pause, short enough that it never costs more than trying somewhere else. A longer one
skips straight to the next endpoint, and one call sleeps at most once.

Failing over **evicts** the dead endpoint from `rpc.pick`'s memo, so nothing hands it back for
the rest of the session; when every candidate has been evicted the next call re-probes and
re-ranks from scratch. Only when all of them fail does an error surface, naming each one:

    { error: "rpc: all 3 endpoints failed - https://a (HTTP 429); https://b (timed out); https://c (ECONNREFUSED)" }

- `rpc.lastEndpoint` - the URL that answered the last successful call, when you want to see
  which one actually served it. Free to read; concurrent calls overwrite it.
- `{ failover: false }` - one endpoint only, surfacing its own error. An explicit URL already
  behaves this way, since there is nothing to roll to.

## Finding an endpoint

### `await rpc.pick(chain, opts?)`

For when you want the URL itself - to log it, to reuse it across many calls, or to hand it to
something else. `rpc.call(1, ...)` already does this internally, so reach for it there. Returns
a single URL string, or `{error}` when nothing healthy was found.

    const url = await rpc.pick(1);              // Ethereum mainnet
    const url = await rpc.pick("arbitrum");     // by name
    const sol = await rpc.pick("solana");
    if (url?.error) throw new Error(url.error);

The answer is memoised for the session, so the second `rpc.pick(1)` costs no round trip at all.
A failover drops the endpoint it gave up on from that memo, so this never returns a URL already
known to be dead. `{ refresh: true }` re-probes from scratch.

### `await rpc.endpoints(chain, opts?)`

The full ranked list, when you want a fallback chain or want to see what discovery found.

    [
      { url: "https://arb1.arbitrum.io/rpc",  ok: true,  ms: 91,   detail: "chainId 42161",      tier: "official" },
      { url: "https://arbitrum.drpc.org",     ok: true,  ms: 140,  detail: "chainId 42161",      tier: "provider" },
      { url: "https://rpc.example.dead",      ok: false, ms: 5001, detail: "timed out",          tier: "other" },
      { url: "https://wrong.example",         ok: false, ms: 74,   detail: "wrong chain (1, want 42161)", tier: "other" },
    ]

Returns `{error}` instead when the chain is unknown, the name is ambiguous, or the registry
could not be read.

**`chain` accepts**:

- an EVM chain id - `1`, `42161`, or the string `"42161"`;
- an EVM chain name, matched against the registry's own `chainSlug`, `shortName` and `name`
  fields, so it does not go stale - `"ethereum"`, `"arbitrum"`, `"base"`, `"binance"`. Testnets
  lose to mainnets on a tie; anything still ambiguous returns an error naming the candidate ids,
  and obscure chains may only be reachable by id;
- `"solana"` or `"tron"`.

**How candidates are found**: EVM chains come from `https://chainlist.org/rpcs.json`
(DefiLlama's enriched mirror of `ethereum-lists/chains`; the canonical
`https://chainid.network/chains.json` has the same chain ids but plain-string `rpc` entries -
both shapes parse). Only `http(s)` URLs with no `${API_KEY}` placeholder are kept, which also
discards `wss://` and the handful of malformed rows the registry carries. Solana and Tron have
no registry at all, so they use a small curated seed list of keyless public endpoints.

That filter is not enough on its own: the registry mostly does not use placeholders, it inlines
somebody's demo API key into the URL, and those answer `HTTP 401` today. Probing is what
actually removes them, which is the argument for `rpc.pick` over reading a URL out of the list.

**How they are checked**: concurrently, `{ limit }` at a time (default 12 - Ethereum lists 88).
EVM probes `eth_chainId` **and verifies the answer matches the chain you asked for**, because an
endpoint that answers for the wrong network is exactly the failure this call exists to catch.
Solana probes `getSlot`. Tron probes `POST /wallet/getnowblock`. Per-probe timeout is
`{ timeout }` seconds, default 5.

### Ranking, and how much to trust it

Sort order is **health, then provenance, then latency**. A working fallback always outranks a
dead official endpoint; provenance only breaks ties between endpoints that are equally alive.

`tier` is a heuristic, and a shallow one - string matching on a hostname, not an attestation:

| tier | means |
|---|---|
| `official` | the URL's **registrable domain** contains a word from the chain's own registry identity (`name`, `chainSlug`, `shortName`; words of 4+ characters, generic ones like `mainnet`/`chain`/`network` dropped), or its host is in `opts.officialHosts`. |
| `provider` | that domain is a known multi-chain public gateway - ankr, drpc, 1rpc, publicnode, blastapi, llamarpc, onfinality, and so on. |
| `other` | neither. |

Only the registrable domain counts, never a subdomain: anyone can put `ethereum.` in front of a
host they own, and only the registered domain says who owns it. So `api.mainnet-beta.solana.com`
and `api.trongrid.io` and `polygon-rpc.com` read as official, while `ethereum-rpc.publicnode.com`
correctly does not.

**Where it is wrong**, both directions, observed against the live lists:

- a chain whose official host shares no word with its registry name scores `other` - BNB Smart
  Chain's `bsc-dataseed.binance.org` is the standing example, and Ethereum has no
  `ethereum.*` endpoint at all, so chain 1 has no `official` tier to give;
- an unaffiliated operator whose own domain happens to contain the chain's name scores
  `official` - `public.rpc.solanavibestation.com` and `api.tronstack.io` both do.

It decides ordering and nothing else, and it is overridable:

    await rpc.endpoints(56, { officialHosts: ["binance.org"] })  // pin what you know
    await rpc.endpoints(1,  { rank: false })                     // healthy, then fastest, only
    await rpc.endpoints(1,  { providers: ["ankr", "drpc"] })     // replace the gateway list

### Caching

The EVM registry is ~2 MB covering ~2900 chains, so it is fetched **at most once per session**
and shared by every later lookup; `{ registryRefresh: true }` re-downloads it. It is never
fetched for `"solana"` or `"tron"`. `rpc.pick` separately memoises the healthy endpoints per
chain, best first; `{ refresh: true }` re-probes them.

## Tron

Tron's main API is **not** JSON-RPC. It is REST - `POST /wallet/<method>` with a JSON body - so
`rpc.call` cannot reach it:

    const block = await rpc.tron("tron", "wallet/getnowblock");   // chain, or a base URL
    block.block_header.raw_data.number;
    await rpc.tron("tron", "wallet/getaccount", { address: "TR7...", visible: true });

Tron nodes **also** expose an EVM-compatible JSON-RPC at `<base>/jsonrpc`, which is where
`rpc.call` sends a `"tron"` chain argument:

    await rpc.call("tron", "eth_blockNumber");                    // -> <base>/jsonrpc

Which to reach for: `rpc.tron` for anything Tron-native - accounts, resources, TRC-10, the
`/wallet` API in general - and `rpc.call` for EVM-shaped questions such as block numbers and
TRC-20 `eth_call` reads. Note that `rpc.endpoints("tron")` returns REST full-node
bases, while `rpc.endpoints(728126428)` - Tron's EVM chain id - returns JSON-RPC URLs from the
chain registry, ready for `rpc.call` as they are.

Both take `{ headers }`, so a `TRON-PRO-API-KEY` goes in when free-tier limits bite.

## Value helpers

A JS number holds integers exactly only up to `2^53 - 1`. A uint256 goes to `2^256 - 1`, and a
token balance is already past the limit at ~9 tokens with 18 decimals. Reading a balance into a
number and dividing by `1e18` is silently wrong in the low digits - the classic chain bug. These
three helpers contain no floating-point arithmetic at all: BigInt and string surgery only.

| Call | Returns |
|---|---|
| `rpc.toBigInt(value)` | `BigInt`. Accepts `"0x1f"`, `"31"`, a BigInt, or a safe-integer Number. |
| `rpc.fromUnits(raw, decimals)` | Exact decimal `string`, e.g. `"1.5"`. |
| `rpc.toUnits(decimal, decimals)` | `BigInt` raw amount. |

    rpc.toBigInt("0xde0b6b3a7640000")                  // 1000000000000000000n
    rpc.fromUnits("0xde0b6b3a7640000", 18)             // "1"
    rpc.fromUnits(123456789n, 6)                       // "123.456789"
    rpc.toUnits("0.000001", 6)                         // 1n
    rpc.toUnits("1e-6", 6)                             // 1n  (exponent form is accepted)

`fromUnits` returns the shortest exact decimal: trailing fractional zeros are dropped, and an
integral value carries no decimal point.

`toUnits` prefers a string. A Number argument is converted through its own shortest decimal
form, which is exact for what the double holds but not for what was typed - `0.1 + 0.2` really
is `0.30000000000000004`.

These throw rather than return an error value, because each case is a caller bug:

- `TypeError` - a non-integer or unsafe Number, an unparseable string, or `decimals` outside
  `0..256`.
- `RangeError` from `toUnits` - the value carries more significant decimal places than
  `decimals` can hold. Truncating an amount silently is how funds go missing, so round it
  yourself first. Excess *zeros* are fine and are dropped.

## Composing a read

    const [head, raw] = await rpc.batch(1, [    // or your own endpoint URL
      { method: "eth_blockNumber" },
      { method: "eth_getBalance", params: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"] },
    ]);
    if (raw?.error) throw new Error(raw.error);
    console.log(`block ${rpc.toBigInt(head)}: ${rpc.fromUnits(raw, 18)} ETH`);
