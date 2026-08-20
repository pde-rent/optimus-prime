---
name: defi
description: Chain and protocol analytics from DefiLlama plus GeckoTerminal liquidity ranks, hard-trimmed so an answer is a few KB. `await defi.chains(opts?)` -> top 50 chains as `{name, chainId?, symbol, tvl, rank?}`; `chainId` feeds `rpc.pick`. `await defi.protocols({chain?, category?, limit?})` -> `{name, slug, category, tvl, chainTvl|chains, d1, d7}`, sorted by TVL ON THAT CHAIN when `chain` is set. `await defi.protocol(slug, opts?)` and `await defi.chain(name, opts?)` -> TVL now, global and per chain. History is opt-in via `{ history }` (true or days) and downsampled. Errors return `{error, status?}`; bad args throw TypeError.
---

# DeFi

Which chains matter, which protocols are biggest on one, and what TVL is now and was before.
Four calls, two keyless sources, no dependencies.

## Trimming is the feature

The upstream documents are megabytes. `/protocols` is 8.6 MB across 8088 protocols, one
`/protocol/{slug}` detail is 13 MB, a chain history is 3250 daily points. Everything here is
sized so an answer fits in a model's context:

| call | observed result |
|---|---|
| `defi.chains()` | 3.3 KB, 50 rows |
| `defi.protocols({ chain, category })` | 2.3 KB, 20 rows (115 B a row, against 1.5 KB raw) |
| `defi.protocol(slug)` | 0.6 KB |
| `defi.chain(name, { history: true })` | 3.6 KB, 90 points out of 3250 |

Logos, audits, twitter handles, urls, descriptions, methodology, oracles, parent metadata, raise
history and hacks are dropped. `{ raw: true }` on `chains` and `protocols` returns the untrimmed
entries for the rows you selected, with no second fetch - reach for it rather than fetching the
document again.

## Calls

### `await defi.chains(opts?)`

Top chains, ranked by DEX liquidity, with TVL alongside.

    await defi.chains()                       // 50 rows
    await defi.chains({ limit: 10, by: "tvl" })

    { name: "BSC", chainId: 56, symbol: "BNB", tvl: 5201879703, rank: 2 }

`name` is the DefiLlama spelling and is what `defi.chain` and `defi.protocols({ chain })` take.
`chainId` is present only for EVM chains, and pairs directly with the sibling `rpc` skill:

    const [top] = await defi.chains({ limit: 1, by: "tvl" })
    const url = await rpc.pick(top.chainId)          // EVM chains only
    await rpc.call(url, "eth_blockNumber")

`rank` is GeckoTerminal's liquidity rank. It counts raw pool reserve, so it over-weights chains
carrying many junk pools - it puts Solana first on $389B of "reserve" against Ethereum's $5.2B,
while DefiLlama has Ethereum at $46B TVL and Solana at $5.2B. Both numbers ride on every row for
that reason; `{ by: "tvl" }` re-sorts. The universe is DefiLlama's chain list, so chains with
real value but no DEX activity (Bitcoin, Hyperliquid L1) appear with no `rank` at all.

### `await defi.protocols(opts?)`

The biggest protocols, filtered by chain and category. This is one cheap call:

    await defi.protocols({ chain: "BSC", category: "Dexes" })

    { name: "PancakeSwap AMM", slug: "pancakeswap-amm", category: "Dexs",
      tvl: 1879886208, chainTvl: 1876308470, d1: 9.13, d7: 11.17 }

With `chain` set, rows carry `chainTvl` and are sorted by it. That ordering is the point: sorted
by global `tvl` instead, Uniswap V3 would sit second on BNB with $1.4B, of which $37M is
actually there. Without `chain`, rows carry the `chains` array instead and sort by global `tvl`.

`d1` and `d7` are percent change over 1 and 7 days. `category` matches singularised, so `"Dexes"`
finds the `"Dexs"` DefiLlama actually returns. An unknown chain name is an error, not an empty
list.

### `await defi.protocol(slug, opts?)`

One protocol, current TVL globally and per chain.

    await defi.protocol("pancakeswap-amm")
    await defi.protocol("pancakeswap-amm", { history: 365, points: 12 })
    await defi.protocol("aave-v3", { history: 90, chain: "Base" })

    { name, slug, category, symbol, tvl, chains, chainTvls, d1, d7, mcap? }

A name resolves as well as a slug. `chainTvls` keeps DefiLlama's accounting keys next to real
chains - `staking`, `borrowed`, `pool2`, `Binance-staking` - minus everything at zero.

Without `{ history }` this costs no fetch beyond the memoised protocol list. With it, the detail
route is a MULTI-MEGABYTE download (13 MB and ~3.6 s for PancakeSwap) and is the one request
here that is never memoised. `{ chain }` narrows the series to one chain.

There is no `raw` here on purpose - the untrimmed detail would be megabytes in your answer. Read
`https://api.llama.fi/protocol/{slug}` yourself if you truly want all of it.

### `await defi.chain(name, opts?)`

One chain's TVL, and its history only when asked for.

    await defi.chain("Ethereum")
    await defi.chain("Ethereum", { history: 90 })     // last 90 days
    await defi.chain("BSC", { history: true })        // whole series, from 2020

`"Binance"` and `"BSC"` both resolve here; ranks do not, they are a `chains()` concern.

## History is opt-in and downsampled

`{ history }` is `true` for the whole series or a positive number of days. Either way the result
is stride-sampled to `points` (90 by default), keeping the first and last observation exactly, so
"TVL now against TVL then" stays true while the middle thins out. A window of 90 days or fewer is
therefore untouched daily data; Ethereum's full 3250-point series comes back as 90 points and
~3.6 KB. Dates are ISO days.

## Caching

Every request is memoised for 10 minutes, keyed by URL, so a burst of related questions costs one
download - except the protocol detail above, which is never cached. `{ refresh: true }` bypasses
the memo on any call. A chains question never touches `/protocols`.

## Field drift is real, not hypothetical

These are live observations, not documentation:

- `/v2/chains` ships **two rows for chain id 56** - "BSC" with $5.2B and "Binance" with $0 - and
  `/protocols` labels its chains with the second spelling. Rows are folded onto the numeric id
  and the names become aliases of it, which is why either spelling works.
- `chainId` arrives as a number, a numeric string, or `null` (216 of 461 chains). `tokenSymbol`
  is `null` for some live chains, Base among them.
- `category` is `"Dexs"`, never `"Dexes"`.
- 1119 of 8088 protocols have `tvl: null`; `mcap` is frequently `null`; there is no `fdv` field
  on the list route at all.
- GeckoTerminal's ranking is served by an unofficial endpoint whose ranks shift between calls and
  whose page of 50 is not exactly ranks 1-50. If it fails, `chains` still answers - in TVL order,
  with no `rank`.
- The `/v2/chains` TVL and the last point of `historicalChainTvl` are different snapshots and
  disagree by a fraction of a percent.

## Errors

Network, timeout and HTTP failures return a value so the cell keeps running:

    { error: "defi.protocols: https://api.llama.fi/protocols returned HTTP 429", status: 429 }
    { error: "defi.chain: no DefiLlama chain named NopeChain (defi.chains() lists them)" }

A bad argument - a non-string slug, a `limit` that is not a positive integer, a `history` that is
neither `true` nor a day count - throws a TypeError, because that is a bug in the caller.

## Not this skill

No prices, no pools, no swap routing, no yields, no node access, no signing. `rpc` talks to
nodes; `portfolio` reads a wallet.
