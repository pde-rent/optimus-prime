import { describe, expect, it } from "bun:test";
import { createAgentMessageHostHandlers } from "../src/core/agent-messages.js";
import { createHarness } from "./suite/harness.js";

const ROSTER = {
	current: { name: "worker-a", id: "a", depth: 1 },
	entries: [
		{ relationship: "parent" as const, name: "root", id: "p", depth: 0, status: "running" as const },
		{ relationship: "sibling" as const, name: "worker-b", id: "b", depth: 1, status: "running" as const },
		{ relationship: "sibling" as const, name: "worker-c", id: "c", depth: 1, status: "running" as const },
	],
};

function handlers(peerNames?: readonly string[]) {
	const sent: string[] = [];
	const api = createAgentMessageHostHandlers({
		roster: async () => ROSTER as never,
		sendAgentMessage: async (input) => {
			sent.push(input.target);
			return { status: "delivered", id: `m${sent.length}` } as never;
		},
		peerNames,
	});
	return { send: api["agent_message.send"]!, sent };
}

const to = (name: string) => ({ receiver_role: "sibling", receiver_name: name, message: "hi" });

describe("cohort edges", () => {
	it("leaves sibling reach untouched when no edges were declared", async () => {
		const { send, sent } = handlers(undefined);
		await send(to("worker-b"));
		expect(sent).toEqual(["b"]);
	});

	it("allows only declared peers", async () => {
		const { send, sent } = handlers(["worker-b"]);
		await send(to("worker-b"));
		expect(sent).toEqual(["b"]);
		await expect(send(to("worker-c"))).rejects.toThrow(/not a declared peer/);
		expect(sent).toEqual(["b"]);
	});

	it("treats an empty list as report-to-parent-only, and says how to reach the sibling", async () => {
		const { send, sent } = handlers([]);
		await expect(send(to("worker-b"))).rejects.toThrow(/no sibling peers/);
		await expect(send(to("worker-b"))).rejects.toThrow(/relay/);
		expect(sent).toEqual([]);
	});

	it("never blocks the parent, whatever the edges say", async () => {
		const { send, sent } = handlers([]);
		await send({ receiver_role: "parent", message: "done" });
		expect(sent).toEqual(["p"]);
	});

	it("accepts a peer named by id as well as by name", async () => {
		const { send, sent } = handlers(["c"]);
		await send(to("worker-c"));
		expect(sent).toEqual(["c"]);
	});
});

describe("cohort edge visibility", () => {
	it("publishes each child's declared edges on its snapshot", async () => {
		const harness = await createHarness({ provider: "faux-cohort-edges" });
		try {
			const undeclared = await harness.session.runRlmChild("summarize the repo", {});
			const parentOnly = await harness.session.runRlmChild("audit the parser", { peers: [] });
			const connected = await harness.session.runRlmChild("write the migration", {
				peers: ["reviewer", "tester"],
			});

			// filter().at(-1) rather than findLast: the test lib target predates ES2023.
			const snapshotFor = (childId: string) =>
				harness
					.eventsOfType("rlm_child_update")
					.map((event) => event.child)
					.filter((child) => child.id === childId)
					.at(-1);

			expect(snapshotFor(undeclared.rlm_child_id)?.peers).toBeUndefined();
			expect(snapshotFor(parentOnly.rlm_child_id)?.peers).toEqual([]);
			expect(snapshotFor(connected.rlm_child_id)?.peers).toEqual(["reviewer", "tester"]);
			// Parent-only is a declaration; undeclared is not. Only the second may omit the key,
			// because a snapshot merge spreads incoming over previous.
			expect("peers" in snapshotFor(parentOnly.rlm_child_id)!).toBe(true);
			expect("peers" in snapshotFor(undeclared.rlm_child_id)!).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
