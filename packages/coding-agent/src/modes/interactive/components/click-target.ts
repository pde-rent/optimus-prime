/**
 * In-transcript click targets.
 *
 * Components have no layout bounds — `render(width)` returns opaque lines — so
 * hit-testing a rectangle is not available to us. OSC 8 hyperlinks already
 * carry a per-column identity through the renderer and the fullscreen viewport
 * already resolves the link under a click, so a private URL scheme rides that
 * path instead of duplicating it: wrap the clickable text, and the TUI's
 * `onActivateLink` hook hands back the id on click.
 *
 * Clicks only reach the app in fullscreen mode, where mouse tracking is on.
 * The keybindings stay the interaction of record; clicking is an accelerator.
 */

import { hyperlink } from "@earendil-works/pi-tui";

const TOGGLE_SCHEME = "pi-toggle://";
const OPEN_AGENT_SCHEME = "pi-agent-open://";

/**
 * Only fullscreen mouse mode routes clicks through the TUI. Everywhere else the
 * terminal itself would try to open the link, so the OSC 8 wrapper is dropped
 * and the chevron stays a plain glyph.
 */
let clickTargetsEnabled = false;

export function setClickTargetsEnabled(enabled: boolean): void {
	clickTargetsEnabled = enabled;
}

export const CHEVRON_COLLAPSED = "▸";
export const CHEVRON_EXPANDED = "▾";

/** Collapse chevron for a header, clickable when the block declares an id. */
export function collapseChevron(expanded: boolean, targetId?: string): string {
	const glyph = expanded ? CHEVRON_EXPANDED : CHEVRON_COLLAPSED;
	return targetId === undefined ? glyph : clickToToggle(glyph, targetId);
}

/** Fixed target for the thinking chevron: thinking visibility is a global setting. */
export const THINKING_TOGGLE_TARGET = "thinking";

/** Wrap arbitrary header text so clicking anywhere on it toggles the block. */
export function clickToToggle(text: string, targetId: string): string {
	if (!clickTargetsEnabled) return text;
	return hyperlink(text, TOGGLE_SCHEME + encodeURIComponent(targetId));
}

/** Toggle-target id carried by a clicked URL, or null when the URL is not ours. */
export function parseToggleTarget(url: string): string | null {
	if (!url.startsWith(TOGGLE_SCHEME)) return null;
	try {
		return decodeURIComponent(url.slice(TOGGLE_SCHEME.length));
	} catch {
		return null;
	}
}

/** Wrap a row so clicking anywhere on it opens the agent session behind targetId. */
export function clickToOpenAgent(text: string, targetId: string): string {
	if (!clickTargetsEnabled || targetId.length === 0) return text;
	return hyperlink(text, OPEN_AGENT_SCHEME + encodeURIComponent(targetId));
}

/** Agent-open target id carried by a clicked URL, or null when the URL is not ours. */
export function parseOpenAgentTarget(url: string): string | null {
	if (!url.startsWith(OPEN_AGENT_SCHEME)) return null;
	try {
		return decodeURIComponent(url.slice(OPEN_AGENT_SCHEME.length));
	} catch {
		return null;
	}
}

/** A transcript block that can be collapsed on its own, independent of the global toggles. */
export interface Collapsible {
	/** Stable id embedded in this block's click targets. */
	readonly toggleTargetId: string;
	/** Flip this block's own expansion, overriding the global state until the next global toggle. */
	toggleExpandedSelf(): void;
}

export function isCollapsible(value: unknown): value is Collapsible {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Collapsible).toggleTargetId === "string" &&
		typeof (value as Collapsible).toggleExpandedSelf === "function"
	);
}
