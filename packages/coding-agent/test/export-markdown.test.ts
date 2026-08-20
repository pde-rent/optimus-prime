import { describe, expect, it, vi } from "bun:test";
import { sessionJsonlToMarkdown } from "../src/core/export-markdown.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ExportCommandContext = {
	agentConnection: {
		exportToHtml: (outputPath?: string) => Promise<string>;
		exportToJsonl: (outputPath?: string) => Promise<string>;
	};
	copySessionToClipboard: () => Promise<void>;
	getPathCommandArgument: (text: string, command: "/export" | "/import") => string | undefined;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};

type InteractiveModePrototype = {
	handleExportCommand(this: ExportCommandContext, text: string): Promise<void>;
	getPathCommandArgument(this: unknown, text: string, command: "/export" | "/import"): string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function makeContext(overrides: Partial<ExportCommandContext> = {}): ExportCommandContext {
	return {
		agentConnection: {
			exportToHtml: vi.fn(async (outputPath?: string) => outputPath ?? "session.html"),
			exportToJsonl: vi.fn(async (outputPath?: string) => outputPath ?? "session.jsonl"),
		},
		copySessionToClipboard: vi.fn(async () => {}),
		getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		showError: vi.fn(),
		showStatus: vi.fn(),
		...overrides,
	};
}

const jsonl = [
	{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" },
	{ type: "message", id: "a", parentId: null, message: { role: "user", content: "hello" } },
	{
		type: "message",
		id: "b",
		parentId: "a",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal scratch" },
				{ type: "text", text: "running it" },
				{ type: "toolCall", id: "t1", name: "repl", arguments: { code: "1+1" } },
			],
		},
	},
	{
		type: "message",
		id: "c",
		parentId: "b",
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "repl",
			content: [{ type: "text", text: "2" }],
			isError: false,
		},
	},
	{ type: "custom_message", id: "d", parentId: "c", customType: "note", content: "shown", display: true },
	{ type: "custom_message", id: "e", parentId: "d", customType: "hidden", content: "not shown", display: false },
]
	.map((line) => JSON.stringify(line))
	.join("\n");

describe("sessionJsonlToMarkdown", () => {
	it("renders a readable transcript and drops model-internal thinking", () => {
		expect(sessionJsonlToMarkdown(jsonl)).toBe(
			[
				"# Session s1",
				"",
				"`/repo`",
				"",
				"## user",
				"",
				"hello",
				"",
				"## assistant",
				"",
				"running it",
				"",
				"**repl**",
				"",
				'```json\n{\n  "code": "1+1"\n}\n```',
				"",
				"### repl result",
				"",
				"```\n2\n```",
				"",
				"## note",
				"",
				"shown",
				"",
			].join("\n"),
		);
	});

	it("grows the fence past backtick runs inside tool output", () => {
		const withFence = JSON.stringify({
			type: "message",
			id: "a",
			parentId: null,
			message: {
				role: "toolResult",
				toolCallId: "t",
				toolName: "bash",
				content: [{ type: "text", text: "```\nx\n```" }],
			},
		});
		expect(sessionJsonlToMarkdown(withFence)).toBe("### bash result\n\n````\n```\nx\n```\n````\n");
	});

	it("marks failed tool results", () => {
		const failed = JSON.stringify({
			type: "message",
			id: "a",
			parentId: null,
			message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: "boom", isError: true },
		});
		expect(sessionJsonlToMarkdown(failed)).toContain("### bash result (error)");
	});
});

describe("InteractiveMode /export routing", () => {
	it("sends --clipboard and -c to the clipboard path instead of writing a file", async () => {
		for (const flag of ["--clipboard", "-c"]) {
			const context = makeContext();
			await interactiveModePrototype.handleExportCommand.call(context, `/export ${flag}`);

			expect(context.copySessionToClipboard).toHaveBeenCalledTimes(1);
			expect(context.agentConnection.exportToHtml).not.toHaveBeenCalled();
			expect(context.agentConnection.exportToJsonl).not.toHaveBeenCalled();
			expect(context.showError).not.toHaveBeenCalled();
		}
	});

	it("still writes files for the path forms", async () => {
		const html = makeContext();
		await interactiveModePrototype.handleExportCommand.call(html, "/export out.html");
		expect(html.agentConnection.exportToHtml).toHaveBeenCalledWith("out.html");
		expect(html.copySessionToClipboard).not.toHaveBeenCalled();

		const jsonlContext = makeContext();
		await interactiveModePrototype.handleExportCommand.call(jsonlContext, "/export out.jsonl");
		expect(jsonlContext.agentConnection.exportToJsonl).toHaveBeenCalledWith("out.jsonl");

		const bare = makeContext();
		await interactiveModePrototype.handleExportCommand.call(bare, "/export");
		expect(bare.agentConnection.exportToHtml).toHaveBeenCalledWith(undefined);
	});

	it("reports clipboard failures instead of throwing", async () => {
		const context = makeContext({
			copySessionToClipboard: vi.fn(async () => {
				throw new Error("Failed to copy to clipboard");
			}),
		});

		await interactiveModePrototype.handleExportCommand.call(context, "/export --clipboard");

		expect(context.showError).toHaveBeenCalledWith("Failed to export session: Failed to copy to clipboard");
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
