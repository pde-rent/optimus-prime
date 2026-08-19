import { describe, expect, it } from "vitest";
import { createAgentMessageHostHandlers } from "../src/core/agent-messages.js";

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
