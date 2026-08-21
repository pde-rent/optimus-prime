import { describe, expect, it } from "bun:test";
import { DAEMON_COMMAND_COMPATIBILITY } from "../src/modes/daemon/daemon-protocol.js";
import { DAEMON_COMMAND_TYPES } from "../src/modes/daemon/daemon-shared.js";

/**
 * The supervisor rejects any command outside `DAEMON_COMMAND_TYPES` before it reaches a worker, so
 * a command that exists in the protocol but not in that set is accepted by the type system, shipped,
 * and then fails at runtime with "Unknown daemon command". That happened to `set_graph_resolver`:
 * the handler and the compatibility entry were added, but one of three hand-maintained copies of
 * the routable set was not.
 */
describe("daemon command routing", () => {
	it("routes every command the protocol declares", () => {
		const declared = Object.keys(DAEMON_COMMAND_COMPATIBILITY).sort();
		const missing = declared.filter((command) => !DAEMON_COMMAND_TYPES.has(command));
		expect(missing).toEqual([]);
	});

	it("does not route commands the protocol does not declare", () => {
		const declared = new Set(Object.keys(DAEMON_COMMAND_COMPATIBILITY));
		const extra = [...DAEMON_COMMAND_TYPES].filter((command) => !declared.has(command)).sort();
		expect(extra).toEqual([]);
	});

	it("routes the commands the settings surfaces depend on", () => {
		// Named explicitly because each is reachable from a slash command or a settings row, so a
		// regression here is a user-visible error rather than a silent gap.
		for (const command of ["set_graph_resolver", "set_rlm_max_depth", "set_thinking_level"]) {
			if (command in DAEMON_COMMAND_COMPATIBILITY) {
				expect(DAEMON_COMMAND_TYPES.has(command)).toBe(true);
			}
		}
	});
});
