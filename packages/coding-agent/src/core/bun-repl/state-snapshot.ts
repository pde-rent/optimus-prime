import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SnapshotManifest {
	version: number;
	createdAt: string;
	names: string[];
	/**
	 * Names the namespace held that the snapshot could not carry (functions, classes,
	 * symbols, values JSON cannot represent). Optional so snapshots written before this
	 * field existed still load — an older snapshot simply reports nothing lost.
	 */
	droppedNames?: string[];
}

/** A snapshot as read back from disk: the revivable data plus the names that were never captured. */
export interface LoadedSnapshot {
	/** Structured-clone payload, base64; absent for legacy JSON snapshots. */
	dataB64?: string;
	/** Payload of a snapshot written before the structured-clone format. */
	data?: Record<string, unknown>;
	droppedNames: string[];
}

const SNAPSHOT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const DATA_FILE = "data.v8";
/** Snapshots written before the structured-clone format; still readable. */
const LEGACY_DATA_FILE = "data.json";

/**
 * Write one snapshot file safely.
 *
 * The snapshot holds whatever the agent put in its REPL namespace, which routinely includes
 * credentials it read while working. So: owner-only mode, written to a fresh temp file and
 * renamed into place (a reader never sees a half-written file, and a pre-existing symlink at
 * the destination cannot redirect the write), with `wx` so an attacker-planted temp path fails
 * instead of being followed.
 */
async function writeSnapshotFile(dir: string, name: string, payload: string | Uint8Array): Promise<void> {
	const finalPath = join(dir, name);
	const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, payload, { mode: 0o600, flag: "wx" });
	await chmod(tempPath, 0o600);
	await rename(tempPath, finalPath);
}

export async function saveSnapshot(
	dir: string,
	payload: { dataB64: string; names: string[] },
	droppedNames: string[] = [],
): Promise<string[]> {
	// 0700: the directory listing alone leaks which variables the agent held.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const names = payload.names;
	const manifest: SnapshotManifest = {
		version: SNAPSHOT_VERSION,
		createdAt: new Date().toISOString(),
		names,
		droppedNames,
	};
	// Data first: a manifest without its data reads as a corrupt snapshot and is discarded,
	// whereas data without a manifest is simply ignored. Fail in the recoverable direction.
	// The payload is the child's structured clone, written through verbatim: Map, Set, Date,
	// RegExp, BigInt, TypedArrays and circular references all survive, where JSON silently
	// flattened them to `{}`. The host never decodes it, so it cannot corrupt it either.
	await writeSnapshotFile(dir, DATA_FILE, Buffer.from(payload.dataB64, "base64"));
	await writeSnapshotFile(dir, MANIFEST_FILE, JSON.stringify(manifest, null, 2));
	return names;
}

export async function loadSnapshot(dir: string): Promise<LoadedSnapshot | null> {
	try {
		const manifestRaw = await readFile(join(dir, MANIFEST_FILE), "utf-8");
		const manifest: SnapshotManifest = JSON.parse(manifestRaw);
		if (manifest.version !== SNAPSHOT_VERSION) return null;
		const payload = await readSnapshotData(dir);
		if (!payload) return null;
		return {
			...payload,
			droppedNames: Array.isArray(manifest.droppedNames)
				? manifest.droppedNames.filter((n): n is string => typeof n === "string")
				: [],
		};
	} catch {
		return null;
	}
}

/** Read the payload, accepting both the structured-clone format and older JSON snapshots. */
async function readSnapshotData(dir: string): Promise<{ dataB64?: string; data?: Record<string, unknown> } | null> {
	try {
		const buffer = await readFile(join(dir, DATA_FILE));
		return { dataB64: buffer.toString("base64") };
	} catch {
		// Fall through to the legacy format.
	}
	try {
		const raw = await readFile(join(dir, LEGACY_DATA_FILE), "utf-8");
		return { data: JSON.parse(raw) as Record<string, unknown> };
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
