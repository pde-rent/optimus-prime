/**
 * Tests for compaction extension events (before_compact / compact).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionEvent,
} from "../src/core/extensions/index.js";
import { createHarness, type Harness } from "./suite/harness.js";

const SUMMARY_TEXT = "scripted compaction summary";

/**
 * Compaction can issue a second summarization call for a split turn prefix, so
 * queue spare summary steps beyond the scripted turn replies.
 */
function responses(turnCount: number): FauxResponseStep[] {
	return [
		...Array.from({ length: turnCount }, (_, index) => fauxAssistantMessage(`turn reply ${index + 1}`)),
		...Array.from({ length: 3 }, () => fauxAssistantMessage(SUMMARY_TEXT)),
	];
}

describe("Compaction extensions", () => {
	const harnesses: Harness[] = [];
	let capturedEvents: SessionEvent[] = [];

	afterEach(() => {
		capturedEvents = [];
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function capturingExtension(
		onBeforeCompact?: (event: SessionBeforeCompactEvent) => { cancel?: boolean; compaction?: unknown } | undefined,
		onCompact?: (event: SessionCompactEvent) => void,
	): ExtensionFactory {
		return (pi) => {
			pi.on("session_before_compact", async (event) => {
				capturedEvents.push(event as SessionEvent);
				return onBeforeCompact?.(event as SessionBeforeCompactEvent) as never;
			});
			pi.on("session_compact", async (event) => {
				capturedEvents.push(event as SessionEvent);
				onCompact?.(event as SessionCompactEvent);
			});
		};
	}

	async function createSession(extensionFactories: ExtensionFactory[], turnCount: number): Promise<Harness> {
		const harness = await createHarness({
			systemPrompt: "You are a helpful assistant. Be concise.",
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories,
		});
		harnesses.push(harness);
		harness.setResponses(responses(turnCount));
		return harness;
	}

	it("should emit before_compact and compact events", async () => {
		const harness = await createSession([capturingExtension()], 2);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const beforeCompactEvents = capturedEvents.filter(
			(e): e is SessionBeforeCompactEvent => e.type === "session_before_compact",
		);
		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");

		expect(beforeCompactEvents.length).toBe(1);
		expect(compactEvents.length).toBe(1);

		const beforeEvent = beforeCompactEvents[0];
		expect(beforeEvent.preparation).toBeDefined();
		expect(beforeEvent.preparation.messagesToSummarize).toBeDefined();
		expect(beforeEvent.preparation.turnPrefixMessages).toBeDefined();
		expect(beforeEvent.preparation.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(typeof beforeEvent.preparation.isSplitTurn).toBe("boolean");
		expect(beforeEvent.branchEntries).toBeDefined();
		// sessionManager, modelRegistry, and model are now on ctx, not event

		const afterEvent = compactEvents[0];
		expect(afterEvent.compactionEntry).toBeDefined();
		expect(afterEvent.compactionEntry.summary).toContain(SUMMARY_TEXT);
		expect(afterEvent.compactionEntry.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(afterEvent.fromExtension).toBe(false);
	});

	it("should allow extensions to cancel compaction", async () => {
		const harness = await createSession([capturingExtension(() => ({ cancel: true }))], 1);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await expect(session.compact()).rejects.toThrow("Compaction cancelled");

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(0);
	});

	it("should allow extensions to provide custom compaction", async () => {
		const customSummary = "Custom summary from extension";

		const harness = await createSession(
			[
				capturingExtension((event) => ({
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				})),
			],
			2,
		);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);

		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		expect(afterEvent.compactionEntry.summary).toBe(customSummary);
		expect(afterEvent.fromExtension).toBe(true);
	});

	it("should include entries in compact event after compaction is saved", async () => {
		const harness = await createSession([capturingExtension()], 1);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		// sessionManager is now on ctx, use session.sessionManager directly
		const entries = session.sessionManager.getEntries();
		const hasCompactionEntry = entries.some((e: { type: string }) => e.type === "compaction");
		expect(hasCompactionEntry).toBe(true);
	});

	it("should continue with default compaction if extension throws error", async () => {
		const harness = await createSession(
			[
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						capturedEvents.push(event as SessionEvent);
						throw new Error("Extension intentionally throws");
					});
					pi.on("session_compact", async (event) => {
						capturedEvents.push(event as SessionEvent);
					});
				},
			],
			1,
		);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toContain(SUMMARY_TEXT);

		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);
		expect(compactEvents[0].fromExtension).toBe(false);
	});

	it("should call multiple extensions in order", async () => {
		const callOrder: string[] = [];

		const harness = await createSession(
			[
				(pi) => {
					pi.on("session_before_compact", async () => {
						callOrder.push("extension1-before");
					});
					pi.on("session_compact", async () => {
						callOrder.push("extension1-after");
					});
				},
				(pi) => {
					pi.on("session_before_compact", async () => {
						callOrder.push("extension2-before");
					});
					pi.on("session_compact", async () => {
						callOrder.push("extension2-after");
					});
				},
			],
			1,
		);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(callOrder).toEqual(["extension1-before", "extension2-before", "extension1-after", "extension2-after"]);
	});

	it("should pass correct data in before_compact event", async () => {
		let capturedBeforeEvent: SessionBeforeCompactEvent | undefined;

		const harness = await createSession(
			[
				capturingExtension((event) => {
					capturedBeforeEvent = event;
					return undefined;
				}),
			],
			2,
		);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(capturedBeforeEvent).toBeDefined();
		const event = capturedBeforeEvent!;
		expect(typeof event.preparation.isSplitTurn).toBe("boolean");
		expect(event.preparation.firstKeptEntryId).toBeDefined();

		expect(Array.isArray(event.preparation.messagesToSummarize)).toBe(true);
		expect(Array.isArray(event.preparation.turnPrefixMessages)).toBe(true);

		expect(typeof event.preparation.tokensBefore).toBe("number");

		expect(Array.isArray(event.branchEntries)).toBe(true);

		// sessionManager, modelRegistry, and model are now on ctx, not event
		// Verify they're accessible via session
		expect(typeof session.sessionManager.getEntries).toBe("function");
		expect(typeof session.modelRegistry.getApiKeyAndHeaders).toBe("function");

		const entries = session.sessionManager.getEntries();
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);
	});

	it("should use extension compaction even with different values", async () => {
		const customSummary = "Custom summary with modified values";

		const harness = await createSession(
			[
				capturingExtension((event) => ({
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: 999,
					},
				})),
			],
			1,
		);
		const { session } = harness;

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);
		expect(result.tokensBefore).toBe(999);
	});
});
