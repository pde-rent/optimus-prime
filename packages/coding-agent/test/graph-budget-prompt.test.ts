import { afterEach, describe, expect, it, mock } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * Exhaustion prompts. The graph budget and the depth ceiling refuse a spawn at admission; with an
 * injected callback (or a bound extension UI) the host prompts instead of failing. These tests use
 * fake callbacks; the TUI wiring is a plain select() over the same choices.
 */

const TEST_TIMEOUT = 30_000;

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function childSettled(harness: Harness, childId: string): boolean {
	return harness
		.eventsOfType("rlm_child_update")
		.some((event) => event.child.id === childId && event.child.status === "done");
}

/** Spawn one child with a queued response and wait for it to settle. */
async function runChild(harness: Harness, prompt: string): Promise<string> {
	harness.appendResponses([fauxAssistantMessage("ok")]);
	const handle = await harness.session.runRlmChild(prompt);
	await until(() => childSettled(harness, handle.rlm_child_id), `child "${prompt}"`);
	return handle.rlm_child_id;
}

/** Settles four children so the next spawn exceeds the low level's node cap (4). */
async function exhaustNodeCap(harness: Harness): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await runChild(harness, `filler ${i}`);
	}
}

describe("graph budget exhaustion prompt", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it(
		"defaults to reset with a best-effort warning when no callback is injected",
		async () => {
			const warns: string[] = [];
			const warn = mock((message?: unknown) => warns.push(String(message)));
			const originalWarn = console.warn;
			console.warn = warn;
			try {
				harness = await createHarness({ settings: { graphResolver: "low" } });
				await exhaustNodeCap(harness);
				await runChild(harness, "fifth");
				expect(warns.some((w) => w.includes("Graph budget exhausted"))).toBe(true);
			} finally {
				console.warn = originalWarn;
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"reset zeroes the meter and admits the next spawn",
		async () => {
			const calls: unknown[] = [];
			harness = await createHarness({
				settings: { graphResolver: "low" },
				budgetExhausted: async (info) => {
					calls.push(info);
					return "reset";
				},
			});
			await exhaustNodeCap(harness);
			await runChild(harness, "fifth");
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ level: "low", nodes: 4, maxNodes: 4 });
		},
		TEST_TIMEOUT,
	);

	it(
		"tier moves the dial one level up",
		async () => {
			harness = await createHarness({
				settings: { graphResolver: "low" },
				budgetExhausted: async () => "tier",
			});
			await exhaustNodeCap(harness);
			await runChild(harness, "fifth");
			expect(harness.settingsManager.getGraphResolver()).toBe("medium");
		},
		TEST_TIMEOUT,
	);

	it(
		"unlimited removes the ceiling entirely",
		async () => {
			let prompted = 0;
			harness = await createHarness({
				settings: { graphResolver: "low" },
				budgetExhausted: async () => {
					prompted += 1;
					return "unlimited";
				},
			});
			await exhaustNodeCap(harness);
			await runChild(harness, "fifth");
			expect(harness.settingsManager.getGraphResolver()).toBe("unlimited");
			// No ceiling means no further prompting even after several more children.
			for (let i = 0; i < 3; i++) {
				await runChild(harness, `extra ${i}`);
			}
			expect(prompted).toBe(1);
		},
		TEST_TIMEOUT,
	);

	it(
		"cancel throws the exhaustion error at the calling agent",
		async () => {
			harness = await createHarness({
				settings: { graphResolver: "low" },
				budgetExhausted: async () => "cancel",
			});
			await exhaustNodeCap(harness);
			expect(harness.session.runRlmChild("refused")).rejects.toThrow(/Graph budget exhausted/);
		},
		TEST_TIMEOUT,
	);
});

describe("depth limit prompt", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it(
		"defaults to raising one step with a best-effort warning when no callback is injected",
		async () => {
			const warns: string[] = [];
			const warn = mock((message?: unknown) => warns.push(String(message)));
			const originalWarn = console.warn;
			console.warn = warn;
			try {
				harness = await createHarness({ rlmDepth: 1, rlmMaxDepth: 1 });
				await runChild(harness, "first");
				expect(warns.some((w) => w.includes("depth limit"))).toBe(true);
			} finally {
				console.warn = originalWarn;
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"raise writes a chat-scoped entry one step higher",
		async () => {
			harness = await createHarness({
				rlmDepth: 1,
				rlmMaxDepth: 1,
				depthExhausted: async () => "raise",
			});
			await runChild(harness, "first");
			expect(harness.session.rlmMaxDepth).toBe(2);
			expect(harness.session.getRlmMaxDepthStatus()).toMatchObject({ maxDepth: 2, source: "chat" });
		},
		TEST_TIMEOUT,
	);

	it(
		"unlimited removes the ceiling for this session",
		async () => {
			let prompted = 0;
			harness = await createHarness({
				rlmDepth: 1,
				rlmMaxDepth: 1,
				depthExhausted: async () => {
					prompted += 1;
					return "unlimited";
				},
			});
			await runChild(harness, "first");
			expect(harness.session.rlmMaxDepth).toBe("unlimited");
			// Grandchildren now admit without prompting again.
			await runChild(harness, "deeper");
			expect(prompted).toBe(1);
		},
		TEST_TIMEOUT,
	);

	it(
		"cancel throws the depth error at the calling agent",
		async () => {
			harness = await createHarness({
				rlmDepth: 1,
				rlmMaxDepth: 1,
				depthExhausted: async () => "cancel",
			});
			expect(harness.session.runRlmChild("refused")).rejects.toThrow(/depth limit reached/);
		},
		TEST_TIMEOUT,
	);
});

describe("rlmMaxDepth unlimited resolution", () => {
	it("resolves the global setting to an unlimited ceiling", async () => {
		const harness = await createHarness({ settings: { rlmMaxDepth: "unlimited" } });
		try {
			expect(harness.session.getRlmMaxDepthStatus()).toEqual({ maxDepth: "unlimited", source: "global" });
		} finally {
			harness.cleanup();
		}
	});

	it("resolves RLM_MAX_DEPTH=unlimited from the environment", async () => {
		let local: Harness | undefined;
		const previous = process.env.RLM_MAX_DEPTH;
		process.env.RLM_MAX_DEPTH = "unlimited";
		try {
			local = await createHarness({});
			expect(local.session.getRlmMaxDepthStatus()).toEqual({ maxDepth: "unlimited", source: "env" });
		} finally {
			if (previous === undefined) delete process.env.RLM_MAX_DEPTH;
			else process.env.RLM_MAX_DEPTH = previous;
			local?.cleanup();
		}
	});
});
