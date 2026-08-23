import { describe, expect, it, vi } from "bun:test";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

type QueueState = { steering: string[]; followUp: string[] };

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

/**
 * Builds a bare InteractiveMode "this" exposing the queue-checkout internals.
 * Enter is exercised through the real setupEditorSubmitHandler closure so the
 * checkout submit path runs exactly as shipped.
 */
function createHarness(queue: QueueState, mutateResult = "applied") {
	let editorText = "";
	const self: Record<string, unknown> = {
		queueSelection: new QueueSelection(),
		connectionQueue: queue,
		isApplyingQueueSelectionText: false,
		pastedImages: new Map(),
		settingsManager: { getQueueMergeBehavior: vi.fn(() => "merge" as const) },
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		ui: { requestRender: vi.fn() },
		agentConnection: {
			mutateQueuedMessage: vi.fn(async () => mutateResult),
			prompt: vi.fn(async () => {}),
			getQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
			abort: vi.fn(async () => {}),
		},
		sessionEventGeneration: 0,
		inputSubmissionGeneration: 0,
		inputSubmissionsPending: 0,
		pendingPromptStashReleases: [],
		promptStashSessionId: "session",
		promptStashState: undefined,
		promptStash: undefined,
		latestEditorPromptStash: undefined,
		pendingSubmittedPromptStash: undefined,
		submittedInputBehavior: "steer",
		isShuttingDown: false,
		agentsViewRequest: undefined,
		sideQuestionComponent: undefined,
		connectionCommands: [],
		queueMutationChain: Promise.resolve(),
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
			addToHistory: vi.fn(),
			clearHistory: vi.fn(),
			restorePasteSnapshot: vi.fn(),
		},
		defaultEditor: { onSubmit: undefined as ((text: string) => Promise<void>) | undefined },
	};
	Object.assign(self, {
		enqueueQueueMutation: proto.enqueueQueueMutation,
		browseQueueSelection: proto.browseQueueSelection,
		cancelQueueCheckout: proto.cancelQueueCheckout,
		requeueCheckedOutOriginal: proto.requeueCheckedOutOriginal,
		settleCheckedOutPop: proto.settleCheckedOutPop,
		replaceConnectionQueue: proto.replaceConnectionQueue,
		requeueAfterWipe: proto.requeueAfterWipe,
		setEditorTextFromQueueSelection: proto.setEditorTextFromQueueSelection,
		snapshotPromptStash: (text: string) => ({ text }),
		clearShortcutGuide: vi.fn(),
		retainSubmittedDraft: vi.fn(),
		restorePromptStashIfEditorEmpty: vi.fn(),
		completeDeferredPromptStashRelease: vi.fn(),
		clearSideQuestion: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		collectImagesFor: vi.fn(() => undefined),
		hasPastedImagesFor: vi.fn(() => false),
	});
	(proto.setupEditorSubmitHandler as (this: unknown) => void).call(self);
	return self as unknown as {
		queueSelection: QueueSelection;
		connectionQueue: QueueState;
		editor: {
			getText: () => string;
			setText: (text: string) => void;
			addToHistory: ReturnType<typeof vi.fn>;
		};
		defaultEditor: { onSubmit: (text: string) => Promise<void> };
		settingsManager: { getQueueMergeBehavior: ReturnType<typeof vi.fn> };
		submittedInputBehavior: string;
		showStatus: ReturnType<typeof vi.fn>;
		showError: ReturnType<typeof vi.fn>;
		showWarning: ReturnType<typeof vi.fn>;
		ui: { requestRender: ReturnType<typeof vi.fn> };
		agentConnection: {
			mutateQueuedMessage: ReturnType<typeof vi.fn>;
			prompt: ReturnType<typeof vi.fn>;
		};
		pendingQueueEdit: symbol | undefined;
		checkoutDrained: Promise<boolean> | undefined;
		queueMutationChain: Promise<void>;
		browseQueueSelection: (direction: -1 | 1) => void;
		cancelQueueCheckout: () => void;
		replaceConnectionQueue: (queue: QueueState) => void;
	};
}

describe("interactive queued-message checkout editing", () => {
	it("pops the newest queued message: delete mutation first, then the editor shows it", async () => {
		const h = createHarness({ steering: ["s1"], followUp: ["f1", "f2"] });
		h.editor.setText("draft");
		h.browseQueueSelection(-1);

		await h.checkoutDrained;
		expect(h.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("followUp", 1, "f2", { type: "delete" });
		// popped text is only shown after the delete applied
		expect(h.editor.getText()).toBe("f2");
		// the pop removes the item from the local mirror immediately
		expect(h.connectionQueue).toEqual({ steering: ["s1"], followUp: ["f1"] });
		expect(h.queueSelection.checkedOut).toEqual({ lane: "followUp", originalIndex: 1, originalText: "f2" });
	});

	it("does not enter browse mode when nothing is queued and never mutates", () => {
		const h = createHarness({ steering: [], followUp: [] });
		h.browseQueueSelection(-1);
		expect(h.queueSelection.isBrowsing).toBe(false);
		expect(h.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
	});

	it("enter sends the edited text fresh through the normal pipeline and never reinserts", async () => {
		const h = createHarness({ steering: ["queued"], followUp: [] });
		h.browseQueueSelection(-1);
		await h.checkoutDrained;
		h.editor.setText("queued edited");

		await h.defaultEditor.onSubmit("queued edited");

		expect(h.agentConnection.prompt).toHaveBeenCalledWith("queued edited", {
			streamingBehavior: "steer",
			queueIfBusy: true,
			images: undefined,
		});
		// merge behavior: the original is NOT put back
		expect(h.agentConnection.prompt).toHaveBeenCalledTimes(1);
		expect(h.connectionQueue.steering).toEqual([]);
		expect(h.queueSelection.isBrowsing).toBe(false);
	});

	it("alt+enter sends the edit as a follow-up entry via the normal pipeline", async () => {
		const h = createHarness({ steering: ["queued"], followUp: [] });
		h.browseQueueSelection(-1);
		await h.checkoutDrained;
		h.submittedInputBehavior = "followUp";
		await h.defaultEditor.onSubmit("edited follow-up");
		expect(h.agentConnection.prompt).toHaveBeenCalledWith(
			"edited follow-up",
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
	});

	it("separate queueMergeBehavior re-queues the original and sends the edit as its own entry", async () => {
		const h = createHarness({ steering: ["original"], followUp: [] });
		h.settingsManager.getQueueMergeBehavior.mockReturnValue("separate");
		h.browseQueueSelection(-1);
		await h.checkoutDrained;

		await h.defaultEditor.onSubmit("edited");

		// one prompt for the re-queued original, one for the fresh edit
		expect(h.agentConnection.prompt).toHaveBeenCalledTimes(2);
		expect(h.agentConnection.prompt).toHaveBeenNthCalledWith(1, "original", {
			streamingBehavior: "steer",
			queueIfBusy: true,
		});
		expect(h.agentConnection.prompt).toHaveBeenNthCalledWith(2, "edited", expect.anything());
		expect(h.connectionQueue.steering).toEqual(["original"]);
	});

	it("escape cancels the checkout: original returns to its lane tail and the draft is restored", async () => {
		const h = createHarness({ steering: ["s1", "s2"], followUp: [] });
		h.editor.setText("draft");
		h.browseQueueSelection(-1);
		await h.checkoutDrained;
		expect(h.editor.getText()).toBe("s2");

		// the original index was consumed by an external delivery meanwhile
		h.connectionQueue.steering.splice(0, 1);
		h.cancelQueueCheckout();
		await h.checkoutDrained;

		expect(h.agentConnection.prompt).toHaveBeenCalledWith("s2", {
			streamingBehavior: "steer",
			queueIfBusy: true,
		});
		// index gone -> appended at the lane tail
		expect(h.connectionQueue.steering).toEqual(["s2"]);
		expect(h.queueSelection.isBrowsing).toBe(false);
		expect(h.editor.getText()).toBe("draft");
	});

	it("navigating back down to the draft reinserts like escape", async () => {
		const h = createHarness({ steering: [], followUp: ["f1"] });
		h.editor.setText("draft");
		h.browseQueueSelection(-1);
		await h.checkoutDrained;
		expect(h.queueSelection.isBrowsing).toBe(true);

		h.browseQueueSelection(1);
		await h.checkoutDrained;

		expect(h.agentConnection.prompt).toHaveBeenCalledWith("f1", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});
		expect(h.connectionQueue.followUp).toEqual(["f1"]);
		expect(h.editor.getText()).toBe("draft");
	});

	it("an empty enter on a checked-out item cancels instead of sending", async () => {
		const h = createHarness({ steering: ["queued"], followUp: [] });
		h.browseQueueSelection(-1);
		await h.checkoutDrained;

		await h.defaultEditor.onSubmit("   ");
		await h.checkoutDrained;

		expect(h.agentConnection.prompt).toHaveBeenCalledTimes(1); // reinsert only
		expect(h.connectionQueue.steering).toEqual(["queued"]);
		expect(h.queueSelection.isBrowsing).toBe(false);
	});

	it("a failed pop leaves the item queued and hands the editor back its draft", async () => {
		const h = createHarness({ steering: ["queued"], followUp: [] }, "rejected");
		h.editor.setText("draft");
		h.browseQueueSelection(-1);
		await h.checkoutDrained;

		expect(h.queueSelection.isBrowsing).toBe(false);
		expect(h.editor.getText()).toBe("draft");
		expect(h.showStatus).toHaveBeenCalledWith("Queue changed; item left in the queue");
		expect(h.connectionQueue.steering).toEqual(["queued"]);
	});

	it("an unsupported daemon surfaces the upgrade hint and keeps the draft", async () => {
		const h = createHarness({ steering: ["queued"], followUp: [] }, "unsupported");
		h.editor.setText("draft");
		h.browseQueueSelection(-1);
		await h.checkoutDrained;
		expect(h.showStatus).toHaveBeenCalledWith("Queue editing requires a newer daemon");
		expect(h.editor.getText()).toBe("draft");
	});

	it("rapid up-enter sequences serialize through the mutation chain before any send", async () => {
		let resolvePop: (status: string) => void = () => {};
		const h = createHarness({ steering: ["queued"], followUp: [] });
		h.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePop = resolve;
				}),
		);
		h.browseQueueSelection(-1);
		const submission = h.defaultEditor.onSubmit("edited");
		// the send waits for the pop to settle
		await vi.waitFor(() => expect(h.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());
		expect(h.agentConnection.prompt).not.toHaveBeenCalled();

		resolvePop("applied");
		await submission;
		expect(h.agentConnection.prompt).toHaveBeenCalledTimes(1);
		expect(h.connectionQueue.steering).toEqual([]);
	});

	it("requeues the checked-out original best-effort when the queue is wiped externally", async () => {
		const h = createHarness({ steering: ["kept", "held"], followUp: [] });
		h.browseQueueSelection(-1); // checks out "held"
		await h.checkoutDrained;
		expect(h.connectionQueue.steering).toEqual(["kept"]);

		// first snapshot after the pop is its echo; the next full clear is a wipe
		h.replaceConnectionQueue({ steering: ["kept"], followUp: [] });
		h.replaceConnectionQueue({ steering: [], followUp: [] });
		await h.checkoutDrained;

		expect(h.agentConnection.prompt).toHaveBeenCalledWith("held", {
			streamingBehavior: "steer",
			queueIfBusy: true,
		});
		expect(h.showWarning).toHaveBeenCalled();
		// the wipe took "kept"; the rescue appended the checked-out original
		expect(h.connectionQueue.steering).toEqual(["held"]);
		expect(h.queueSelection.isBrowsing).toBe(false);
	});

	it("treats the queue snapshot echoing its own pop as an echo, not a wipe", async () => {
		const h = createHarness({ steering: ["only"], followUp: [] });
		h.browseQueueSelection(-1);
		await h.checkoutDrained;

		h.replaceConnectionQueue({ steering: [], followUp: [] });
		await h.queueMutationChain;

		expect(h.agentConnection.prompt).not.toHaveBeenCalled();
		expect(h.queueSelection.isBrowsing).toBe(true); // still editing
	});
});

describe("restart with an active checkout surfaces the text", () => {
	it("keeps the original text in the editor and warns loudly on session reset", () => {
		let editorText = "";
		const self: Record<string, unknown> = {
			endFeatureHintRun: vi.fn(),
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			connectionQueue: { steering: ["held"], followUp: [] },
			pendingQueueEdit: undefined,
			queueSelection: new QueueSelection(),
			showWarning: vi.fn(),
			featureHintSuppressedByQueue: true,
			promptStash: undefined,
			promptStashState: undefined,
			defaultEditor: { clearHistory: vi.fn(), setText: vi.fn() },
			editor: { clearHistory: vi.fn(), setText: (t: string) => (editorText = t) },
			liveImageMarkerIds: () => new Set(),
			pastedImages: new Map(),
			streamingComponent: undefined,
			streamingMessage: undefined,
			activeBashComponent: undefined,
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 0,
			resetPendingToolState: vi.fn(),
			agentRunFileChanges: new Map(),
			expandedBlocks: new Set(),
			renderRecap: vi.fn(),
			replToolComponents: new Map(),
			lateReplSentAgentMessages: new Map(),
			resetSubagentSummary: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			getGoalState: () => ({}),
		};
		(self.queueSelection as QueueSelection).checkoutNewest({ steering: ["held"], followUp: [] }, "draft");

		(
			InteractiveMode.prototype as unknown as { resetCurrentSessionRenderState: (this: unknown) => void }
		).resetCurrentSessionRenderState.call(self);

		expect(self.showWarning).toHaveBeenCalled();
		expect(editorText).toBe("held");
		expect((self.queueSelection as QueueSelection).isBrowsing).toBe(false);
		expect(self.pendingQueueEdit).toBeUndefined();
	});
});

describe("interactive interrupt preserves the queue", () => {
	it("aborts without clearing or restoring queued messages", () => {
		const abort = vi.fn(async () => {});
		const harness = {
			traceUploadAllAbortController: undefined,
			sideQuestionEvent: undefined,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => true,
			agentConnection: { abort },
			showError: vi.fn(),
			editor: { getText: () => "", setText: vi.fn() },
		};
		(proto.interruptOrClearInput as (this: unknown) => void).call(harness);
		expect(abort).toHaveBeenCalledOnce();
		expect(harness.editor.setText).not.toHaveBeenCalled();
	});
});
