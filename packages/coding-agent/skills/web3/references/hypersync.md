# `web3.hypersync` - deep historical EVM data

Envio HyperSync: a per-chain REST archive that answers range queries of any depth, where a
public node's `eth_getLogs` caps out at ~10-100k blocks or prunes history outright.

**Routing rule.** Deep history comes here: event archaeology, transfer scans, indexer rebuilds,
governance/timelock audits, any `eth_getLogs` that returned "requested range too large" or hit a
pruned node. Latest-state reads stay on `web3.rpc.call` - one `eth_call` or one small
`eth_getLogs` needs no key and wins on latency. HyperSync is never the cheaper single read.

Auth is `HYPERSYNC_API_KEY` from the environment, sent as a Bearer token. The key value is never
printed, logged, or embedded in an error. A missing key comes back as an `{error}` value naming
the variable, from every method.

## Call map

| Call | Returns |
|---|---|
| `await web3.hypersync.height(chain, opts?)` | the latest indexed block as a NUMBER, or `{error}` |
| `await web3.hypersync.chains(opts?)` | sorted slugs that answered `/height`, or `{error}` |
| `await web3.hypersync.logs(chain, opts)` | `{rows, nextBlock, archiveHeight, complete, queries}` or `{error}` |
| `await web3.hypersync.query(chain, body, opts?)` | the parsed `/query` response VERBATIM, or `{error}` |

`opts.timeout` is seconds everywhere (default 30; 5 on probes).

## `logs(chain, opts)` - the workhorse

```js
const out = await web3.hypersync.logs("eth", {
    fromBlock: 1_000_000,                 // inclusive, required
    toBlock: 2_000_000,                   // EXCLUSIVE, like eth_getLogs
    address: "0x...",                     // string or string[] (OR within the filter)
    topic0: "0x<event sig hash>",         // topic0..topic3, string or string[]
    maxRows: 5000,                        // row budget across all pages, default 5000
});
if (out.error) throw new Error(out.error);
console.log(out.rows.length, out.complete, out.nextBlock);
```

- Pagination on `next_block` is internal. `complete: true` means the range finished; `false`
  with a non-null `nextBlock` means the `maxRows` budget stopped it - resume by passing that
  `nextBlock` as `fromBlock`. A mid-scan failure returns the error PLUS the `rows` collected so
  far and the `nextBlock` to resume from, so one flake does not restart a long scan.
- `maxRows` is a budget, not a cap: the server may slightly OVERSHOOT it to finish a block
  group. Slice before trusting an exact count.
- Rows are the log objects under `data[i].logs`, flattened - `block_number`, `address`,
  `topic0`..`topic3`, `data`, `transaction_hash`. Decode topics/data with `cast` or repo ABIs;
  topic0 signatures use CANONICAL types (`uint8` -> `uint256`; `cast sig-event` handles this).
- Batch multiple logical filters into ONE request with `selections` - an array of
  `{address?, topic0?..topic3?}`, each an OR group inside the single query body. This is the
  recommended shape for rate-limited keys: one request per scan, not one per filter.
- Omitted `topicN` = wildcard at that position, matching `eth_getLogs` positional semantics.

## Body rules that bite

- Rows are NESTED under `data[0].logs` (one group per page). A top-level `logs` read yields
  `undefined`, silently.
- `field_selection.log` fields are FLAT: `topic0`, `topic1`, `topic2`, `topic3`. A `topics`
  ARRAY is rejected with HTTP 400 "unknown variant" - it belongs to a different API version.
- `to_block` is exclusive.
- Limits: a server time cap, a response size cap, and `max_num_rows`. Set the row budget
  explicitly (`maxRows`) - an implicit budget is what gets a key rate-limited - and paginate
  via `next_block` rather than widening ranges.

## `chains()` - probed, not listed

The official list at `meta.hypersync.xyz` is unreachable from many networks, so discovery
probes each candidate slug's own `/height` (8 at a time, 5s each) and returns the slugs that
answer, memoised for the session (`{ refresh: true }` re-probes; `{ candidates: [...] }`
replaces the list). If NOTHING answers, the return is an error value - an unverified list that
looked authoritative is worse than a failure. The curated candidates cover the majors (eth,
arbitrum, base, polygon, optimism, avalanche, bsc, scroll, linea, blast, mode, sei, zksync,
mantle, ... plus common testnets); docs.envio.dev claims 80+ EVM chains, and any slug not on
the list still works - the base URL is just `https://<slug>.hypersync.xyz`, so pass a trusted
name straight to `logs`/`height`/`query`.

## `query(chain, body)` - the passthrough

For row types `logs` does not model (`transactions`, `blocks`, `traces`), custom
`field_selection`, joins, contract queries. The response comes back verbatim - nested
`data[i].logs` and the `next_block` cursor included - and paginating is then the caller's job.
Prefer `logs()` whenever the question is event logs.

## Errors

Same convention as `rpc` and `defi`: upstream failures (down, rate-limited, timeout, HTTP
error, non-JSON) return `{error, status?}` values; check `.error` before using a result. Bad
arguments - an empty or URL-unsafe chain slug, a negative or fractional block, a non-object
`query` body - throw `TypeError`.
