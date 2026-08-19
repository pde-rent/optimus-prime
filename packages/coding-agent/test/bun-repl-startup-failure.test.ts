import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunReplManager } from "../src/core/bun-repl/index.js";
import { BunReplProvisioner } from "../src/core/bun-repl/provisioner.js";

// A kernel that cannot start used to wedge the session: `start()` awaited a promise that
// nothing settled when the child died, so every cell sat at "waiting for output" forever.
describe("Bun REPL startup failure", () => {
	it("rejects start() when the child cannot be spawned", async () => {
		const manager = new BunReplManager({ bunPath: join(dirname(fileURLToPath(import.meta.url)), "no-such-bun") });
		await expect(manager.start()).rejects.toThrow(/failed to start/);
	});

	it("surfaces the failure to the caller of execute() instead of hanging", async () => {
		const provisioner = new BunReplProvisioner({ bunPath: "/nonexistent/bun" });
		await expect(provisioner.ensure()).rejects.toThrow(/failed to start/);
	});

	it("ships the REPL script alongside the bundled CLI it is spawned next to", () => {
		// The manager resolves the script from its own directory. In the bundle that directory
		// is dist/bundle/, which esbuild fills from cli.js's import graph only — and nothing
		// imports the REPL child.
		const bundleDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "bundle");
		if (!existsSync(join(bundleDir, "cli.js"))) return; // not built; `bun run build` covers it
		expect(existsSync(join(bundleDir, "repl-script.js"))).toBe(true);
	});
});
