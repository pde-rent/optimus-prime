/**
 * Unified async helpers: polling, delays, deferreds, microtask flushes.
 * Canonical implementations — per-suite private copies are being deleted in favor of these.
 */

/** Sleep for ms milliseconds. */
export function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Poll an assertion until it passes or the timeout elapses, then rethrow the last error. */
export function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const tick = (): Promise<void> => {
		try {
			assertion();
			return Promise.resolve();
		} catch (error) {
			if (Date.now() > deadline) {
				return Promise.reject(error);
			}
			return delay(5).then(tick);
		}
	};
	return tick();
}

/** Resolve once the predicate returns true, polling on the macrotask queue. */
export async function waitForCondition(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("waitForCondition: timed out");
		}
		await delay(stepMs);
	}
}

/** One deferred with exposed resolve/reject, for wiring event-driven code in tests. */
export function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

/** Let pending timers/microtasks of an event loop turn before asserting. */
export function flushAsyncWork(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
