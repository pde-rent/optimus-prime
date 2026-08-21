import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "../src/core/exec.js";

const SIGKILL_EXIT_CODE = 128 + constants.signals.SIGKILL;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("Child did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe.skipIf(process.platform === "win32")("execCommand", () => {
	// Real timers: waits out the actual 5s SIGKILL fallback window.
	it("force kills a process that ignores SIGTERM and cleans up the fallback timer", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "optimus-exec-test-"));
		const readyFile = join(testDir, "ready");
		const controller = new AbortController();
		try {
			const resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], ""); setInterval(() => {}, 1000);`,
					readyFile,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			await waitForFile(readyFile);

			controller.abort();

			// Resolves only once the fallback timer escalates to SIGKILL.
			const result = await resultPromise;

			expect(result.killed).toBe(true);
			expect(result.code).toBe(SIGKILL_EXIT_CODE);
			rmSync(testDir, { recursive: true, force: true });
		} catch (error) {
			controller.abort();
			rmSync(testDir, { recursive: true, force: true });
			throw error;
		}
	}, 15_000);
});
