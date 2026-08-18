import { afterEach, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("AgentSession.setThinkingLevel", () => {
	test("persists the level as the user default by default", async () => {
		harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true }],
			settings: { defaultThinkingLevel: "medium" },
		});
		const available = harness.session.getAvailableThinkingLevels();
		const target = available.find((level) => level !== harness?.session.thinkingLevel);
		expect(target).toBeDefined();

		harness.session.setThinkingLevel(target!);

		expect(harness.session.thinkingLevel).toBe(target);
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe(target);
	});

	test("leaves the user default untouched when persistDefault is false", async () => {
		// Automatic adjustments are scoped to the run that made them. Without this
		// gate, a single self-adjusting session silently rewrites a global setting
		// the user never chose.
		harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true }],
			settings: { defaultThinkingLevel: "medium" },
		});
		const before = harness.settingsManager.getDefaultThinkingLevel();
		const available = harness.session.getAvailableThinkingLevels();
		const target = available.find((level) => level !== harness?.session.thinkingLevel);
		expect(target).toBeDefined();

		harness.session.setThinkingLevel(target!, { persistDefault: false });

		expect(harness.session.thinkingLevel).toBe(target);
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe(before);
	});
});
