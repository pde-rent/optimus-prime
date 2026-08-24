import type { TUI } from "../tui.js";
import { Text } from "./text.js";

export interface LoaderIndicatorOptions {
	/** Animation frames. Custom frames are rendered verbatim. */
	frames?: string[];
	/** Deprecated: animation is driven by the TUI's shared ~125ms tick, not a per-loader interval. */
	intervalMs?: number;
}

/**
 * Braille spinner frames used by every animated indicator in the TUI.
 * Surfaces that render status glyphs directly (rather than hosting a Loader)
 * read these so motion stays consistent.
 */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_FRAMES = SPINNER_FRAMES;
const DEFAULT_FALLBACK_TICK_MS = 125;

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private currentFrame = 0;
	private unsubscribeTick: (() => void) | null = null;
	private ownInterval: ReturnType<typeof setInterval> | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		if (this.unsubscribeTick) {
			this.unsubscribeTick();
			this.unsubscribeTick = null;
		}
		if (this.ownInterval) {
			clearInterval(this.ownInterval);
			this.ownInterval = null;
		}
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.currentFrame = 0;
		this.start();
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1 || !this.ui) {
			return;
		}
		// Prefer the shared TUI ticker (~125ms per tick, one interval for every
		// animated component). Hosts that do not provide onAnimationTick - test
		// stubs and embedders - fall back to a private interval so construction
		// cannot throw and animation still runs.
		const tick = (this.ui as { onAnimationTick?: (cb: () => void) => () => void }).onAnimationTick?.bind(this.ui);
		const advanceFrame = () => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		};
		if (tick) {
			this.unsubscribeTick = tick(advanceFrame);
			return;
		}
		this.ownInterval = setInterval(advanceFrame, DEFAULT_FALLBACK_TICK_MS);
	}

	private updateDisplay(): void {
		const frame = this.frames[this.currentFrame] ?? "";
		const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
		const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
