import { describe, expect, it } from "bun:test";
import { BunReplProvisioner } from "../src/core/bun-repl/provisioner.js";
import type { BashOperations } from "../src/core/tools/bash.js";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.js";

/**
 * Fake of the SettingsManager surface the timeout wiring consumes. Mirrors
 * getToolTimeoutReplMs/getToolTimeoutBashSeconds defaults (replMs floor 120000,
 * bashSeconds 0 = no default).
 */
function fakeSettings(toolTimeouts: { replMs?: number; bashSeconds?: number }) {
	return {
		getToolTimeoutReplMs: () =>
			toolTimeouts.replMs !== undefined && toolTimeouts.replMs > 0 ? toolTimeouts.replMs : 120_000,
		getToolTimeoutBashSeconds: () => toolTimeouts.bashSeconds ?? 0,
	};
}

/** Wire bash options exactly as agent-session.ts does for live sessions. */
function wiredBashDefinition(settings: ReturnType<typeof fakeSettings>, operations: BashOperations) {
	return createAllToolDefinitions(process.cwd(), {
		bash: { defaultTimeoutSeconds: settings.getToolTimeoutBashSeconds(), operations },
	}).bash;
}

function capturingOperations(timeouts: Array<number | undefined>): BashOperations {
	return {
		exec: async (_command, _cwd, options) => {
			timeouts.push(options.timeout);
			return { exitCode: 0 };
		},
	};
}

describe("tool timeout settings wiring", () => {
	it("bash execute uses the settings default when the call passes no timeout", async () => {
		const timeouts: Array<number | undefined> = [];
		const settings = fakeSettings({ bashSeconds: 90 });
		const definition = wiredBashDefinition(settings, capturingOperations(timeouts));
		await definition.execute("t1", { command: "true" }, undefined, undefined, {} as never);
		expect(timeouts).toEqual([90]);
	});

	it("bash per-call timeout overrides the settings default", async () => {
		const timeouts: Array<number | undefined> = [];
		const settings = fakeSettings({ bashSeconds: 90 });
		const definition = wiredBashDefinition(settings, capturingOperations(timeouts));
		await definition.execute("t2", { command: "true", timeout: 5 }, undefined, undefined, {} as never);
		expect(timeouts).toEqual([5]);
	});

	it("bash stays default-off when toolTimeouts.bashSeconds is unset", async () => {
		const timeouts: Array<number | undefined> = [];
		const settings = fakeSettings({});
		const definition = wiredBashDefinition(settings, capturingOperations(timeouts));
		await definition.execute("t3", { command: "true" }, undefined, undefined, {} as never);
		expect(timeouts).toEqual([undefined]);
	});

	it("createAllTools exposes a bash entry alongside repl/skill", () => {
		const settings = fakeSettings({ bashSeconds: 30 });
		const tools = createAllTools(process.cwd(), {
			bash: { defaultTimeoutSeconds: settings.getToolTimeoutBashSeconds() },
		});
		expect(tools.bash).toBeDefined();
		expect(tools.repl).toBeDefined();
		expect(tools.skill).toBeDefined();
	});

	it("provisioner receives the settings repl default as defaultTimeoutMs", () => {
		const settings = fakeSettings({ replMs: 45_000 });
		const provisioner = new BunReplProvisioner({
			defaultTimeoutMs: settings.getToolTimeoutReplMs(),
		});
		expect((provisioner as unknown as { options: { defaultTimeoutMs?: number } }).options.defaultTimeoutMs).toBe(
			45_000,
		);
		void provisioner.dispose();
	});
});
