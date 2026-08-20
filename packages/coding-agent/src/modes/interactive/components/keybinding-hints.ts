/**
 * Themed keybinding hints. Key formatting itself lives in the TUI package so
 * components there can label hints without reaching for the theme.
 */

import { DOT_SEPARATOR, dotJoin, formatKeyText, type Keybinding, keyText } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export type { KeyTextOptions } from "@earendil-works/pi-tui";
export { formatKeyText, keyText } from "@earendil-works/pi-tui";

export function keyHint(keybinding: Keybinding, description: string, options?: { primaryOnly?: boolean }): string {
	return theme.fg("dim", keyText(keybinding, options)) + theme.fg("muted", ` ${description}`);
}

/** Canonical bracketed expand/collapse hint, e.g. `(Ctrl+O to expand)`, fully dim. */
export function expandCollapseHint(keybinding: Keybinding, expanded: boolean): string {
	return theme.fg("dim", `(${keyText(keybinding)} ${expanded ? "to collapse" : "to expand"})`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

/**
 * The navigate/select/cancel footer every selection surface shows. Extra hints
 * are appended so surface-specific keys stay in the same visual run.
 */
export function selectionHints(extra: ReadonlyArray<string | undefined> = []): string {
	return dotJoin(
		[
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", "select"),
			...extra,
			keyHint("tui.select.cancel", "cancel", { primaryOnly: true }),
		],
		theme.fg("dim", DOT_SEPARATOR),
	);
}
