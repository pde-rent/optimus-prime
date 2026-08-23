import { afterEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "./harness.js";

interface SentMessage {
	target: string;
	message: string;
}

type ChildHarness = Harness & { sentAgentMessages: SentMessage[] };

function echoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
		},
	};
}

function gatedTool(): { tool: AgentTool; release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await gate;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, release };
}

async function createChildHarness(
	options: { rlmDepth: number; tools?: AgentTool[] },
	rlmSessionDir: string,
): Promise<ChildHarness> {
	const sent: SentMessage[] = [];
	// A session dir lets the finished child stay visible in list_subagents.
	const harness = await createHarness({
		rlmDepth: options.rlmDepth,
		rlmSessionDir,
		...(options.tools ? { tools: options.tools } : {}),
		agentMessageController: {
			listAgents: () => ({ agents: [] }),
			sendAgentMessage: async (input) => {
				sent.push({ target: input.target, message: input.message });
				return {
					id: `receipt-${sent.length}`,
					source: "agent_message",
					target: { activeSessionId: "parent-active", sessionId: input.target },
					message: input.message,
					deliveryStatus: "delivered",
				};
			},
		},
	});
	// A git repo so the AUTO-REPORT tree/commits probes have deterministic answers.
	execFileSync("git", ["init", "-q"], { cwd: harness.tempDir });
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: harness.tempDir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: harness.tempDir });
	return Object.assign(harness, { sentAgentMessages: sent });
}

async function createParentHarness(child: Harness): Promise<Harness> {
	return createHarness({
		rlmDepth: 0,
		rlmMaxDepth: 1,
		subagentRuntimeHost: {
			createRlmSubagentRuntime: async () => ({ session: child.session }),
			deleteRlmSubagentRuntime: async () => {},
		},
	});
}

describe("rlm terminal auto-report", () => {
	let child: ChildHarness | undefined;
	let rlmSessionDir: string | undefined;
	let parent: Harness | undefined;

	afterEach(() => {
		if (rlmSessionDir) rmSync(rlmSessionDir, { recursive: true, force: true });
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("(a) a tool-only child gets an auto-report with the structured fields", async () => {
		rlmSessionDir = mkdtempSync(join(tmpdir(), "rlm-auto-report-"));
		child = await createChildHarness({ rlmDepth: 1, tools: [echoTool()] }, rlmSessionDir);
		parent = await createParentHarness(child);
		child.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "step one" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("finished the task"),
		]);

		await parent.session.runRlmChild("run tools only", { name: "tool-worker" });

		await expect.poll(() => child!.sentAgentMessages.length).toBe(1);
		const report = child.sentAgentMessages[0]?.message ?? "";
		expect(report.startsWith("AUTO-REPORT (completed) task=")).toBe(true);
		expect(report).toContain("| outcome: completed |");
		expect(report).toContain("| did: - finished the task |");
		expect(report).toContain("| tree: 0 dirty files under cwd |");
		expect(report).toContain("| commits: none |");
		expect(report).toContain("| needs: nothing");
		expect(report.length).toBeLessThanOrEqual(1500);

		// Tool activity happened, so the run is completed even without a reply.
		const listed = await parent.session.listRlmSubagents();
		expect(listed.subagents[0]?.status).toBe("completed");
	});

	it("(b) a child that replied does not get an auto-report", async () => {
		const { tool, release } = gatedTool();
		rlmSessionDir = mkdtempSync(join(tmpdir(), "rlm-auto-report-"));
		child = await createChildHarness({ rlmDepth: 1, tools: [tool] }, rlmSessionDir);
		parent = await createParentHarness(child);
		child.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("all done"),
		]);

		await parent.session.runRlmChild("reply when done", { name: "replier" });

		// Hold the run open mid-tool, reply like the agent_message skill wrapper would
		// (deliver + mark the session as having replied), then let the run finish.
		await vi.waitFor(() => expect(child!.eventsOfType("tool_execution_start").length).toBeGreaterThan(0), 5000);
		await child.session.handleAgentMessageHostRequest("agent_message.send", {
			target: parent.session.sessionId,
			message: "status: half done",
		});
		const childSession = child.session as unknown as {
			_repliedToParentSinceTask: boolean;
			_parentReplyCount: number;
		};
		childSession._repliedToParentSinceTask = true;
		childSession._parentReplyCount += 1;
		release();

		await vi.waitFor(async () => {
			const listed = await parent!.session.listRlmSubagents();
			expect(listed.subagents[0]?.status).toBe("completed");
		}, 5000);
		expect(child.sentAgentMessages.map((sent) => sent.message)).toEqual(["status: half done"]);
	});

	it("(c) an error-ended run still reports", async () => {
		rlmSessionDir = mkdtempSync(join(tmpdir(), "rlm-auto-report-"));
		child = await createChildHarness({ rlmDepth: 1 }, rlmSessionDir);
		parent = await createParentHarness(child);
		// An empty faux queue fails the first provider call with a non-retryable error.
		child.setResponses([]);

		await parent.session.runRlmChild("fail please", { name: "failure-case" });

		await vi.waitFor(async () => {
			const listed = await parent!.session.listRlmSubagents();
			expect(listed.subagents[0]?.status).toBe("error");
		}, 5000);
		await expect.poll(() => child!.sentAgentMessages.length).toBe(1);
		const report = child.sentAgentMessages[0]?.message ?? "";
		expect(report.startsWith("AUTO-REPORT (error) task=")).toBe(true);
		expect(report).toContain("| outcome: error |");
		expect(report).not.toContain("| needs: nothing");
	});

	it("(d) depth-0 children never report", async () => {
		rlmSessionDir = mkdtempSync(join(tmpdir(), "rlm-auto-report-"));
		child = await createChildHarness({ rlmDepth: 0 }, rlmSessionDir);
		parent = await createParentHarness(child);
		child.setResponses([fauxAssistantMessage("silent finish")]);

		await parent.session.runRlmChild("no reporting at depth 0", { name: "depth-zero" });

		await vi.waitFor(async () => {
			const listed = await parent!.session.listRlmSubagents();
			expect(listed.subagents[0]?.status).toBe("stalled");
		}, 5000);
		expect(child.sentAgentMessages.some((sent) => sent.message.startsWith("AUTO-REPORT"))).toBe(false);
	});

	it("(e) a silent run with no tool activity lists as stalled", async () => {
		rlmSessionDir = mkdtempSync(join(tmpdir(), "rlm-auto-report-"));
		child = await createChildHarness({ rlmDepth: 1 }, rlmSessionDir);
		parent = await createParentHarness(child);
		child.setResponses([fauxAssistantMessage("finished without doing anything")]);

		await parent.session.runRlmChild("idle finish", { name: "idle-worker" });

		await vi.waitFor(async () => {
			const listed = await parent!.session.listRlmSubagents();
			expect(listed.subagents[0]?.status).toBe("stalled");
		}, 5000);
	});
});
