import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import {
	type ActiveOrphanProcess,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
} from "../src/core/orphan-process-journal.js";

// Shell children are journaled for supervisor recovery; the REPL kernel must be too.
describe("Bun REPL orphan journal registration", () => {
	it("journals the kernel child pid as active and clears it on exit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "optimus-repl-journal-"));
		const journal = join(dir, "orphans.jsonl");
		const previous = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
		const manager = new BunReplManager({ bunPath: "bun", cwd: dir });
		try {
			await manager.start();
			const pid = (manager as unknown as { _child?: { pid?: number } })._child?.pid;
			expect(typeof pid).toBe("number");
			expect(pid!).toBeGreaterThan(0);

			const active = readActiveOrphanProcesses(journal, process.pid);
			const record = active.find((orphan: ActiveOrphanProcess) => orphan.pid === pid);
			expect(record).toBeDefined();
			expect(isOrphanProcessIdentityCurrent(record!)).toBe(true);

			await manager.kill();
			for (let i = 0; i < 100; i++) {
				if (!readActiveOrphanProcesses(journal, process.pid).some((orphan) => orphan.pid === pid)) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			// The latest record for the pid must be inactive so recovery never reaps a reused pid.
			expect(readActiveOrphanProcesses(journal, process.pid).some((orphan) => orphan.pid === pid)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previous;
			await manager.dispose().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
