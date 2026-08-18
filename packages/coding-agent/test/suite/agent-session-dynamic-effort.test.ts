import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AgentSession } from "../../src/core/agent-session.js";
import { normalizeRequestedRlmEffort } from "../../src/core/rlm-runtime.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * `bun:test` exposes a `vi` compat object but not `vi.waitFor`. Poll instead of
 * sleeping a fixed amount: a sleep either flakes under load or wastes the slack.
 */
async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw lastError ?? new Error("waitFor timed out");
}

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

// The faux catalog only reports xhigh/max when a model declares thinkingLevelMap,
// so `reasoning: true` gives exactly off/minimal/low/medium/high.
const reasoningModels = [{ id: "faux-1", reasoning: true }];

/**
 * The harness constructs the session directly, so `defaultThinkingLevel` is only
 * the floor here; the live level starts at the agent default. Seed both.
 */
async function createEffortHarness(
	options: {
		floor?: "off" | "minimal" | "low" | "medium" | "high";
		dynamicEffort?: "off" | "banded" | "free";
		extended?: boolean;
	} = {},
): Promise<Harness> {
	const floor = options.floor ?? "low";
	const created = await createHarness({
		models: reasoningModels,
		settings: {
			defaultThinkingLevel: floor,
			...(options.dynamicEffort ? { dynamicEffort: options.dynamicEffort } : {}),
		},
	});
	if (options.extended) {
		// Faux models expose xhigh/max only when the catalog maps them.
		created.getModel().thinkingLevelMap = { xhigh: "xhigh", max: "max" };
	}
	created.session.setThinkingLevel(floor);
	return created;
}

describe("normalizeRequestedRlmEffort", () => {
	test("passes through known levels and treats absence as inheritance", () => {
		expect(normalizeRequestedRlmEffort("high")).toBe("high");
		expect(normalizeRequestedRlmEffort(" HIGH ")).toBe("high");
		expect(normalizeRequestedRlmEffort(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmEffort(null)).toBeUndefined();
	});

	test("rejects non-string values", () => {
		expect(() => normalizeRequestedRlmEffort(3)).toThrow("rlm effort must be a string");
	});

	test("rejects unknown levels and lists the valid ones", () => {
		expect(() => normalizeRequestedRlmEffort("higher")).toThrow(
			"rlm effort must be one of: off, minimal, low, medium, high, xhigh, max",
		);
	});

	test("returns known-but-unsupported levels for downstream clamping", () => {
		expect(normalizeRequestedRlmEffort("max")).toBe("max");
	});
});

describe("rlm.run effort kwarg", () => {
	test("applies the requested level to the spawned child", async () => {
		harness = await createEffortHarness();
		harness.setResponses([fauxAssistantMessage("child answer")]);

		const spawned = await harness.session.runRlmChild("use explicit effort", { effort: "high" });

		expect(spawned.effort).toBe("high");
		await waitFor(() => {
			expect(harness?.session.getRlmChildSession(spawned.rlm_child_id)?.thinkingLevel).toBe("high");
		});
	});

	test("clamps an unsupported level instead of throwing", async () => {
		harness = await createEffortHarness();
		harness.setResponses([fauxAssistantMessage("child answer")]);

		const spawned = await harness.session.runRlmChild("ask for more than the model has", { effort: "max" });

		expect(harness.session.getAvailableThinkingLevels()).not.toContain("max");
		expect(spawned.effort).toBe("high");
	});

	test("inherits the parent level when effort is omitted", async () => {
		harness = await createEffortHarness({ floor: "minimal" });
		harness.setResponses([fauxAssistantMessage("child answer")]);

		const spawned = await harness.session.runRlmChild("inherit the parent level");

		expect(spawned.effort).toBe("minimal");
	});

	test("still rejects unknown kwargs", async () => {
		harness = await createHarness({ models: reasoningModels });

		await expect(harness.session.runRlmChild("typo kwarg", { efort: "high" })).rejects.toThrow(
			"Unsupported rlm.run kwargs: efort",
		);
		await expect(harness.session.runRlmChild("bad type", { effort: 3 })).rejects.toThrow(
			"rlm effort must be a string",
		);
	});
});

describe("AgentSession.setModelRequestedThinkingLevel", () => {
	test("never writes the user's global default", async () => {
		harness = await createEffortHarness();

		const result = harness.session.setModelRequestedThinkingLevel("high");

		expect(result).toEqual({ effort: "high", clamped: false });
		expect(harness.session.thinkingLevel).toBe("high");
		// The regression this guards: a self-adjusting session silently rewriting a
		// setting the user never touched. `/effort` (setThinkingLevel) still persists.
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");

		harness.session.setThinkingLevel("medium");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
	});

	test("reports clamping of a level the model does not support", async () => {
		harness = await createEffortHarness();
		harness.session.markEffortEscalationTrigger();

		expect(harness.session.setModelRequestedThinkingLevel("max")).toEqual({ effort: "high", clamped: true });
	});

	test("records the change with a model_self reason and no persisted default", async () => {
		harness = await createHarness({
			models: reasoningModels,
			settings: { defaultThinkingLevel: "low" },
			persistSession: true,
		});

		harness.session.setModelRequestedThinkingLevel("high");

		const entries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "thinking_level_change")
			.map((entry) => (entry as { thinkingLevel: string; reason?: string }).reason);
		expect(entries.at(-1)).toBe("model_self");
	});
});

describe("dynamic effort thrash guard", () => {
	test("caps the number of changes in one run and resets on the next", async () => {
		harness = await createEffortHarness();
		const session = harness.session;

		expect(session.setModelRequestedThinkingLevel("medium").effort).toBe("medium");
		expect(session.setModelRequestedThinkingLevel("high").effort).toBe("high");
		// Lowering is already refused after a raise, so spend the third change on a raise
		// that clamps to the same level: the cap counts applied changes only.
		expect(session.effortChangesThisRun).toBe(2);

		harness.setResponses([fauxAssistantMessage("done")]);
		await session.prompt("first run");
		expect(session.effortChangesThisRun).toBe(0);

		expect(session.setModelRequestedThinkingLevel("medium").effort).toBe("medium");
		expect(session.setModelRequestedThinkingLevel("high").effort).toBe("high");
		expect(session.setModelRequestedThinkingLevel("medium")).toMatchObject({ refused: "lower_after_raise" });
	});

	test("makes the fourth change in a run a no-op", async () => {
		harness = await createEffortHarness({ floor: "minimal" });
		const session = harness.session;

		// minimal -> low -> medium -> high uses the whole budget without ever lowering.
		expect(session.setModelRequestedThinkingLevel("low").effort).toBe("low");
		expect(session.setModelRequestedThinkingLevel("medium").effort).toBe("medium");
		expect(session.setModelRequestedThinkingLevel("high").effort).toBe("high");
		expect(session.effortChangesThisRun).toBe(3);

		session.markEffortEscalationTrigger();
		expect(session.setModelRequestedThinkingLevel("low")).toEqual({
			effort: "high",
			clamped: false,
			capped: true,
		});
		expect(session.thinkingLevel).toBe("high");
	});

	test("refuses to lower after raising, and allows it again on the next run", async () => {
		harness = await createEffortHarness();
		const session = harness.session;

		session.setModelRequestedThinkingLevel("high");
		expect(session.setModelRequestedThinkingLevel("medium")).toMatchObject({ refused: "lower_after_raise" });
		expect(session.thinkingLevel).toBe("high");

		harness.setResponses([fauxAssistantMessage("done")]);
		await session.prompt("next run");

		expect(session.setModelRequestedThinkingLevel("medium").effort).toBe("medium");
	});
});

describe("dynamic effort modes", () => {
	test("banded mode refuses xhigh/max without an escalation trigger", async () => {
		harness = await createEffortHarness({ extended: true });
		const session = harness.session;
		expect(session.getAvailableThinkingLevels()).toContain("max");

		expect(session.setModelRequestedThinkingLevel("xhigh")).toMatchObject({ refused: "band" });
		expect(session.thinkingLevel).toBe("low");

		session.markEffortEscalationTrigger();
		expect(session.setModelRequestedThinkingLevel("xhigh").effort).toBe("xhigh");
	});

	test("banded mode keeps the configured level as a floor and off as user-only", async () => {
		harness = await createEffortHarness({ floor: "medium" });
		const session = harness.session;

		expect(session.setModelRequestedThinkingLevel("low")).toMatchObject({ refused: "floor" });
		expect(session.setModelRequestedThinkingLevel("off")).toMatchObject({ refused: "floor" });
		expect(session.thinkingLevel).toBe("medium");
	});

	test("free mode drops the band but keeps the thrash guard", async () => {
		harness = await createEffortHarness({ dynamicEffort: "free", extended: true });
		const session = harness.session;

		expect(session.setModelRequestedThinkingLevel("max").effort).toBe("max");
		expect(session.setModelRequestedThinkingLevel("medium")).toMatchObject({ refused: "lower_after_raise" });
	});

	test("off mode restores static behavior", async () => {
		harness = await createEffortHarness({ dynamicEffort: "off" });
		const session = harness.session;

		expect(session.setModelRequestedThinkingLevel("high")).toEqual({
			effort: "low",
			clamped: false,
			refused: "disabled",
		});
		expect(session.thinkingLevel).toBe("low");
		expect(session.effortChangesThisRun).toBe(0);
	});
});

describe("escalation triggers", () => {
	test("three consecutive failures of one tool admit an above-band level", async () => {
		harness = await createEffortHarness({ extended: true });
		const session = harness.session;
		const record = (
			session as unknown as { _recordEffortToolOutcome(toolName: string, isError: boolean): void }
		)._recordEffortToolOutcome.bind(session);

		record("ipython", true);
		record("ipython", true);
		expect(session.effortEscalationTriggered).toBe(false);
		record("ipython", true);
		expect(session.effortEscalationTriggered).toBe(true);
		expect(session.setModelRequestedThinkingLevel("xhigh").effort).toBe("xhigh");
	});

	test("a success resets the streak for that tool", async () => {
		harness = await createHarness({ models: reasoningModels });
		const session = harness.session;
		const record = (
			session as unknown as { _recordEffortToolOutcome(toolName: string, isError: boolean): void }
		)._recordEffortToolOutcome.bind(session);

		record("ipython", true);
		record("ipython", true);
		record("ipython", false);
		record("ipython", true);
		expect(session.effortEscalationTriggered).toBe(false);
	});

	test("a user interrupt carries its trigger into the next run", async () => {
		harness = await createEffortHarness();
		const session = harness.session;

		session.requestAbort();
		harness.setResponses([fauxAssistantMessage("done")]);
		await session.prompt("run after interrupt");

		expect(session.effortEscalationTriggered).toBe(true);
	});
});

describe("rlm effort host handlers", () => {
	test("expose get_effort and set_effort through the kernel bridge", async () => {
		harness = await createEffortHarness();
		const handlers = (
			harness.session as unknown as {
				_createKernelHostHandlers(): Record<
					string,
					(payload: Record<string, unknown>) => Promise<Record<string, unknown>>
				>;
			}
		)._createKernelHostHandlers();

		await expect(handlers["rlm.get_effort"]?.({})).resolves.toEqual({
			effort: "low",
			available: ["off", "minimal", "low", "medium", "high"],
		});
		await expect(handlers["rlm.set_effort"]?.({ level: "high" })).resolves.toEqual({
			effort: "high",
			clamped: false,
		});
		await expect(handlers["rlm.set_effort"]?.({ level: "hihg" })).rejects.toThrow("rlm effort must be one of");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
	});
});

describe("dynamic depth and graph settings", () => {
	test("dynamicDepth: false refuses a model-initiated depth raise", async () => {
		const session = {
			_rlmMaxDepth: 1,
			_effortEscalationTriggered: true,
			_depthChangesThisRun: 0,
			settingsManager: { getDynamicDepth: () => false },
			setRlmMaxDepth: async function (n: number) {
				(this as { _rlmMaxDepth: number })._rlmMaxDepth = n;
			},
		};
		const result = await (
			AgentSession.prototype as unknown as {
				setModelRequestedMaxDepth: (this: unknown, n: number) => Promise<{ max_depth: number; refused?: string }>;
			}
		).setModelRequestedMaxDepth.call(session, 2);
		expect(result.refused).toBe("disabled");
		expect(result.max_depth).toBe(1);
		expect(session._rlmMaxDepth).toBe(1);
	});

	test("dynamicDepth defaults to enabled", async () => {
		const session = {
			_rlmMaxDepth: 1,
			_effortEscalationTriggered: true,
			_depthChangesThisRun: 0,
			settingsManager: { getDynamicDepth: () => true },
			setRlmMaxDepth: async function (n: number) {
				(this as { _rlmMaxDepth: number })._rlmMaxDepth = n;
			},
		};
		const result = await (
			AgentSession.prototype as unknown as {
				setModelRequestedMaxDepth: (this: unknown, n: number) => Promise<{ max_depth: number; refused?: string }>;
			}
		).setModelRequestedMaxDepth.call(session, 2);
		expect(result.refused).toBeUndefined();
		expect(result.max_depth).toBe(2);
	});
});
