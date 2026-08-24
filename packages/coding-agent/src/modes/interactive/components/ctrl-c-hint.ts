/**
 * Press-twice-to-confirm state: owns an expiry timestamp, an optional payload,
 * and the unref'd hide timer. Callers render the hint when `isVisible()` and
 * pass an `onChange` hook for any extra invalidation their surfaces need.
 */
export type RenderTarget = { requestRender(): void };

export class ExpiringFlag<T> {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private expiresAt = 0;
	private value: T | undefined;

	constructor(
		private readonly ui: RenderTarget | undefined,
		private readonly durationMs: number,
		private readonly onChange?: () => void,
	) {}

	show(value: T): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.value = value;
		this.expiresAt = Date.now() + this.durationMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.isVisible()) {
				this.expiresAt = 0;
				this.value = undefined;
				this.onChange?.();
				this.ui?.requestRender();
			}
		}, this.durationMs);
		this.timer.unref?.();
		this.onChange?.();
		this.ui?.requestRender();
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
		this.value = undefined;
		if (options.render !== false) {
			this.onChange?.();
			this.ui?.requestRender();
		}
	}

	isVisible(): boolean {
		return this.expiresAt > Date.now();
	}

	take(): T | undefined {
		const active = this.isVisible();
		const value = this.value;
		this.clear({ render: false });
		return active ? value : undefined;
	}
}

/** Ctrl-C press-twice-to-exit hint; no payload beyond visibility itself. */
export class CtrlCExitHintController extends ExpiringFlag<"ctrl-c"> {
	show(): void {
		super.show("ctrl-c");
	}
}
