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

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private currentFrame = 0;
	private unsubscribeTick: (() => void) | null = null;
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
		// One shared TUI ticker drives every animated component (~125ms per tick).
		this.unsubscribeTick = this.ui.onAnimationTick(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		});
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
