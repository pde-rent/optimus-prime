import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getAssistantTexts } from "../harness.js";
import { createTrackedHarness, trackHarnesses } from "../helpers.js";

const harnesses = trackHarnesses();

describe("issue #3317 network connection lost retry", () => {
	it('retries transient "Network connection lost." failures', async () => {
		const harness = await createTrackedHarness(harnesses, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
			fauxAssistantMessage("recovered after reconnect"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			"Network connection lost.",
		]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(getAssistantTexts(harness)).toContain("recovered after reconnect");
	});
});
