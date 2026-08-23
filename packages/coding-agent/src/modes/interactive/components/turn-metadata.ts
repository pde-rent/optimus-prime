import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "../../../utils/shared.js";
import { theme } from "../theme/theme.js";

/** Aggregate for one conversational turn (user prompt -> final assistant message). */
export interface TurnMetadata {
	/** Wall-clock time of the turn's last assistant message (epoch ms). */
	endedAtMs: number;
	/** Turn span: user message timestamp -> last assistant message timestamp. */
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

function compactTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

function formatCost(usd: number): string {
	return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/**
 * Turn-boundary rule: a barely-visible dotted line with right-aligned metadata
 * (`HH:MM:SS · ↑in ↓out tok · runtime · cost`). One line per turn, mirroring
 * how chat UIs separate threads; the dots keep the divider present but quiet.
 */
export class TurnMetadataComponent implements Component {
	constructor(private readonly meta: TurnMetadata) {}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(1, width - 1);
		const time = new Date(this.meta.endedAtMs).toLocaleTimeString("en-GB", { hour12: false });
		const parts = [
			time,
			`↑${compactTokenCount(this.meta.inputTokens)} ↓${compactTokenCount(this.meta.outputTokens)} tok`,
			formatDuration(Math.max(0, this.meta.durationMs)),
			this.meta.costUsd !== undefined && this.meta.costUsd > 0 ? formatCost(this.meta.costUsd) : undefined,
		].filter((p) => p !== undefined) as string[];
		const metaText = theme.fg("dim", parts.join(" · "));
		const pad = Math.max(0, w - visibleWidth(parts.join(" · ")) - 1);
		const line = `${"·".repeat(pad)} ${metaText}`;
		return [truncateToWidth(line, width)];
	}
}
