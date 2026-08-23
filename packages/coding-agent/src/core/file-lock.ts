import lockfile from "proper-lockfile";

/**
 * Acquire a proper-lockfile synchronous lock with bounded busy-retry.
 * Shared by the JSON-backed stores (auth.json, settings.json).
 */
export function acquireLockSyncWithRetry(path: string, label: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing callers to async.
			}
		}
	}

	throw (lastError as Error) ?? new Error(`Failed to acquire ${label} lock`);
}
