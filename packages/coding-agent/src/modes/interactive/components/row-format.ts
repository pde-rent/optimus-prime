import { padEndAnsi, padStartAnsi, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface TwoSidedRowOptions {
	/** Space between the left and right cell; 0 when there is no right cell. */
	gap?: number;
	/** Width the right cell can never exceed. */
	maxRightWidth?: number;
	/** Width the left cell keeps before the right cell starts shrinking. */
	minLeftWidth?: number;
	/** Width the right cell keeps even when its content is shorter. */
	minRightWidth?: number;
	/** Ellipsis for truncated cells; "" disables it. */
	ellipsis?: string;
}

/**
 * One terminal row split into a left cell and a right-aligned detail cell.
 * The right cell shrinks first, then the left truncates; the result always
 * occupies exactly `width` columns so callers never wrap.
 */
export function formatTwoSidedRow(
	left: string,
	right: string,
	width: number,
	options: TwoSidedRowOptions = {},
): string {
	const gap = options.gap ?? 2;
	const ellipsis = options.ellipsis ?? "…";
	let rightWidth = 0;
	if (right.length > 0 && width > 0) {
		rightWidth = Math.min(
			visibleWidth(right),
			options.maxRightWidth ?? Number.POSITIVE_INFINITY,
			Math.max(0, width - (options.minLeftWidth ?? 0) - gap),
		);
		if (options.minRightWidth !== undefined) {
			rightWidth = Math.max(rightWidth, Math.min(options.minRightWidth, width));
		}
	}
	const leftGap = rightWidth > 0 ? gap : 0;
	const leftWidth = Math.max(0, width - rightWidth - leftGap);
	return (
		padEndAnsi(truncateToWidth(left, leftWidth, ellipsis), leftWidth + leftGap) +
		(rightWidth > 0 ? padStartAnsi(truncateToWidth(right, rightWidth, ellipsis), rightWidth) : "")
	);
}

/** A fixed-width cell: truncated to `width` columns, then padded up to it. */
export function formatCell(text: string, width: number, ellipsis = ""): string {
	return padEndAnsi(truncateToWidth(text, width, ellipsis), width);
}
