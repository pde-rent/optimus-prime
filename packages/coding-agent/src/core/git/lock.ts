import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Git-style exclusive lockfile protocol (spec §3.5): create "<path>.lock" with O_CREAT|O_EXCL,
 * write, fsync, rename onto the target. A fresh lock held by someone else refuses after a short
 * retry; a stale lock (older than LOCK_STALE_MS) is taken over, matching git's practice for
 * crashed writers. Readers never look at the lock file.
 */

export const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 100;

export class LockBusyError extends Error {
	constructor(readonly lockPath: string) {
		super(`could not acquire ${lockPath}: locked by another process`);
	}
}

function lockAgeMs(path: string): number {
	return Date.now() - statSync(path).mtimeMs;
}

/**
 * Run fn() while holding "<path>.lock"; its return value is passed through.
 * A competing fresh lock gets one short retry window before refusing.
 */
export function withLock<T>(targetPath: string, fn: () => T): T {
	const lockPath = `${targetPath}.lock`;
	if (!existsSync(dirname(lockPath))) mkdirSync(dirname(lockPath), { recursive: true });
	for (;;) {
		let fd: number;
		try {
			fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
		} catch {
			if (!existsSync(lockPath)) throw new Error(`cannot create lock ${lockPath}`);
			if (lockAgeMs(lockPath) > LOCK_STALE_MS) {
				unlinkSync(lockPath); // crashed writer; take over
				continue;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
			throw new LockBusyError(lockPath);
		}
		try {
			fsyncSync(fd);
			return fn();
		} finally {
			closeSync(fd);
			unlinkSync(lockPath);
		}
	}
}

/** Serialize bytes to targetPath under the git lock protocol (write temp, fsync, rename). */
export function writeFileLocked(targetPath: string, data: Uint8Array): void {
	withLock(targetPath, () => {
		const tmp = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, targetPath);
	});
}
