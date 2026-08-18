import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SnapshotManifest {
	version: number;
	createdAt: string;
	names: string[];
}

const SNAPSHOT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const DATA_FILE = "data.json";

/**
 * Write one snapshot file safely.
 *
 * The snapshot holds whatever the agent put in its REPL namespace, which routinely includes
 * credentials it read while working. So: owner-only mode, written to a fresh temp file and
 * renamed into place (a reader never sees a half-written file, and a pre-existing symlink at
 * the destination cannot redirect the write), with `wx` so an attacker-planted temp path fails
 * instead of being followed.
 */
async function writeSnapshotFile(dir: string, name: string, payload: string): Promise<void> {
	const finalPath = join(dir, name);
	const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, payload, { mode: 0o600, flag: "wx" });
	await chmod(tempPath, 0o600);
	await rename(tempPath, finalPath);
}

export async function saveSnapshot(dir: string, data: Record<string, unknown>): Promise<string[]> {
	// 0700: the directory listing alone leaks which variables the agent held.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const names = Object.keys(data);
	const manifest: SnapshotManifest = {
		version: SNAPSHOT_VERSION,
		createdAt: new Date().toISOString(),
		names,
	};
	// Data first: a manifest without its data reads as a corrupt snapshot and is discarded,
	// whereas data without a manifest is simply ignored. Fail in the recoverable direction.
	await writeSnapshotFile(dir, DATA_FILE, JSON.stringify(data, null, 2));
	await writeSnapshotFile(dir, MANIFEST_FILE, JSON.stringify(manifest, null, 2));
	return names;
}

export async function loadSnapshot(dir: string): Promise<Record<string, unknown> | null> {
	try {
		const manifestRaw = await readFile(join(dir, MANIFEST_FILE), "utf-8");
		const manifest: SnapshotManifest = JSON.parse(manifestRaw);
		if (manifest.version !== SNAPSHOT_VERSION) return null;
		const dataRaw = await readFile(join(dir, DATA_FILE), "utf-8");
		return JSON.parse(dataRaw);
	} catch {
		return null;
	}
}

export async function snapshotExists(dir: string): Promise<boolean> {
	try {
		const manifestRaw = await readFile(join(dir, MANIFEST_FILE), "utf-8");
		const manifest: SnapshotManifest = JSON.parse(manifestRaw);
		return manifest.version === SNAPSHOT_VERSION;
	} catch {
		return false;
	}
}
