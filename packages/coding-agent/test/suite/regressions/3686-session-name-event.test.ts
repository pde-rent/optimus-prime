import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "../../../src/index.js";
import { createHarness } from "../harness.js";
import { createTrackedHarness, trackHarnesses } from "../helpers.js";

const harnesses = trackHarnesses();

describe("regression #3686: session name changes emit an event", () => {
	it("emits session_info_changed when AgentSession.setSessionName is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setSessionName("hello world");

		expect(harness.sessionManager.getSessionName()).toBe("hello world");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["hello world"]);
	});

	it("emits session_info_changed when an extension calls pi.setSessionName", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createTrackedHarness(harnesses, {
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});

		api?.setSessionName("from extension");

		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["from extension"]);
	});
});
