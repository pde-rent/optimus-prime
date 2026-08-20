---
name: portfolio
description: Token balances for one wallet across EVM chains, Solana and Tron. `await portfolio.balances(address, opts?)` -> items sorted by `valueUsd` desc, each `{chain, symbol, name, address, native, decimals, amount, uiAmount, priceUsd, valueUsd, verified, spam, logo}`, or `{error, status?}` on network failure. `amount` is the EXACT raw integer as a string, `uiAmount` the display float. Family comes from the address shape — `0x` EVM, base58 Solana, `T` Tron; anything else throws TypeError. Spam is dropped unless `{ includeSpam }`. `await portfolio.raw(address, opts?)` -> the untouched upstream payload.
---

# Portfolio

Token balances for one wallet, from three third-party portfolio services, in one item shape.

Reading a wallet from nodes alone is the wrong tool: a balance sweep over EVM is one `eth_call`
per token per chain and you still need the token list, the decimals, and a price. These services
already did that and answer keylessly, so this skill is the fetch, the routing, and the
normalisation. No keys, no signing, no node access - `rpc` is the skill for talking to a node.

## Read this first: the endpoints are not infrastructure

All three are **undocumented, keyless, rate-limited, third-party** endpoints owned by other
people. None of them publishes a contract, a version, or a deprecation policy. They can change
shape, throttle, block a client, or disappear without notice, and the shapes below are what was
observed on one day, not what anyone promised. Every network failure comes back as
`{error, status?}` for exactly this reason - assume it will happen.

| family | service | endpoint |
|---|---|---|
| `evm` | Rabby / DeBank | `GET api.rabby.io/v1/user/cache_token_list?id=<0x…>` - every EVM chain it indexes, in one response |
| `solana` | Phantom | `GET api.phantom.app/sniper/v1/tokenPortfolio?…&ownerAddress=<…>` |
| `tron` | TronGrid | `GET api.trongrid.io/v1/accounts/<T…>` - an account endpoint, not a portfolio one |

No `User-Agent` is sent. Bun's default passes all three, and Phantom fingerprints clients - a
plain `curl` gets `403` on the same URL Bun fetches fine - so substituting a custom identity is a
way to get blocked, not a courtesy.

## Calls

### `await portfolio.balances(address, opts?)`

The normalised list, sorted by USD value, largest first.

    const held = await portfolio.balances("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    if (held.error) throw new Error(held.error);
    for (const t of held.slice(0, 10)) console.log(t.chain, t.symbol, t.uiAmount, t.valueUsd);

`opts`: `{ includeSpam }` (below), `{ timeout }` in seconds (default 15, enforced with
`AbortSignal.timeout`), `{ refresh }` to bypass the 30s response memo, `{ headers }` merged over
the `Accept` header.

**Output size is not small.** A busy EVM wallet really does return thousands of rows -
Vitalik's returned 2289 across 61 chains - so slice or reduce before printing one into context.

### `await portfolio.raw(address, opts?)`

The upstream payload, exactly as the service returned it, for the per-service signal
normalisation drops. A `balances` call in the last 30 seconds is served from the same memo, so
this costs no second round trip.

| family | shape | worth reading |
|---|---|---|
| `evm` | `RabbyEvmTokenItem[]` | `cex_ids`, `fdv`, `price_24h_change`, `credit_score`, `is_core`, `is_wallet`, `protocol_id` |
| `solana` | `{success, data, tokenPrices?, sparkCharts?}` | `tokenPrices[mint]`: realised and unrealised PnL, cost basis, 5m..24h price changes. `sparkCharts[mint]`: price history |
| `tron` | `{data: [account], success, meta}` | `frozenV2` staked TRX, `assetV2` TRC-10 balances, `account_resource` energy and bandwidth |

### `portfolio.family(address)`

Which service an address would route to - `"evm"`, `"solana"`, or `"tron"` - with no request.
Throws the same `TypeError` as `balances` on an unrecognised shape.

### `portfolio.fromUnits(raw, decimals)`

Exact raw-to-decimal string conversion, the same function as `rpc.fromUnits`. Present so a Tron
TRC-20 amount can be scaled once you have looked its `decimals` up.

## Routing by address shape

| shape | family |
|---|---|
| `0x` + 40 hex characters | `evm` |
| `T` + 33 base58 characters | `tron` |
| 32-44 base58 characters | `solana` |

Anything else throws a `TypeError` naming all three, because an unroutable address is a bug in
the call, not a condition to handle.

Tron is tested **before** Solana, and that ordering has a consequence worth knowing: a Tron
address is base58 too, so `T` + 33 base58 characters also satisfies the Solana pattern. A Solana
account whose base58 happens to begin with `T` and is exactly 34 characters long is
indistinguishable from a Tron address here and routes to Tron. The two encodings genuinely
overlap; nothing in the string can separate them.

## The normalised item

One shape for all three services, so nothing here needs a second schema.

| field | type | notes |
|---|---|---|
| `chain` | string | DeBank's own **slug** for EVM - `eth`, `bsc`, `op`, `arb`, `base`, `opbnb`, `sonic`, … - **not** a chain id. `"solana"` or `"tron"` otherwise. |
| `symbol` | string \| null | null when the source carries none (every Tron TRC-20). |
| `name` | string \| null | as above. |
| `address` | string | The contract or mint. For a native coin: the chain slug on EVM (`"base"`), the wrapped-SOL mint on Solana, the literal `"native"` on Tron, which has no TRX contract. |
| `native` | boolean | The chain's own coin. |
| `decimals` | number \| null | null when unknown (every Tron TRC-20). |
| `amount` | string \| null | **Exact** raw integer, as a decimal string. Never a float. |
| `uiAmount` | number \| null | Display value, derived from `amount`. null when `decimals` is. |
| `priceUsd` | number \| null | null means *unknown*; `0` means the source priced it at zero. |
| `valueUsd` | number \| null | `priceUsd * uiAmount`. The sort key. |
| `verified` | boolean \| null | null when the source has no opinion (Tron). |
| `spam` | boolean \| null | null when the source has no opinion (Tron). |
| `logo` | string \| null | An empty string upstream reads as null here. |

Sort order is `valueUsd` descending with **unpriced positions last**. `Array.prototype.sort` is
stable, so an all-unpriced list - every Tron account - keeps the upstream order instead of being
shuffled into an arbitrary one.

## Precision

`amount` is an exact decimal string and every scaling in this skill is BigInt and string
surgery. There is no division by `10 ** decimals` anywhere, because a token balance passes
`Number.MAX_SAFE_INTEGER` at about 9 tokens with 18 decimals and the loss is silent.

This is not hypothetical. Rabby ships both `raw_amount` (a JSON number - its own field docs call
it unsafe for large integers) and `raw_amount_str`, and in a live response they disagreed:

    raw_amount:      133946806283165580
    raw_amount_str: "133946806283165590"     <- the true value

Only the string forms are read: Rabby's `raw_amount_str`, Phantom's `amount`, TronGrid's TRC-20
balance strings. `uiAmount` is then derived *from that exact string*, so it is the correctly
rounded double of the true value rather than a double of an already-lossy integer.

**The one place exactness is impossible**: TronGrid sends the native `balance` as a JSON *number*
of SUN, and Phantom sends the native SOL `amount` as a number too. `JSON.parse` has already
produced a double by the time this skill sees it, so the string it emits is exact for that double
and, past 2^53 SUN (about 9.0e9 TRX), is not the integer the server meant. Nothing downstream can
repair that; only a bigint-aware parse of the response text could.

## Spam filtering

On by default. The rules are short on purpose - a filter whose rule is invisible is worse than
no filter:

| source | `spam` is true when | `verified` is true when |
|---|---|---|
| Rabby | `is_scam === true` or `is_suspicious === true` | `is_verified === true` |
| Phantom | `spamStatus` contains `SPAM` - so `POSSIBLE_SPAM` goes | `spamStatus === "VERIFIED"` |
| TronGrid | never - no signal exists | never - no signal exists |

`{ includeSpam: true }` keeps everything. Two consequences follow from the table:

- `LOW_LIQUIDITY` on Phantom is **kept**. It marks a thin but real holding, not a scam; it simply
  reads as `verified: false`.
- `spam: null` is not the same as clean, so Tron items always survive the filter. `includeSpam`
  changes nothing on a Tron address.

**Rabby's flags did not fire in observation.** Across 2289 tokens on 61 chains for one large
wallet, `is_scam`, `is_suspicious` and `!is_verified` were each true **zero** times. The fields
exist and are read, but `cache_token_list` looks like an already-curated list, so do not read a
low filtered count as proof that nothing was filtered - and do not assume EVM airdrop spam has
been removed.

## Tron is partial support, honestly

TronGrid's account endpoint is not a portfolio endpoint. A TRC-20 holding arrives as
`{"TR7NHq…": "37272285390601"}` - a contract and a raw balance, and **nothing else**. There is no
symbol, no name, no decimals, no price, no logo, and no spam signal anywhere in the response.

So a Tron result is:

| | native TRX | every TRC-20 |
|---|---|---|
| `symbol`, `name` | `TRX`, `TRON` | **null** |
| `decimals` | `6` (SUN, a fixed chain constant) | **null** |
| `amount` | exact, but see the 2^53 note above | exact string |
| `uiAmount` | derived | **null** - no decimals to scale by |
| `priceUsd`, `valueUsd` | **null** - TronGrid prices nothing | **null** |
| `verified` | `true` | **null** |
| `spam` | `false` | **null** |

No price is invented for TRX, and no decimals are guessed for a TRC-20. Expect a long list: a
used Tron account accumulates hundreds of airdropped contracts (357 on the account probed) and
none of them can be filtered, ranked, or scaled from this response alone.

To fill a row in, read the contract with the sibling `rpc` skill - Tron nodes expose an
EVM-compatible JSON-RPC, and `rpc.batch` does N reads in one round trip:

    const base = await rpc.pick("tron");                       // https://api.trongrid.io
    const [dec, sym] = await rpc.batch(`${base}/jsonrpc`, [
      { method: "eth_call", params: [{ to: evmForm, data: "0x313ce567" }, "latest"] },  // decimals()
      { method: "eth_call", params: [{ to: evmForm, data: "0x95d89b41" }, "latest"] },  // symbol()
    ]);
    portfolio.fromUnits(amount, Number(rpc.toBigInt(dec)));

Staked TRX (`frozenV2`) and TRC-10 assets (`assetV2`) are **not** counted as balances; both are
in `portfolio.raw`.

## Observed drift from the published shapes

The response types these services are documented with were checked against live payloads. They
disagreed in seven places, so do not depend on a field being present or typed as declared:

| where | declared | observed |
|---|---|---|
| Phantom, native SOL row | `amount: string` | a **number** (`29764933`), unlike every other row |
| Phantom, native SOL row | `solPrice: number` | the key is **absent** |
| Phantom, `solPrice` | a USD price | not one. USDC read `185538.31` while its USD price was `1`; it tracked the position's SOL value scaled by `10 ** decimals`. **Unused here** - price comes from `tokenPrices[mint].value` |
| Phantom, `tokenPrices` | keyed by mint | present, but only for the positions it prices - 3 of 8 rows. Absent means unknown, not zero |
| Phantom, `charts=false` | suppresses charts | ignored; `sparkCharts` came back anyway. `sniper`/`isRouter` are what add `tokenPrices` |
| Rabby, `time_at` | `null` for native | `1622131200` on native ETH for `arb` |
| Rabby, `is_scam`/`is_suspicious`/`is_verified` | discriminating flags | never fired across 2289 tokens; see above |

Rabby's `asset`, `launchpad` and `market_status` were `null` on every row observed, so their real
types are unknown. TronGrid also omits `balance` and `trc20` entirely on an account that has
neither, rather than sending `0` and `[]`.

## Errors

Network, HTTP and rate-limit failures come back as a value so the surrounding cell keeps running:

    { error: "portfolio: Rabby returned HTTP 429: rate limited", status: 429 }
    { error: "portfolio: Phantom timed out (raise { timeout })" }

A bad address throws a `TypeError` instead, naming all three supported shapes. Phantom and
TronGrid also answer `success: false`, which becomes an error value too.

## Caching

One upstream response per wallet is memoised for **30 seconds**, so `balances` followed by `raw`
is a single round trip and a retry loop cannot hammer a rate-limited endpoint. Error values are
never cached. `{ refresh: true }` bypasses the memo.
