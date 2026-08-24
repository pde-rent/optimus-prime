import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

export function getMutationQueueKey(filePath: string): string {
	const resolvedPath = resolve(filePath);
	try {
		return realpathSync.native(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

type FileMutationListener = (filePath: string) => void;

const mutationListeners = new Set<FileMutationListener>();

/**
 * Subscribe to completed file mutations. Returns an unsubscribe function.
 * Listeners receive the resolved mutation-queue key of the mutated file.
 */
export function onFileMutation(listener: FileMutationListener): () => void {
	mutationListeners.add(listener);
	return () => {
		mutationListeners.delete(listener);
	};
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
		for (const listener of mutationListeners) {
			listener(key);
		}
	}
}
