import { describe, expect, it } from "bun:test";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

const queue = { steering: ["s1", "s2"], followUp: ["f1", "f2"] };

describe("QueueSelection", () => {
	it("checks out the newest queued item and stashes the draft", () => {
		const selection = new QueueSelection();
		expect(selection.isBrowsing).toBe(false);
		const checkout = selection.checkoutNewest(queue, "draft");
		expect(checkout).toEqual({ lane: "followUp", originalIndex: 1, originalText: "f2" });
		expect(selection.checkedOut).toBe(checkout);
		expect(selection.isBrowsing).toBe(true);
		expect(selection.hasDraft).toBe(true);
		expect(selection.reset()).toBe("draft");
		expect(selection.isBrowsing).toBe(false);
		expect(selection.reset()).toBe("");
	});

	it("falls back to the steering lane tail and records the original index", () => {
		const selection = new QueueSelection();
		expect(selection.checkoutNewest({ steering: ["s1"], followUp: [] }, "")).toEqual({
			lane: "steering",
			originalIndex: 0,
			originalText: "s1",
		});
	});

	it("does not check out when the queue is empty", () => {
		const selection = new QueueSelection();
		expect(selection.checkoutNewest({ steering: [], followUp: [] }, "draft")).toBeUndefined();
		expect(selection.isBrowsing).toBe(false);
		expect(selection.hasDraft).toBe(false);
	});

	it("holds a single checkout until it is resolved", () => {
		const selection = new QueueSelection();
		selection.checkoutNewest(queue, "draft");
		expect(selection.checkoutNewest(queue, "other draft")).toBeUndefined();
		expect(selection.checkedOut?.originalText).toBe("f2");
		expect(selection.reset()).toBe("draft");
	});

	it("clearCheckout detaches without returning text but keeps the stashed draft", () => {
		const selection = new QueueSelection();
		selection.checkoutNewest(queue, "draft");
		selection.clearCheckout();
		expect(selection.checkedOut).toBeUndefined();
		expect(selection.isBrowsing).toBe(false);
		expect(selection.reset()).toBe("draft");
	});

	it("replaceDraft updates the stashed draft once", () => {
		const selection = new QueueSelection();
		selection.checkoutNewest(queue, "draft");
		selection.replaceDraft("newer draft");
		expect(selection.reset()).toBe("newer draft");
	});
});
