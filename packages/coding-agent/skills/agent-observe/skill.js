/**
 * Read-only Optimus Prime session observation skill.
 *
 * All session lookup and data access live in the host; these functions only
 * call the host bridge exposed inside the REPL.
 */
export default function createSkill({ hostRequest }) {
	return {
		/** List active sessions visible to this agent. */
		async list_agents() {
			return hostRequest("agent_observe.list", {});
		},

		/** Read one active session summary by active id, session id/name, or suffix. */
		async get_agent(target) {
			if (typeof target !== "string") {
				throw new TypeError(`target must be a string, got ${typeof target}`);
			}
			return hostRequest("agent_observe.get", { target });
		},

		/**
		 * Read bounded recent message previews from an active session.
		 * Host validates `limit` (1-50) and `maxChars` (80-2000).
		 */
		async recent_messages(target, limit = 8, maxChars = 800) {
			if (typeof target !== "string") {
				throw new TypeError(`target must be a string, got ${typeof target}`);
			}
			if (!Number.isInteger(limit)) throw new TypeError("limit must be an integer");
			if (!Number.isInteger(maxChars)) throw new TypeError("max_chars must be an integer");
			return hostRequest("agent_observe.recent", { target, limit, max_chars: maxChars });
		},
	};
}
