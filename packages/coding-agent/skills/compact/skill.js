/**
 * Prime Agent compact skill: context compaction control from the REPL.
 *
 * Compaction runs host-side (the same implementation as /compact); these
 * functions are thin typed wrappers over the generic host bridge.
 */
export default function createSkill({ hostRequest }) {
	return {
		/**
		 * Read current context usage: `{ tokens, context_window, percent, scheduled }`.
		 * `percent` is null right after a compaction until the next model response.
		 */
		async status() {
			return hostRequest("compact.status", {});
		},

		/**
		 * Schedule context compaction. Never runs mid-cell: it runs when the current
		 * turn ends and the harness resumes you automatically afterwards. Returns
		 * `{ scheduled: true }`, or `{ scheduled: false, reason }` when there is
		 * nothing to compact. Optional `instructions` focus the summary.
		 */
		async run(instructions) {
			if (instructions !== undefined && typeof instructions !== "string") {
				throw new TypeError(`instructions must be a string, got ${typeof instructions}`);
			}
			return hostRequest("compact.run", instructions === undefined ? {} : { instructions });
		},
	};
}
