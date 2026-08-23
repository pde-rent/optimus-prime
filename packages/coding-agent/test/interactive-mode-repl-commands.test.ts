import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type Context = {
	agentConnection: {
		executeReplCell: (
			code: string,
			options?: { timeoutSeconds?: number },
		) => Promise<{
			stdout: string;
			stderr: string;
			result?: string;
			status: "ok" | "error" | "aborted";
			error?: { ename: string; evalue: string; traceback: string[] };
		}>;
		listReplVariables: () => Promise<{ names: string[]; types: Record<string, string> }>;
		clearReplVariables: () => Promise<number>;
	};
	chatContainer: Container;
	ui: { requestRender: () => void };
	showError: (message: string) => void;
	echoLocalCommand: (text: string) => void;
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void };
	handleReplEvalCommand: (kind: string, canonicalText: string, code: string) => Promise<void>;
	handleVarsCommand: (canonicalText: string) => Promise<void>;
	handleClearVarsCommand: (canonicalText: string) => Promise<void>;
	handleKernelShimCommand: (name: string, canonicalText: string) => void;
	[key: string]: unknown;
};

type Prototype = {
	handleReplEvalCommand(this: Context, kind: string, canonicalText: string, code: string): Promise<void>;
	handleVarsCommand(this: Context, canonicalText: string): Promise<void>;
	handleClearVarsCommand(this: Context, canonicalText: string): Promise<void>;
	handleKernelShimCommand(this: Context, name: string, canonicalText: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function renderAll(container: Container, width = 120): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeContext(overrides: Partial<Context["agentConnection"]> = {}): Context {
	return {
		agentConnection: {
			executeReplCell: vi.fn(async () => ({ stdout: "", stderr: "", result: "42", status: "ok" as const })),
			listReplVariables: vi.fn(async () => ({
				names: ["total", "rows"],
				types: { total: "number", rows: "array" },
			})),
			clearReplVariables: vi.fn(async () => 2),
			...overrides,
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		echoLocalCommand: vi.fn(),
	};
}

describe("InteractiveMode REPL kernel commands", () => {
	beforeAll(() => initTheme("dark"));

	describe("/js evaluation", () => {
		it("renders the cell result as a pane", async () => {
			const context = makeContext();
			await prototype.handleReplEvalCommand.call(context, "js", "/js 40 + 2", "40 + 2");
			expect(context.agentConnection.executeReplCell).toHaveBeenCalledWith("40 + 2");
			const rendered = renderAll(context.chatContainer);
			expect(rendered).toContain("42");
			expect(rendered).toContain("=>");
		});

		it("roundtrips stdout alongside the result value", async () => {
			const context = makeContext({
				executeReplCell: vi.fn(async () => ({
					stdout: "hello\n",
					stderr: "",
					result: '"done"',
					status: "ok" as const,
				})),
			});
			await prototype.handleReplEvalCommand.call(context, "js", "/js console.log('hello')", "console.log('hello')");
			const rendered = renderAll(context.chatContainer);
			expect(rendered).toContain("hello");
			expect(rendered).toContain('"done"');
		});

		it("displays kernel errors cleanly through the pane, not showError", async () => {
			const context = makeContext({
				executeReplCell: vi.fn(async () => ({
					stdout: "",
					stderr: "",
					status: "error" as const,
					error: { ename: "TypeError", evalue: "x is not a function", traceback: ["at cell"] },
				})),
			});
			await prototype.handleReplEvalCommand.call(context, "js", "/js x()", "x()");
			expect(context.showError).not.toHaveBeenCalled();
			expect(renderAll(context.chatContainer)).toContain("TypeError: x is not a function");
		});

		it("surfaces transport failures through showError", async () => {
			const context = makeContext({
				executeReplCell: vi.fn(async () => {
					throw new Error("the daemon is running an older build; restart the daemon and try again");
				}),
			});
			await prototype.handleReplEvalCommand.call(context, "js", "/js 1", "1");
			expect(context.showError).toHaveBeenCalledWith(
				"the daemon is running an older build; restart the daemon and try again",
			);
		});
	});

	describe("/vars", () => {
		it("lists variables with type badges", async () => {
			const context = makeContext();
			await prototype.handleVarsCommand.call(context, "/vars");
			expect(context.agentConnection.listReplVariables).toHaveBeenCalledOnce();
			const rendered = renderAll(context.chatContainer);
			expect(rendered).toContain("REPL variables (2)");
			expect(rendered).toContain("total");
			expect(rendered).toContain("number");
			expect(rendered).toContain("rows");
			expect(rendered).toContain("array");
		});

		it("shows an empty state when nothing is defined", async () => {
			const context = makeContext({
				listReplVariables: vi.fn(async () => ({ names: [], types: {} })),
			});
			await prototype.handleVarsCommand.call(context, "/vars");
			expect(renderAll(context.chatContainer)).toContain("No variables defined.");
		});
	});

	describe("/clear-vars", () => {
		it("reports how many variables were removed", async () => {
			const context = makeContext();
			await prototype.handleClearVarsCommand.call(context, "/clear-vars");
			expect(context.agentConnection.clearReplVariables).toHaveBeenCalledOnce();
			expect(renderAll(context.chatContainer)).toContain("Cleared 2 variables.");
		});
	});

	describe("/bash and /python shims", () => {
		it("responds cleanly while the shim is unavailable", () => {
			const context = makeContext();
			prototype.handleKernelShimCommand.call(context, "python", "/python print(1)");
			expect(renderAll(context.chatContainer)).toContain("kernel python shim is not yet available");
		});
	});

	describe("dispatch", () => {
		function makeSubmitContext(handlers: Partial<SubmitContext>): SubmitContext {
			let editorText = "/js 1";
			return {
				defaultEditor: {},
				editor: {
					getText: () => editorText,
					setText: (text: string) => {
						editorText = text;
					},
				},
				submittedInputBehavior: "steer",
				inputSubmissionGeneration: 0,
				inputSubmissionsPending: 0,
				pendingPromptStashReleases: [],
				promptStashState: {},
				snapshotPromptStash: () => undefined,
				clearShortcutGuide: vi.fn(),
				...handlers,
			} as unknown as SubmitContext;
		}

		it("routes /js to the REPL eval handler and clears the editor", async () => {
			const handleReplEvalCommand = vi.fn(async () => {});
			const submitContext = makeSubmitContext({ handleReplEvalCommand });
			prototype.setupEditorSubmitHandler.call(submitContext);
			await submitContext.defaultEditor.onSubmit?.("/js 6 * 7");
			expect(handleReplEvalCommand).toHaveBeenCalledWith("js", "/js 6 * 7", "6 * 7");
		});

		it("routes /ts like /js", async () => {
			const handleReplEvalCommand = vi.fn(async () => {});
			const submitContext = makeSubmitContext({ handleReplEvalCommand });
			prototype.setupEditorSubmitHandler.call(submitContext);
			await submitContext.defaultEditor.onSubmit?.("/ts const x: number = 1;");
			expect(handleReplEvalCommand).toHaveBeenCalledWith("ts", "/ts const x: number = 1;", "const x: number = 1;");
		});

		it("routes /vars and /clear-vars", async () => {
			const handleVarsCommand = vi.fn(async () => {});
			const handleClearVarsCommand = vi.fn(async () => {});
			const submitContext = makeSubmitContext({ handleVarsCommand, handleClearVarsCommand });
			prototype.setupEditorSubmitHandler.call(submitContext);
			await submitContext.defaultEditor.onSubmit?.("/vars");
			expect(handleVarsCommand).toHaveBeenCalledWith("/vars");
			await submitContext.defaultEditor.onSubmit?.("/clear-vars");
			expect(handleClearVarsCommand).toHaveBeenCalledWith("/clear-vars");
		});
	});
});
