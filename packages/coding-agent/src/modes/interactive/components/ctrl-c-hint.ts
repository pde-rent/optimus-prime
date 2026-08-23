/**
 * Shared Ctrl-C press-twice-to-exit hint state: owns the expiry timestamp and
 * the unref'd hide timer. Callers render the hint when `isVisible()` and pass
 * an `onChange` hook for any extra invalidation their surfaces need.
 */
export class CtrlCExitHintController {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private expiresAt = 0;

	constructor(
		private readonly ui: { requestRender(): void },
		private readonly durationMs: number,
		private readonly onChange?: () => void,
	) {}

	show(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.expiresAt = Date.now() + this.durationMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.isVisible()) {
				this.expiresAt = 0;
				this.onChange?.();
				this.ui.requestRender();
			}
		}, this.durationMs);
		this.timer.unref?.();
		this.onChange?.();
		this.ui.requestRender();
	}

	clear(options: { render?: boolean } = {}): void {
		if (!this.timer && this.expiresAt === 0) {
			return;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.expiresAt = 0;
		if (options.render !== false) {
			this.onChange?.();
			this.ui.requestRender();
		}
	}

	isVisible(): boolean {
		return this.expiresAt > Date.now();
	}
}
