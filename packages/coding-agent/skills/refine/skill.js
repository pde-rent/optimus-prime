/**
 * Optimus Prime refine skill: continual harness refinement from the REPL.
 *
 * Refinement runs host-side (the same implementation as /refine); these
 * functions are thin typed wrappers over the generic host bridge.
 */
export default function createSkill({ hostRequest }) {
	return {
		/** Read refine state: `{ pending, in_flight }`. */
		async status() {
			return hostRequest("refine.status", {});
		},

		/**
		 * Schedule continual harness refinement. Never runs mid-cell: it runs when
		 * the current turn ends, then the harness rebuilds the system prompt and
		 * resumes you. Returns `{ scheduled: true }` or `{ scheduled: false, reason }`.
		 *
		 * @param {{ instructions?: string, global?: boolean }} [options]
		 */
		async run(options = {}) {
			const { instructions, global: isGlobal = false } = options;
			if (instructions !== undefined && typeof instructions !== "string") {
				throw new TypeError(`instructions must be a string, got ${typeof instructions}`);
			}
			if (typeof isGlobal !== "boolean") {
				throw new TypeError(`global must be a boolean, got ${typeof isGlobal}`);
			}
			const payload = {};
			if (instructions !== undefined) payload.instructions = instructions;
			if (isGlobal) payload.global = true;
			return hostRequest("refine.run", payload);
		},
	};
}
