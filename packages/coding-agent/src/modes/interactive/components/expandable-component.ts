import { Container } from "@earendil-works/pi-tui";

/**
 * Shared expand/collapse state for output blocks that answer both the global
 * expand-all toggle and their own per-block toggle.
 *
 * The two must not fight: once a block has been toggled on its own, re-applying
 * the global value it already saw has to leave it alone, so the global setter
 * is a no-op unless the global value itself changed.
 */
export abstract class ExpandableComponent extends Container {
	protected expanded = false;
	private lastGlobalExpanded?: boolean;

	protected abstract updateDisplay(): void;

	/** Current absolute expansion, so UI state can persist across transcript rebuilds. */
	get isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.lastGlobalExpanded === expanded) {
			return;
		}
		this.lastGlobalExpanded = expanded;
		this.expanded = expanded;
		this.updateDisplay();
	}

	toggleExpandedSelf(): void {
		this.expanded = !this.expanded;
		this.updateDisplay();
	}
}
