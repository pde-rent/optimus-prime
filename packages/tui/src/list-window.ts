/**
 * Scrolling/selection maths shared by every list surface.
 *
 * These three rules were previously copy-pasted into a dozen components, which
 * is how they drifted; keep new list surfaces on these helpers.
 */

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
