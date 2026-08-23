import type { AgentConnectionQueueState } from "../agent-connection/index.js";

export type QueueLane = "steering" | "followUp";

export interface QueueCheckout {
	lane: QueueLane;
	originalIndex: number;
	originalText: string;
}

/**
 * Tracks a checked-out queued message under checkout-edit-reinsert semantics:
 * selecting an item pops it from the queue, the user edits its text in the
 * editor, and Enter resends it as a fresh message while Escape (or navigating
 * back down to the draft) returns the original text to the queue. While held,
 * the checked-out text is out of the queue, so no window exists where the
 * running agent can consume a message being edited.
 */
export class QueueSelection {
	private checkout: QueueCheckout | undefined;
	private draft = "";
	private hasStashedDraft = false;

	get checkedOut(): QueueCheckout | undefined {
		return this.checkout;
	}

	get isBrowsing(): boolean {
		return this.checkout !== undefined;
	}

	get hasDraft(): boolean {
		return this.hasStashedDraft;
	}

	replaceDraft(draft: string): void {
		this.draft = draft;
		this.hasStashedDraft = true;
	}

	/**
	 * Check out the newest queued item (last followUp, else last steering) and
	 * stash the editor draft. Returns the checkout, or undefined when the queue
	 * is empty or an item is already checked out.
	 */
	checkoutNewest(queue: AgentConnectionQueueState, draft: string): QueueCheckout | undefined {
		if (this.checkout) return undefined;
		const followUpIndex = queue.followUp.length - 1;
		const steeringIndex = queue.steering.length - 1;
		const item =
			followUpIndex >= 0
				? { lane: "followUp" as const, originalIndex: followUpIndex, originalText: queue.followUp[followUpIndex] }
				: steeringIndex >= 0
					? {
							lane: "steering" as const,
							originalIndex: steeringIndex,
							originalText: queue.steering[steeringIndex],
						}
					: undefined;
		if (!item) return undefined;
		this.draft = draft;
		this.hasStashedDraft = true;
		this.checkout = item;
		return item;
	}

	/** Detach the checkout without returning the original text to the queue. */
	clearCheckout(): void {
		this.checkout = undefined;
	}

	/** Called after cancel or submit resolved the checkout. Returns the stashed draft. */
	reset(): string {
		this.checkout = undefined;
		const draft = this.draft;
		this.draft = "";
		this.hasStashedDraft = false;
		return draft;
	}
}
