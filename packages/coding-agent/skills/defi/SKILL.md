---
name: defi
description: Chain and protocol analytics — DefiLlama TVL, GeckoTerminal DEX volume. `await defi.chains(opts?)` -> top 50 `{name, chainId?, symbol, tvl, volume24h?}`, TVL-ordered unless `by` is `"volume"`. `await defi.protocols({chain?, category?, limit?})` -> `{name, slug, category, tvl, chainTvl|chains, d1, d7}`, sorted by TVL on that chain when `chain` is set. `await defi.protocol(slug, opts?)` and `await defi.chain(name, opts?)` -> TVL now, global and per chain. History is opt-in via `{ history }` (true or days) and downsampled. Errors -> `{error, status?}`; bad args throw TypeError.
---

# DeFi

Which chains matter, which protocols are biggest on one, and what TVL is now and was before.
Four calls, two keyless sources, no dependencies.

## One metric, one source

Every number here has exactly one authority, and the field name tells you which:

| field | source | meaning |
|---|---|---|
| `tvl`, `chainTvl`, `chainTvls`, `history` | **DefiLlama** | value locked, USD |
| `d1`, `d7`, `mcap` | **DefiLlama** | percent change over 1 and 7 days, market cap |
| `volume24h` | **GeckoTerminal** | DEX swap volume over 24h, USD |

There is no crossover and no fallback across that seam. No `tvl` in this skill was ever sourced
from GeckoTerminal and no `volume24h` from DefiLlama, so a row needs no source tag - the name
carries it. When you quote a number, quote it against the source in this table.

## Trimming is the feature

The upstream documents are megabytes. `/protocols` is 8.6 MB across 8088 protocols, one
`/protocol/{slug}` detail is 13 MB, a chain history is 3250 daily points. Everything here is
sized so an answer fits in a model's context:

| call | observed result |
|---|---|
| `defi.chains()` | 3.5 KB, 50 rows |
| `defi.protocols({ chain, category })` | 2.3 KB, 20 rows (115 B a row, against 1.5 KB raw) |
| `defi.protocol(slug)` | 0.6 KB |
| `defi.chain(name, { history: true })` | 3.6 KB, 90 points out of 3250 |

Logos, audits, twitter handles, urls, descriptions, methodology, oracles, parent metadata, raise
history and hacks are dropped. `{ raw: true }` on `chains` and `protocols` returns the untrimmed
entries for the rows you selected, with no second fetch - reach for it rather than fetching the
document again.

## Calls

### `await defi.chains(opts?)`

Top chains by TVL, carrying 24h DEX volume alongside.

    await defi.chains()                          // 50 rows, TVL order
    await defi.chains({ limit: 10, by: "volume" })

    { name: "BSC", chainId: 56, symbol: "BNB", tvl: 5262000000, volume24h: 2954000000 }

`tvl` is DefiLlama's, `volume24h` is GeckoTerminal's, both in whole USD - so `volume24h / tvl` is
a turnover ratio as the two stand. `name` is the DefiLlama spelling and is what `defi.chain` and
`defi.protocols({ chain })` take. `chainId` is present only for EVM chains, and pairs directly
with the sibling `rpc` skill:

    const [top] = await defi.chains({ limit: 1 })
    const url = await rpc.pick(top.chainId)          // EVM chains only
    await rpc.call(url, "eth_blockNumber")

**`by` defaults to `"tvl"`; `"volume"` is opt-in.** TVL is the complete axis - DefiLlama covers
459 chains against GeckoTerminal's 44 - so a TVL sort ranks everything while a volume sort ranks
a third of a 50-row answer and sinks the rest beneath it. TVL order is also what you get when
GeckoTerminal is down, so the default never silently changes meaning.

**The two disagree, and that disagreement is the point.** Live, by TVL rank against volume rank:

| chain | TVL | vol24h | TVL rank | vol rank |
|---|---|---|---|---|
| Ethereum | $46.19B | $2294M | 1 | 3 |
| BSC | $5.26B | $2954M | 2 | 2 |
| Solana | $5.25B | $6268M | 3 | 1 |
| Tron | $5.03B | $59M | 5 | 10 |
| Bitcoin | $3.86B | absent | 6 | - |
| Robinhood Chain | $0.56B | $523M | 13 | 5 |
| X Layer | $0.11B | $264M | 24 | 7 |
| Near | $0.10B | $153M | 26 | 8 |

Tron holds Base-sized value and trades a fiftieth of Base's volume; X Layer and Near trade far
above their weight. Either number alone gets one of those wrong.

`volume24h` is **absent, not zero**, when GeckoTerminal has no figure - about a third of a default
answer, either because the chain has no DEX activity (Bitcoin, Hyperliquid L1, Provenance) or
because it is simply off GeckoTerminal's first page. Absent means unknown, not untraded.

GeckoTerminal's `rank_by_liquidity` is deliberately **not** exposed, and `{ by: "liquidity" }` now
throws. It counts raw pool reserve, so it ranks Solana first on $389B of "reserve" against
Ethereum's $5.2B and seats Near ($0.1B TVL) above Tron ($5.0B) - the wrong field from the right
source. `volume24h`, out of that same payload, is the right one.

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

`"Binance"` and `"BSC"` both resolve here; `volume24h` does not, it is a `chains()` concern.

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
- GeckoTerminal's metrics are served by an unofficial endpoint, one page of 50 networks. Every
  money field on it is a decimal **string**, not a number - `swap_volume_usd_24h` comes back as
  `"6267922512.52942"`. The metrics hang off the included `network_metric`, never off the network
  object, which carries no figures at all. If the endpoint fails, `chains` still answers - from
  DefiLlama, with `volume24h` absent.
- Only 38 of GeckoTerminal's 50 networks carry a `chain_id`, so the join runs through name and
  `cg_network_id` aliases too. It matches 44 of DefiLlama's 459 folded chains, 33 of the top 50.
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
