import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { parseReplBashCell } from "../../../src/core/tools/code-preview.js";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const replTool: AgentTool = {
	name: "repl",
	label: "repl",
	description: "Execute a test REPL cell",
	parameters: Type.Object({ code: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "" }],
		details: { status: "ok" },
	}),
};

describe("ENG-4529 leading newline before %%bash", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("parses blank lines, indentation, arguments, and CRLF before the bash body", () => {
		expect(parseReplBashCell(" \r\n\t\r\n  %%bash --noprofile\r\necho ok")).toEqual({
			leadingWhitespace: " \r\n\t\r\n",
			indent: "  ",
			magicArguments: " --noprofile",
			lineBreak: "\r\n",
			body: "echo ok",
		});
		expect(parseReplBashCell('\nconsole.log("hi")')).toBeUndefined();
	});

	it("renders a generated bash cell with a leading newline as bash", async () => {
		const code = "\n%%bash\ncd /tmp";
		harness = await createHarness({ tools: [replTool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("repl", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the command");

		const start = harness.eventsOfType("tool_execution_start")[0];
		expect(start).toMatchObject({ toolName: "repl", args: { code } });
		if (!start) {
			throw new Error("Expected a repl tool call");
		}

		const component = new ToolExecutionComponent(
			start.toolName,
			start.toolCallId,
			start.args,
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			harness.tempDir,
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({ content: [], details: { status: "ok" }, isError: false });

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("✓ bash · cd /tmp · ↑ 1 lines");
	});
});
