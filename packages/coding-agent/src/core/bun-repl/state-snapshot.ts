import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SnapshotManifest {
	version: number;
	createdAt: string;
	names: string[];
}

const SNAPSHOT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const DATA_FILE = "data.json";

export async function saveSnapshot(dir: string, data: Record<string, unknown>): Promise<string[]> {
	await mkdir(dir, { recursive: true });
	const names = Object.keys(data);
	const manifest: SnapshotManifest = {
		version: SNAPSHOT_VERSION,
		createdAt: new Date().toISOString(),
		names,
	};
	await Promise.all([
		writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2)),
		writeFile(join(dir, DATA_FILE), JSON.stringify(data, null, 2)),
	]);
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
