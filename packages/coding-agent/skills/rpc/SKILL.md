---
name: rpc
description: JSON-RPC 2.0 over HTTP, any node or chain. `await rpc.call(url, method, params?, {timeout, headers}?)` -> the `result` value, or `{error, code?, status?}` on RPC/HTTP/network failure (check `.error`; never throws for those). `await rpc.batch(url, [{method, params}, ...], opts?)` -> array of results in call order, ONE round trip; a failed call holds its own error object. Exact float-free big-number helpers `rpc.toBigInt(hexOrDecimal)` -> BigInt, `rpc.fromUnits(raw, decimals)` -> decimal string, `rpc.toUnits(decimalStr, decimals)` -> BigInt. Transport only, no ABI encoding or signing.
---

# RPC

A JSON-RPC 2.0 client that is one `fetch` POST and nothing else, plus the big-number helpers
that keep chain values exact.

## Chain-agnostic on purpose

There is no chain list, no bundled endpoint, no ABI encoder, no signer, and no key handling.
`url` and `method` are whatever the node speaks; you compose the params.

    await rpc.call(url, "eth_blockNumber")                            // EVM
    await rpc.call(url, "eth_call", [{ to, data }, "latest"])         // EVM, pre-encoded calldata
    await rpc.call(url, "getBalance", [address])                      // Solana
    await rpc.call(url, "getblockcount")                              // Bitcoin
    await rpc.call(url, "status")                                     // anything else

`eth_call` takes calldata you build yourself (a 4-byte selector plus 32-byte words). This skill
does not encode it, and does not sign or send transactions.

## Calls

### `await rpc.call(url, method, params?, opts?)`

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

### `await rpc.batch(url, calls, opts?)`

N calls, ONE round trip, using a JSON-RPC batch array. Fifty sequential calls cost fifty times
the network latency; a batch costs it once.

    const [head, chainId, balance] = await rpc.batch(url, [
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

    const url = "https://reth-ethereum.ithaca.xyz/rpc";  // your own endpoint
    const [head, raw] = await rpc.batch(url, [
      { method: "eth_blockNumber" },
      { method: "eth_getBalance", params: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"] },
    ]);
    if (raw?.error) throw new Error(raw.error);
    console.log(`block ${rpc.toBigInt(head)}: ${rpc.fromUnits(raw, 18)} ETH`);
