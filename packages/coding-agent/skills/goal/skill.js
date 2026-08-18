/**
 * Prime Agent goal skill: manage the persistent thread goal from the REPL.
 *
 * All goal state lives in the host; these functions are thin typed wrappers
 * over the generic host bridge.
 */
export default function createSkill({ hostRequest }) {
	return {
		/**
		 * Read the current thread goal: `{ goal, remaining_tokens, completion_budget_report }`.
		 * `goal` is null when no goal is set.
		 */
		async get() {
			return hostRequest("goal.get", {});
		},

		/**
		 * Start a new active thread goal. Fails while a goal is still pending
		 * (active, paused, or budget-limited); a completed or errored goal is
		 * replaced. Only create a goal when explicitly asked for a persistent
		 * long-running goal, and set `tokenBudget` only when one is requested.
		 */
		async create(objective, tokenBudget) {
			if (typeof objective !== "string") {
				throw new TypeError(`objective must be a string, got ${typeof objective}`);
			}
			if (tokenBudget !== undefined && !Number.isInteger(tokenBudget)) {
				throw new TypeError("token_budget must be an integer or undefined");
			}
			const payload = { objective };
			if (tokenBudget !== undefined) payload.token_budget = tokenBudget;
			return hostRequest("goal.create", payload);
		},

		/**
		 * Mark the existing thread goal achieved. Use only when the objective has
		 * actually been achieved and no required work remains.
		 */
		async complete() {
			return hostRequest("goal.complete", {});
		},
	};
}
