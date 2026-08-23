/**
 * Run an async file operation under an abort signal with the shared
 * "reject once, listener always detached" semantics used by the file tools.
 *
 * - Rejects immediately when the signal is already aborted.
 * - While `work` runs, the first abort rejects the outer promise; `aborted`
 *   flips so the body can stop early via `guard.aborted`.
 * - Errors thrown by `work` detach the listener and reject unless aborted won
 *   the race. Returning normally detaches the listener and resolves.
 */
const ABORTED = new Error("Operation aborted");

export interface AbortGuard {
	readonly aborted: boolean;
	/** Detach the abort listener (idempotent). */
	cleanup(): void;
	/** Throws if the operation was aborted; call between steps to stop early. */
	bail(): void;
}

export function runWithAbortSignal<T>(
	signal: AbortSignal | undefined,
	work: (guard: AbortGuard) => Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		let aborted = false;

		const onAbort = () => {
			aborted = true;
			reject(new Error("Operation aborted"));
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const guard: AbortGuard = {
			get aborted() {
				return aborted;
			},
			cleanup() {
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
			},
			bail() {
				if (aborted) throw ABORTED;
			},
		};

		void (async () => {
			try {
				const result = await work(guard);
				guard.cleanup();
				resolve(result);
			} catch (error: unknown) {
				guard.cleanup();
				if (!aborted && error !== ABORTED) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		})();
	});
}

/** Guard clause for native tools: throws the canonical abort error. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
