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
 * Clicks only reach the app in fullscreen mode, where mouse reporting is on.
 * Hover highlighting costs nothing: terminals draw OSC 8 link hover natively,
 * so we deliberately add no extra mouse tracking (no mode 1003 motion reports)
 * beyond what fullscreen already uses.
 * The keybindings stay the interaction of record; clicking is an accelerator.
 */

import { type Component, hyperlink } from "@earendil-works/pi-tui";

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

const CHEVRON_COLLAPSED = "▸";
const CHEVRON_EXPANDED = "▾";

/** Collapse chevron for a header, clickable when the block declares an id. */
export function collapseChevron(expanded: boolean, targetId?: string): string {
	const glyph = expanded ? CHEVRON_EXPANDED : CHEVRON_COLLAPSED;
	return targetId === undefined ? glyph : clickToToggle(glyph, targetId);
}

/** Fixed target id for thinking rows: thinking visibility is a global setting. */
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

/**
 * Full-row block targets under pi-block://<kind>/<id>. Unlike the header-only
 * toggle targets these wrap a block's entire render output, so a click anywhere
 * on the row activates it.
 */

/** Kind of transcript block a full-row click target activates. */
export type BlockKind = "thinking" | "toolcall";

const BLOCK_SCHEME = "pi-block://";

/** URL for a full-row block target. */
export function blockTargetUrl(kind: BlockKind, targetId: string): string {
	return `${BLOCK_SCHEME}${kind}/${encodeURIComponent(targetId)}`;
}

/** Wrap one rendered row line so clicking anywhere on it activates the block. */
export function clickToOpenBlock(text: string, kind: BlockKind, targetId: string): string {
	if (!clickTargetsEnabled || targetId.length === 0) return text;
	return hyperlink(text, blockTargetUrl(kind, targetId));
}

/** Wrap every non-empty row line of a block's render output. */
export function clickBlockLines(lines: string[], kind: BlockKind, targetId: string): string[] {
	if (!clickTargetsEnabled || targetId.length === 0) return lines;
	return lines.map((line) => (line.length === 0 ? line : clickToOpenBlock(line, kind, targetId)));
}

/** Block target carried by a clicked URL, or null when the URL is not ours. */
export function parseBlockTarget(url: string): { kind: BlockKind; id: string } | null {
	if (!url.startsWith(BLOCK_SCHEME)) return null;
	const rest = url.slice(BLOCK_SCHEME.length);
	const slash = rest.indexOf("/");
	if (slash === -1) return null;
	const kind = rest.slice(0, slash);
	if (kind !== "thinking" && kind !== "toolcall") return null;
	try {
		return { kind, id: decodeURIComponent(rest.slice(slash + 1)) };
	} catch {
		return null;
	}
}

/**
 * Component wrapper that makes a block's whole render output clickable. Wrap any
 * row component to get full-row clickability without touching its rendering.
 */
export class ClickableBlock implements Component {
	constructor(
		private readonly child: Component,
		private readonly kind: BlockKind,
		private readonly targetId: string,
	) {}

	render(width: number): string[] {
		return clickBlockLines(this.child.render(width), this.kind, this.targetId);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

/** A transcript block that can be collapsed on its own, independent of the global toggles. */
export interface Collapsible {
	/** Stable id embedded in this block's click targets. */
	readonly toggleTargetId: string;
	/**
	 * Current absolute expansion, when the block can report it. Optional because
	 * not every collapsible tracks state that outlives a transcript rebuild; only
	 * blocks that expose it get their expansion restored after a rebuild.
	 */
	readonly isExpanded?: boolean;
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
