/**
 * Low-level ANSI line helpers shared by transcript and panel components.
 * Width-aware padding lives in @earendil-works/pi-tui (padEndAnsi/padStartAnsi);
 * only the helpers with no canonical home stay here.
 */

export const ANSI_RESET = "\x1b[0m";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Mark a component's rendered lines as one shell-prompt zone: A opens the
 * prompt, B closes the command output, C marks the final prompt line.
 */
export function wrapOsc133Zones(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	lines[0] = OSC133_ZONE_START + lines[0]!;
	lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1]!;
	return lines;
}

/**
 * Re-open `background` after every full ANSI reset so a painted line stays
 * painted: truncation and wrapping can inject resets that would otherwise
 * clear the background for the rest of the line.
 */
export function applyBackgroundAcrossResets(text: string, background: (text: string) => string): string {
	return text
		.split(ANSI_RESET)
		.map((segment) => background(segment))
		.join(ANSI_RESET);
}
