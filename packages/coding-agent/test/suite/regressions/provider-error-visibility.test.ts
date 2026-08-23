import { beforeAll, describe, expect, it, vi } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BUILTIN_SLASH_COMMANDS, builtinSlashCommandTakesArgument } from "../../../src/core/slash-commands.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createTrackedHarness, trackHarnesses } from "../helpers.js";

const harnesses = trackHarnesses();

describe("provider error visibility", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("includes the provider error in retry status", async () => {
		const harness = await createTrackedHarness(harnesses, {
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Provider rate limit exceeded" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		const retryEvents = harness.eventsOfType("auto_retry_start");
		expect(retryEvents.map((event) => event.errorMessage)).toEqual(["429 Provider rate limit exceeded"]);
		expect(retryEvents.map((event) => event.delayMs)).toEqual([1]);
	});

	it("announces a failed subagent and retains its error in the graph snapshot", () => {
		const errors: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			reportedSubagentErrors: new Set<string>(),
			showError: (message: string) => errors.push(message),
			refreshSubagentSummary: vi.fn(),
		});

		const child: AgentConnectionRlmChildAgentSnapshot = {
			id: "child-1",
			label: "worker",
			sessionName: "worker",
			status: "error",
			sessionDir: "/tmp/child-1",
			error: "429 Provider rate limit exceeded",
		};

		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: InteractiveMode,
			child: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		update.call(mode, child);

		expect(errors).toEqual(["Subagent worker failed: 429 Provider rate limit exceeded"]);
		expect(Reflect.get(mode, "subagentSnapshots")).toEqual(new Map([["child-1", child]]));
		expect(Reflect.get(mode, "refreshSubagentSummary")).toHaveBeenCalledOnce();

		update.call(mode, { ...child });
		expect(errors).toHaveLength(1);
	});

	it("exposes /rewind without accepting an argument", () => {
		const rewind = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rewind");
		expect(rewind).toMatchObject({
			description: "Return to an earlier session point without summarizing",
		});
		expect(builtinSlashCommandTakesArgument("rewind")).toBe(false);
	});
});
