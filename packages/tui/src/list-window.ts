/**
 * Scrolling/selection maths shared by every list surface.
 *
 * These rules were previously copy-pasted into a dozen components, which
 * is how they drifted; keep new list surfaces on these helpers.
 */

import { getKeybindings } from "./keybindings.js";

export interface ListWindow {
	start: number;
	end: number;
}

/** Visible slice that keeps the selection centred, clamped to both ends. */
export function listWindow(selectedIndex: number, total: number, maxVisible: number): ListWindow {
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
	return { start, end: Math.min(start + maxVisible, total) };
}

/** Move the selection by `delta`; single steps wrap, paging clamps. */
export function moveSelection(selectedIndex: number, total: number, delta: number, wrap = false): number {
	if (total <= 0) return 0;
	const next = selectedIndex + delta;
	if (!wrap) return Math.max(0, Math.min(next, total - 1));
	return ((next % total) + total) % total;
}

/** `  (3/12)` position readout shown under a list that does not fit. */
export function scrollPositionText(selectedIndex: number, total: number): string {
	return `  (${selectedIndex + 1}/${total})`;
}

export interface ListNavKeyHandlers {
	total: number;
	onConfirm: (index: number) => void;
	onCancel: () => void;
	/** Fires after single-step/page moves that change selection. */
	onMove?: () => void;
}

/**
 * Single selection controller for every list surface. Owns cursor index,
 * viewport size, windowing, and the shared tui.select.* keymap so list
 * components stop reimplementing navigation (and drifting).
 */
export class ListNav {
	private selectedIndex: number;
	private maxVisible: number;

	constructor(maxVisible: number, selectedIndex = 0) {
		this.maxVisible = Math.max(1, maxVisible);
		this.selectedIndex = Math.max(0, selectedIndex);
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	setSelectedIndex(index: number, total: number): void {
		this.selectedIndex = total <= 0 ? 0 : Math.max(0, Math.min(index, total - 1));
	}

	setMaxVisible(maxVisible: number): void {
		this.maxVisible = Math.max(1, maxVisible);
	}

	getMaxVisible(): number {
		return this.maxVisible;
	}

	/** Clamp cursor into range; call after backing items change. */
	clamp(total: number): void {
		this.setSelectedIndex(this.selectedIndex, total);
	}

	/** Move cursor by delta; single steps wrap, paging clamps. True when moved. */
	moveBy(delta: number, total: number, wrap = false): boolean {
		const next = moveSelection(this.selectedIndex, total, delta, wrap);
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		return true;
	}

	/** Visible slice keeping selection centred, clamped to both ends. */
	window(total: number): ListWindow {
		return listWindow(this.selectedIndex, total, this.maxVisible);
	}

	/** `  (3/12)` position readout. */
	position(total: number): string {
		return scrollPositionText(this.selectedIndex, total);
	}

	/**
	 * Consume shared navigation keys (up/down/pageUp/pageDown/confirm/cancel).
	 * Single steps wrap; pages clamp. True when key handled.
	 */
	handleNavKey(data: string, handlers: ListNavKeyHandlers): boolean {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.moveBy(-1, handlers.total, true)) handlers.onMove?.();
			return true;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.moveBy(1, handlers.total, true)) handlers.onMove?.();
			return true;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			if (this.moveBy(-this.maxVisible, handlers.total)) handlers.onMove?.();
			return true;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			if (this.moveBy(this.maxVisible, handlers.total)) handlers.onMove?.();
			return true;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			handlers.onConfirm(this.selectedIndex);
			return true;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			handlers.onCancel();
			return true;
		}
		return false;
	}
}
