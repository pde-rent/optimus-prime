import { beforeAll, describe, expect, test, vi } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { StreamingCompactionComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import stripAnsi from "../src/utils/ansi.js";

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: unknown,
	event: Record<string, unknown>,
) => Promise<void>;

const startCompactionLoader = Reflect.get(InteractiveMode.prototype, "startCompactionLoader") as (
	this: unknown,
	reason: string,
	customInstructions?: string,
) => void;

function createFakeThis(overrides: Record<string, unknown> = {}) {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		updateConnectionStateFromEvent: vi.fn(),
		activityTracker: new AgentActivityTracker(),
		updateWorkingLoaderMessage: vi.fn(),
		autoCompactionLoader: undefined,
		compactionStreamingComponent: undefined,
		retryLoader: undefined,
		startCompactionLoader(this: Record<string, unknown>, reason: string, customInstructions?: string) {
			startCompactionLoader.call(this, reason, customInstructions);
		},
		beginCompactionStream(this: Record<string, unknown>) {
			(Reflect.get(InteractiveMode.prototype, "beginCompactionStream") as (this: unknown) => void).call(this);
		},
		endCompactionStream(this: Record<string, unknown>) {
			(Reflect.get(InteractiveMode.prototype, "endCompactionStream") as (this: unknown) => void).call(this);
		},
		workingVisible: true,
		stopWorkingLoader: vi.fn(),
		syncWorkingLoader: vi.fn(),
		defaultEditor: {},
		statusContainer: { clear: vi.fn() },
		chatContainer: new Container(),
		rebuildChatFromMessages: vi.fn(function (this: { chatContainer: { clear(): void } }) {
			this.chatContainer.clear();
			return Promise.resolve();
		}),
		addMessageToChat: vi.fn(),
		refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: vi.fn(),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		...overrides,
	};
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));

	test("shows an automatic compaction loader for the full operation", async () => {
		const statusContainer = new Container();
		const fakeThis = createFakeThis({ statusContainer });

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "threshold" });

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Auto-compacting");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		expect(statusContainer.children).toHaveLength(0);
	});

	test.each([
		{ name: "rebuilds successful compaction from its single persisted summary", refresh: "succeeds" },
		{ name: "keeps stale chat and reports a failed post-compaction refresh", refresh: "fails" },
	] as const)("$name", async ({ refresh }) => {
		const chatContainer = new Container();
		const clearSpy = vi.spyOn(chatContainer, "clear");
		const fakeThis = createFakeThis({
			chatContainer,
			...(refresh === "fails"
				? { rebuildChatFromMessages: vi.fn().mockRejectedValue(new Error("context unavailable")) }
				: {}),
		});

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "requested",
			result: { tokensBefore: 123, summary: "summary" },
			aborted: false,
			willRetry: false,
		});

		expect(clearSpy).toHaveBeenCalledTimes(refresh === "succeeds" ? 1 : 0);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledOnce();
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		if (refresh === "fails") {
			expect(fakeThis.showError).toHaveBeenCalledWith(
				"Compaction succeeded, but the transcript could not be refreshed: context unavailable",
			);
		} else {
			expect(fakeThis.showError).not.toHaveBeenCalled();
		}
	});

	test("shows manual warning-severity outcomes as warnings, not errors", async () => {
		const fakeThis = createFakeThis();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Session is too short to compact",
			errorSeverity: "warning",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith("Session is too short to compact");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("restores the compaction loader from state when no start event was seen", () => {
		const statusContainer = new Container();
		const fakeThis = createFakeThis({
			statusContainer,
			connectionState: { isCompacting: true },
			isAgentCompacting() {
				return true;
			},
			loadingAnimation: undefined,
			workingVisible: true,
			isAgentStreaming: () => false,
			stopWorkingLoader: vi.fn(),
			startWorkingLoader: vi.fn(),
		});

		(Reflect.get(InteractiveMode.prototype, "syncWorkingLoader") as (this: unknown) => void).call(fakeThis);

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Compacting context");
	});

	function findStreamBlock(container: Container): StreamingCompactionComponent | undefined {
		return container.children.find(
			(child): child is StreamingCompactionComponent => child instanceof StreamingCompactionComponent,
		);
	}

	test("streams a collapsible [compacting] block during compaction and collapses it after", async () => {
		const chatContainer = new Container();
		const fakeThis = createFakeThis({ chatContainer, statusContainer: new Container() });

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "manual" });
		const block = findStreamBlock(chatContainer);
		expect(block).toBeDefined();

		await handleEvent.call(fakeThis, {
			type: "compaction_partial",
			reason: "manual",
			partial: "## Goal\nfinish the refactor",
		});
		const collapsedRender = stripAnsi(chatContainer.render(120).join("\n"));
		expect(collapsedRender).toContain("[compacting]");
		expect(collapsedRender).toContain("Goal");

		// Global expand-all toggle applies to the streaming block.
		block!.setExpanded(true);
		const expandedRender = stripAnsi(chatContainer.render(120).join("\n"));
		expect(expandedRender).toContain("[compacting]");
		expect(expandedRender).toContain("finish the refactor");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("removes the streaming block on compaction_end, including aborted compactions", async () => {
		for (const aborted of [false, true]) {
			const chatContainer = new Container();
			const fakeThis = createFakeThis({ chatContainer, statusContainer: new Container() });

			await handleEvent.call(fakeThis, { type: "compaction_start", reason: "threshold" });
			await handleEvent.call(fakeThis, { type: "compaction_partial", reason: "threshold", partial: "partial" });
			expect(findStreamBlock(chatContainer)).toBeDefined();

			await handleEvent.call(fakeThis, {
				type: "compaction_end",
				reason: "threshold",
				result: aborted ? undefined : { tokensBefore: 5, summary: "summary" },
				aborted,
				willRetry: false,
			});
			expect(findStreamBlock(chatContainer)).toBeUndefined();
			expect(fakeThis.compactionStreamingComponent).toBeUndefined();
		}
	});
});
