/**
 * Harness reloader — in-session hot-reload for the fork's custom harness
 * modules (coordinator / recursion additions distinct from stock optimus).
 *
 * Each harness module is re-imported from source with a cache-busted dynamic
 * import so every call re-reads the module from disk. A developer's edit is
 * therefore picked up on the next harness reload without exiting and
 * relaunching the agent.
 *
 * Bun's native ESM registry caches modules by URL for the life of the process,
 * so a plain dynamic import would return the code loaded at process start and
 * the reload would silently be a no-op. Appending a per-call reload query
 * forces a fresh URL and a fresh read from disk.
 *
 * Dead modules (present but not yet imported by the running app) are still
 * re-imported so an edit that is about to be wired up is validated for
 * syntax/type/dependency errors — but they are reported as NOT wired and are
 * never activated here (wiring dead modules is out of scope for the reload
 * mechanism).
 *
 * Safety boundary: call reload only OUTSIDE an active turn. The caller (the
 * `/reload:harness` command) refuses while the agent is streaming or
 * compacting, exactly like `/reload`. Reload never mutates in-progress state —
 * it only refreshes the module cache. New turns/actions that (re)load these
 * modules use the fresh code; already-instantiated singletons that captured a
 * static import at process start (e.g. the per-session cron/heartbeat
 * scheduler in daemon mode) keep their running instance until the next session
 * or process start.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface HarnessModuleSpec {
	/** Stable identifier shown to the user. */
	id: string;
	/** Source file path relative to this module's directory (src/core). */
	file: string;
	/** Whether the running app statically imports this module. */
	wired: boolean;
}

/**
 * The fork's harness module manifest. `wired: false` marks modules that are
 * dead/unwired in the running app (created but never imported); they are
 * re-imported for validation only and reported as not wired.
 */
export const HARNESS_MODULE_MANIFEST: ReadonlyArray<HarnessModuleSpec> = [
	{ id: "herdr-agent-state", file: "extensions/builtin/herdr-agent-state.ts", wired: true },
	{ id: "cron-jobs", file: "cron-jobs.ts", wired: true },
	{ id: "rlm-runtime", file: "rlm-runtime.ts", wired: true },
	{ id: "rlm-max-depth", file: "rlm-max-depth.ts", wired: true },
];

interface HarnessReloadResult {
	id: string;
	wired: boolean;
	/** Re-import succeeded (module parsed + loaded from source). */
	ok: boolean;
	error?: string;
}

interface HarnessReloadSummary {
	results: ReadonlyArray<HarnessReloadResult>;
	/** Number of modules that failed to re-import. */
	failed: number;
	/** Number of wired modules that re-imported OK. */
	wiredLoaded: number;
	/** Number of dead (unwired) modules in the manifest. */
	dead: number;
}

function resolveHarnessSourcePath(baseDir: string, spec: HarnessModuleSpec): string {
	const tsPath = join(baseDir, spec.file);
	if (existsSync(tsPath)) {
		return tsPath;
	}
	// dist/ build has .js siblings of the same modules; fall back so the reload
	// still validates without a running-from-source (dev) checkout.
	return tsPath.endsWith(".ts") ? `${tsPath.slice(0, -3)}.js` : tsPath;
}

let reloadNonce = 0;

/**
 * Import a module from an absolute path, forcing a fresh read from disk.
 * Bun caches modules by URL, so a plain import would return the first instance
 * loaded for the process lifetime. The per-call query forces a distinct URL
 * and therefore a fresh evaluation, which is the whole hot-reload property.
 */
export async function importModuleFresh(modulePath: string): Promise<unknown> {
	// A file:// URL with a query still hits Bun's per-path cache; a raw absolute
	// path with a query does not. Keep the raw path so each call re-reads disk.
	const separator = modulePath.includes("?") ? "&" : "?";
	return import(`${modulePath}${separator}reload=${++reloadNonce}`);
}

/**
 * Re-import every harness module from source with the module cache evicted.
 * Never throws: per-module failures are collected and reported so a broken
 * edit does not abort the reload or corrupt the session.
 */
export async function reloadHarnessModules(): Promise<HarnessReloadSummary> {
	const baseDir = dirname(fileURLToPath(import.meta.url));

	const results: HarnessReloadResult[] = [];
	for (const spec of HARNESS_MODULE_MANIFEST) {
		const resolvedPath = resolveHarnessSourcePath(baseDir, spec);
		try {
			await importModuleFresh(resolvedPath);
			results.push({ id: spec.id, wired: spec.wired, ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({ id: spec.id, wired: spec.wired, ok: false, error: message });
		}
	}

	return {
		results,
		failed: results.filter((result) => !result.ok).length,
		wiredLoaded: results.filter((result) => result.wired && result.ok).length,
		dead: results.filter((result) => !result.wired).length,
	};
}
