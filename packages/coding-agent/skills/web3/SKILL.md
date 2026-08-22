---
name: web3
summary: Chain RPC, balances, DeFi analytics - and deep EVM history via HyperSync - instead of curl/cast
description: Chain RPC, wallet balances and DeFi analytics for EVM, Solana and Tron. One binding, nested - `web3.rpc` is JSON-RPC 2.0 to any node with live endpoint discovery and transparent failover (`.call`, `.batch` for N calls in ONE round trip, `.pick`, `.endpoints`, `.tron` REST, exact BigInt unit helpers); `web3.portfolio.balances(addr)` -> priced token rows sorted by `valueUsd`; `web3.defi` -> DefiLlama TVL and GeckoTerminal DEX volume, by chain or protocol, history opt-in; `web3.hypersync` -> Envio HyperSync deep-history logs/events with automatic `next_block` pagination (NOT for latest-state reads). Failures -> `{error, status?}`; bad args throw TypeError.
---

# Web3

Four subsystems under one binding, because "what is this wallet worth" is not three questions.

| `Object.keys(web3)` | answers | full contract |
|---|---|---|
| `web3.rpc` | what does a node say - any JSON-RPC method on any EVM chain, Solana, Tron, Bitcoin | [references/rpc.md](references/rpc.md) |
| `web3.portfolio` | what does one wallet hold, priced | [references/portfolio.md](references/portfolio.md) |
| `web3.defi` | what is a chain or protocol worth, now and before | [references/defi.md](references/defi.md) |
| `web3.hypersync` | what happened on a chain in DEEP history - logs/events past RPC range caps | [references/hypersync.md](references/hypersync.md) |

**Read the reference for the subsystem you are about to use.** The table below is enough to make
the call; the reference carries the option defaults, the observed field drift, and the failure
modes each upstream actually has. All four are live third-party sources and all four lie
occasionally in documented ways.

## The namespace is nested on purpose

There is no `web3.call` or `web3.chain`. Every call is `web3.<subsystem>.<method>`, because the
three vocabularies overlap and the overlaps are traps:

- **"chain" means two different things.** `web3.rpc.pick(1)` takes an EVM chain **id**;
  `web3.defi.chain("Ethereum")` takes a DefiLlama chain **name**. Flat, they would be one name
  for two functions.
- **`fromUnits` exists twice, deliberately.** `web3.rpc.fromUnits` accepts hex and rejects a
  Number past `2^53`; `web3.portfolio.fromUnits` refuses hex and accepts that unsafe Number,
  because two of the three portfolio services send one. Same name, different contract - see
  [references/portfolio.md](references/portfolio.md).
- **A cell should say where a number came from.** `web3.defi.chains()` names its source at the
  call site, which is what the one-metric-one-source rule below depends on.

Error strings name the subsystem, not the binding, so an error reads `rpc.toBigInt: …` or
`defi.chain: …`. That is the module that raised it.

## Call map

### `web3.rpc` - nodes

| Call | Returns |
|---|---|
| `await web3.rpc.call(chain\|url, method, params?, opts?)` | the `result`, or `{error, code?, data?, status?}` |
| `await web3.rpc.batch(chain\|url, calls, opts?)` | one entry per call, in order, ONE round trip |
| `await web3.rpc.endpoints(chain, opts?)` | `[{url, ok, ms, detail, tier}]`, healthiest first |
| `await web3.rpc.pick(chain, opts?)` | the best URL, memoised for the session |
| `await web3.rpc.tron(chain\|base, path, body?, opts?)` | Tron's REST `/wallet` API, which is not JSON-RPC |
| `web3.rpc.lastEndpoint` | the URL that served the last successful call |
| `web3.rpc.toBigInt(v)` / `.fromUnits(raw, dec)` / `.toUnits(v, dec)` | `BigInt` / exact decimal `string` / `BigInt` |

`chain` is an EVM chain id or name, `"solana"`, or `"tron"`; anything starting with `http` is
used as a URL exactly as given. `opts`: `{timeout}` seconds, `{headers}`, `{failover}`, and on
the discovery calls `{limit, rank, officialHosts, providers, refresh, registryRefresh,
registryTimeout}`.

**Failover is transparent and must stay that way.** Pass a chain and `call`/`batch`/`tron` roll
to the next ranked endpoint on a timeout, a 429, a 5xx, a 401/403 or a `-32601`, across up to 3
distinct endpoints, and evict the dead one from `pick`'s memo. A JSON-RPC error object is **not**
retried - the chain answered, and ten nodes give the same answer. You never check for 429 and
re-pick yourself.

### `web3.portfolio` - one wallet

| Call | Returns |
|---|---|
| `await web3.portfolio.balances(address, opts?)` | items sorted by `valueUsd` desc, or `{error, status?}` |
| `await web3.portfolio.raw(address, opts?)` | the untouched upstream payload |
| `web3.portfolio.family(address)` | `"evm"` / `"solana"` / `"tron"`, no request |
| `web3.portfolio.fromUnits(raw, decimals)` | exact decimal `string` |

Each item is `{chain, symbol, name, address, native, decimals, amount, uiAmount, priceUsd,
valueUsd, verified, spam, logo}`. `amount` is the EXACT raw integer as a string; `uiAmount` is
the display float derived from it. Routing is by address shape - `0x` EVM, `T` Tron, base58
Solana - and an unroutable address throws `TypeError`. Spam is dropped unless `{includeSpam}`.
`opts` also takes `{timeout, refresh, headers}`.

Output is not small - a busy EVM wallet returns thousands of rows. Slice or reduce before
printing one into context.

### `web3.defi` - chains and protocols

| Call | Returns |
|---|---|
| `await web3.defi.chains(opts?)` | top 50 `{name, chainId?, symbol, tvl, volume24h?}`, TVL-ordered |
| `await web3.defi.protocols(opts?)` | `{name, slug, category, tvl, chainTvl\|chains, d1, d7}` |
| `await web3.defi.protocol(slug, opts?)` | one protocol, TVL global and per chain |
| `await web3.defi.chain(name, opts?)` | one chain's TVL |

`opts`: `{limit, by}` on `chains`; `{chain, category, limit, raw}` on `protocols`;
`{history, points, chain}` on `protocol` and `{history, points}` on `chain`; `{refresh, timeout}`
everywhere. History is opt-in (`true` or a day count) and stride-sampled to `points` (90).

**One metric, one source.** `tvl`, `chainTvl`, `chainTvls`, `history`, `d1`, `d7` and `mcap` are
always DefiLlama's; `volume24h` is always GeckoTerminal's. No crossover, no fallback across that
seam, so the field name is the provenance and no row carries a source tag. Quote a number against
the source the field name names.

### `web3.hypersync` - deep history

| Call | Returns |
|---|---|
| `await web3.hypersync.logs(chain, opts)` | `{rows, nextBlock, archiveHeight, complete, queries}`, or `{error}` |
| `await web3.hypersync.height(chain, opts?)` | latest indexed block as a number |
| `await web3.hypersync.chains(opts?)` | slugs that answered a live probe, memoised for the session |
| `await web3.hypersync.query(chain, body, opts?)` | the raw `/query` response, verbatim |

`opts`: `{fromBlock, toBlock (EXCLUSIVE), address?, topic0..topic3? (string or string[]),
selections? (batch several filters into ONE body), maxRows (=5000), timeout (=30)}`. Needs
`HYPERSYNC_API_KEY` in the environment; the key value is never printed.

**Routing: deep history comes here, latest state does not.** Governance event archaeology,
transfer scans, indexer rebuilds, any `eth_getLogs` that hit "requested range too large" or a
pruned node - `logs()` paginates `next_block` internally, so a million-block scan is one call.
A latest-state read stays on `web3.rpc.call`: one `eth_call` needs no key and wins on latency,
and HyperSync is never the cheaper single read.

**Rate-limit and batching practice:** set the row budget explicitly (`maxRows`) rather than
leaving `max_num_rows` implicit; batch multiple filters into one request with `selections`
instead of firing one query per filter; paginate via `next_block` instead of widening ranges.
The server may slightly overshoot `maxRows` to finish a block group, so slice before trusting
an exact count. Rows arrive flattened from their nested `data[i].logs` envelope, which no
caller should have to know about - unless it uses `query()`, which returns everything verbatim.

## Errors, uniformly

Every subsystem follows the same rule, which is the `websearch` convention:

- **Recoverable** - the upstream is down, rate-limited, slow, or answered an error - comes back
  as a `{error, status?}` **value**, so the surrounding cell keeps running. Check `.error` before
  using a result.
- **A bad argument throws** - a non-string method, an unroutable address, a `history` that is
  neither `true` nor a day count. That is a bug in the call, not a condition to handle.

## Recipe: chain analytics into a node read

The primary reason these are one skill. `web3.defi.chains()` hands back a `chainId` on every EVM
row, and that id is exactly what `web3.rpc.pick` takes - so ranking chains and then reading one
is a single cell with no glue. **This runs as written:**

    const rows = await web3.defi.chains({ limit: 5 });
    const top = rows.find((r) => r.chainId);                  // chainId is EVM-only
    const url = await web3.rpc.pick(top.chainId);             // discovery, probing, memoised
    const head = await web3.rpc.call(url, "eth_blockNumber");
    console.log(`${top.name} (${top.chainId}) $${(top.tvl / 1e9).toFixed(1)}B TVL, block ${web3.rpc.toBigInt(head)} via ${url}`);

`chainId` is absent on non-EVM rows (216 of DefiLlama's 461 chains), so filter for it rather than
assuming it. Solana and Tron reach `web3.rpc` by name instead - `web3.rpc.pick("solana")`.

## Recipe: what is this wallet worth

    const held = await web3.portfolio.balances("0xbb84b2af75731578d61aa032b52f213d2dbd7024");
    if (held.error) throw new Error(held.error);
    const total = held.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0);
    console.log(`$${total.toFixed(2)} across ${new Set(held.map((t) => t.chain)).size} chains`);
    console.table(held.slice(0, 5).map(({ chain, symbol, uiAmount, valueUsd }) => ({ chain, symbol, uiAmount, valueUsd })));

A Tron TRC-20 arrives with no symbol, no decimals and no price - TronGrid's account endpoint
carries none. Fill one in with a node read through the same binding:

    const base = await web3.rpc.pick("tron");
    const [dec, sym] = await web3.rpc.batch(`${base}/jsonrpc`, [
      { method: "eth_call", params: [{ to: evmForm, data: "0x313ce567" }, "latest"] },  // decimals()
      { method: "eth_call", params: [{ to: evmForm, data: "0x95d89b41" }, "latest"] },  // symbol()
    ]);
    web3.portfolio.fromUnits(amount, Number(web3.rpc.toBigInt(dec)));

## Recipe: API -> frame -> table + chart

TVL history is a series, and a series reads better as a shape. `df` and `chart` are separate
bindings; the seam is `df.get_column(name)`, which hands `chart` a plain array. The full version
of this - ranking, a derived column, and three rebased series on one axis - is in the `df` skill
under "The recipe". **This runs as written:**

    const eth = await web3.defi.chain("Ethereum", { history: true, points: 60 });
    const frame = df(eth.history);                       // rows are already {date, tvl}
    console.log(String(frame.tail(5)));
    console.log(chart(frame.get_column("tvl").map((v) => v / 1e9), { height: 10, width: 70 }));

`{ history: true }` is the whole series from 2020, stride-sampled to `points` and keeping the
first and last observation exactly, so "TVL now against TVL then" stays true. A history point is
`{date, tvl}` with `date` an ISO day - the upstream's `totalLiquidityUSD` is already renamed for
you, so nothing here needs a `.rename`.

## Not this skill

No ABI encoding, no signing, no key management (hypersync only reads `HYPERSYNC_API_KEY` from
the environment), no prices for arbitrary tokens, no pools, no swap routing, no yields. `web3.rpc.call` sends whatever method you compose, including a pre-signed
`eth_sendRawTransaction`, but nothing here builds or signs one.
