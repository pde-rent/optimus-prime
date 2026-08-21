import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAssistantTexts, getUserTexts } from "../harness.js";
import { createTrackedHarness, trackHarnesses } from "../helpers.js";

const harnesses = trackHarnesses();

describe("issue #2023 queued slash-command follow-up", () => {
	it("treats extension-origin queued slash-command follow-ups as raw user text instead of dispatching the command", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const commandRuns: string[] = [];
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to release execution",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createTrackedHarness(harnesses, {
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first turn complete"),
			fauxAssistantMessage("queued follow-up handled by model"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("/testcmd queued", { deliverAs: "followUp" });
		releaseToolExecution?.();
		await promptPromise;

		expect(commandRuns).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["start", "/testcmd queued"]);
		expect(getAssistantTexts(harness)).toContain("queued follow-up handled by model");
	});
});
