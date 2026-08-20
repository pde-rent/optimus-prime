/**
 * Web3: one binding over the three questions a chain wallet actually raises - what does this
 * node say, what does this wallet hold, and what is this chain or protocol worth.
 *
 * They were three skills. Merging them is a prompt-budget decision and a routing one. Budget:
 * the roster bills one summary line per skill on every request, so three descriptions cost
 * three lines and 1799 characters of prefix where one costs one line. Routing: "what is this
 * wallet worth" is not three questions. It is balances, then a price or a TVL for context, then
 * a contract read to fill in what the portfolio API could not name - and a model that has to
 * discover three separate skills to answer it will stop after the first.
 *
 * THE NAMESPACE IS NESTED, NOT FLAT. `web3.rpc.*`, `web3.portfolio.*`, `web3.defi.*`, with
 * nothing hoisted to the top level. Three reasons, in order of weight:
 *
 *   1. The vocabularies collide. "Chain" means an EVM id to `rpc.pick` and a DefiLlama chain
 *      NAME to `defi.chain`; a flat `web3.chain` would be two different functions wearing one
 *      name. `fromUnits` is a real duplicate with two deliberately different contracts (see
 *      `portfolio.js`), and flattening would have silently picked one.
 *   2. A cell is readable. `web3.defi.chains()` states which subsystem produced the number,
 *      which is what `defi`'s one-metric-one-source rule depends on to stay checkable, and
 *      `web3.rpc.call` says at the call site that this went to a node.
 *   3. Nothing was renamed, so nothing was lost. Every call is the old expression with one
 *      prefix in front of it, error strings included: an error still reads `rpc.toBigInt: …`
 *      because the module that raised it is still `rpc`.
 *
 * The cost is five keystrokes per call and one extra hop of recall, against `Object.keys(web3)`
 * being three names a model can hold rather than sixteen from three vocabularies.
 *
 * Each subsystem stays in its own module. They share no state and no fetch layer - `rpc` speaks
 * JSON-RPC to nodes, `portfolio` and `defi` speak HTTP GET to third-party services with their
 * own caches and their own error conventions - so a single file would only have made 1700 lines
 * that never call each other look like they might.
 */

import { createDefi } from "./defi.js";
import { createPortfolio } from "./portfolio.js";
import { createRpc } from "./rpc.js";

export default function createSkill() {
	return {
		rpc: createRpc(),
		portfolio: createPortfolio(),
		defi: createDefi(),
	};
}
