import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_MODULE_MANIFEST, importModuleFresh, reloadHarnessModules } from "../src/core/harness-reloader.js";

const coreDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core");
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("harness reloader", () => {
	it("every manifest entry points at a source file that exists", () => {
		const missing = HARNESS_MODULE_MANIFEST.filter((spec) => !existsSync(join(coreDir, spec.file)));
		expect(missing.map((spec) => spec.file)).toEqual([]);
	});

	it("re-imports every harness module without failures", async () => {
		const summary = await reloadHarnessModules();

		expect(summary.results.map((result) => result.id)).toEqual(HARNESS_MODULE_MANIFEST.map((spec) => spec.id));
		expect(summary.results.filter((result) => !result.ok)).toEqual([]);
		expect(summary.failed).toBe(0);
		expect(summary.wiredLoaded).toBe(HARNESS_MODULE_MANIFEST.filter((spec) => spec.wired).length);
		expect(summary.dead).toBe(HARNESS_MODULE_MANIFEST.filter((spec) => !spec.wired).length);
	});

	it("is repeatable: a second reload succeeds identically", async () => {
		const first = await reloadHarnessModules();
		const second = await reloadHarnessModules();

		expect(second.results).toEqual(first.results);
	});

	// The whole point of `/reload:harness` is that an edit on disk is picked up
	// without restarting the process. That property comes from the cache-busted
	// dynamic import, so assert it on the loader directly.
	it("hot-reload actually swaps a changed module", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-harness-reload-"));
		tempDirs.push(dir);
		const modulePath = join(dir, "hot.ts");
		writeFileSync(modulePath, "export const value = 'before';\n");

		const before = (await importModuleFresh(modulePath)) as { value: string };
		expect(before.value).toBe("before");

		writeFileSync(modulePath, "export const value = 'after';\n");

		const after = (await importModuleFresh(modulePath)) as { value: string };
		expect(after.value).toBe("after");
	});
});
