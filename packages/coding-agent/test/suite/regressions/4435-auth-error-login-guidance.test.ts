import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness } from "../harness.js";
import { createTrackedHarness, trackHarnesses } from "../helpers.js";

const harnesses = trackHarnesses();

describe("issue #4435 auth error login guidance", () => {
	it("adds /login guidance to provider authentication errors", async () => {
		const harness = await createTrackedHarness(harnesses, { settings: { retry: { enabled: false } } });
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "401 Unauthorized: invalid API key",
			}),
		]);

		await harness.session.prompt("hello");

		const assistantMessages = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistantMessages[0]?.errorMessage).toContain("Run /login to update credentials.");
		expect(assistantMessages[0]?.errorMessage).not.toContain("/login faux");
	});

	it("adds /login guidance to authentication errors surfaced only on agent_end", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid API key",
		});
		const event = { type: "agent_end", messages: [message] } as AgentEvent;
		const session = harness.session as unknown as {
			_addLoginGuidanceToAuthError(event: AgentEvent): void;
		};

		session._addLoginGuidanceToAuthError(event);

		expect(message.errorMessage).toContain("Run /login to update credentials.");
	});
});
