/**
 * Harness reloader — in-session hot-reload for the fork's custom harness
 * modules (coordinator / recursion additions distinct from stock optimus).
 *
 * Each harness module is re-imported from source through jiti with
 * `moduleCache: false`, the same dynamic loader the extension system uses for
 * `/reload` (see src/core/extensions/loader.ts `loadExtensionModule`). Because
 * the module cache is disabled, every call re-reads the module from disk, so a
 * developer's edit is picked up on the next harness reload WITHOUT exiting and
 * relaunching the agent.
 *
 * Dead modules (currently unwired in the running app, e.g. refinement
 * orchestrator, autonomous-continuation-manager) are still re-imported so an
 * edit that is about to be wired up is validated for syntax/type/dependency
 * errors — but they are reported as NOT wired and are never activated here
 * (wiring dead modules is out of scope for the reload mechanism).
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

export interface HarnessModuleSpec {
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
	{ id: "autonomous-continuation-manager", file: "autonomous-continuation-manager.ts", wired: false },
	{ id: "refinement-orchestrator", file: "refinement-orchestrator.ts", wired: false },
	{ id: "herdr-agent-state", file: "extensions/builtin/herdr-agent-state.ts", wired: true },
	{ id: "cron-jobs", file: "cron-jobs.ts", wired: true },
	{ id: "rlm-runtime", file: "rlm-runtime.ts", wired: true },
	{ id: "rlm-max-depth", file: "rlm-max-depth.ts", wired: true },
];

/**
 * jiti options that make the reload actually re-read from disk.
 *
 * `tryNative` defaults to ON under Bun, which routes the import to Bun's native
 * ESM registry — that registry caches by URL for the life of the process, so
 * `moduleCache: false` alone would hand back the code loaded at process start
 * and the reload would silently be a no-op. Forcing jiti's own loader restores
 * the hot-swap property. Exported so the test can assert it on this exact
 * config instead of a hand-rolled one.
 */
export const HARNESS_JITI_OPTIONS = { moduleCache: false, tryNative: false } as const;

export interface HarnessReloadResult {
	id: string;
	wired: boolean;
	/** Re-import succeeded (module parsed + loaded from source). */
	ok: boolean;
	error?: string;
}

export interface HarnessReloadSummary {
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

/**
 * Re-import every harness module from source with the module cache evicted.
 * Never throws: per-module failures are collected and reported so a broken
 * edit does not abort the reload or corrupt the session.
 */
export async function reloadHarnessModules(): Promise<HarnessReloadSummary> {
	const { createJiti } = await import("jiti/static");
	const baseDir = dirname(fileURLToPath(import.meta.url));
	const jiti = createJiti(import.meta.url, HARNESS_JITI_OPTIONS);

	const results: HarnessReloadResult[] = [];
	for (const spec of HARNESS_MODULE_MANIFEST) {
		const resolvedPath = resolveHarnessSourcePath(baseDir, spec);
		try {
			await jiti.import(resolvedPath);
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
