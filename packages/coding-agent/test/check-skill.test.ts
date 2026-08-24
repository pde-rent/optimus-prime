import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import createSkill from "../skills/check/skill.js";

/** A project root with a marker file and a fake checker binary on its bin path. */
function makeProject(marker: string, binName: string, script: string) {
	const root = mkdtempSync(join(tmpdir(), "check-skill-"));
	writeFileSync(join(root, marker), marker.endsWith(".json") ? "{}" : "");
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	const bin = join(root, "node_modules", ".bin", binName);
	writeFileSync(bin, `#!/bin/sh\n${script}\n`);
	chmodSync(bin, 0o755);
	return root;
}

describe("check.detect", () => {
	it("finds the project from a subdirectory, not just the working directory", async () => {
		// A monorepo package inherits its config from the repository root; a
		// working-directory-only check would report no project at all.
		const root = makeProject("tsconfig.json", "tsc", "exit 0");
		const nested = join(root, "packages", "thing");
		mkdirSync(nested, { recursive: true });

		const check = createSkill({ cwd: nested });
		const detected = await check.detect();
		expect(detected).toHaveLength(1);
		expect(detected[0].name).toBe("typescript");
		expect(detected[0].root).toBe(root);
	});

	it("reports nothing for a directory with no recognised project", async () => {
		const empty = mkdtempSync(join(tmpdir(), "check-empty-"));
		const check = createSkill({ cwd: empty });
		expect(await check.detect()).toEqual([]);
		const result = await check();
		expect(result.ok).toBe(true);
		expect(result.note).toContain("no recognised project markers");
	});
});

describe("check", () => {
	it("passes when the project's checker exits zero", async () => {
		const root = makeProject("Cargo.toml", "cargo", "exit 0");
		const check = createSkill({ cwd: root });
		const result = await check();
		expect(result.ok).toBe(true);
		expect(result.results[0].checker).toBe("rust");
		expect(result.results[0].exitCode).toBe(0);
	});

	it("fails and reports the checker's own output", async () => {
		const root = makeProject("Cargo.toml", "cargo", 'echo "src/x.rs:3:1 error: mismatched types" >&2; exit 1');
		const check = createSkill({ cwd: root });
		const result = await check();
		expect(result.ok).toBe(false);
		expect(result.results[0].output).toContain("mismatched types");
	});

	it("reports every diagnostic, including ones it has already shown", async () => {
		// Deliberately no ledger: several agents can share a working tree, so hiding a
		// previously-reported error would show a clean result on a broken project.
		const root = makeProject("Cargo.toml", "cargo", 'echo "pre-existing error" >&2; exit 1');
		const check = createSkill({ cwd: root });
		const first = await check();
		const second = await check();
		expect(second.ok).toBe(false);
		expect(second.results[0].output).toBe(first.results[0].output);
	});

	it("does not fail the project when a toolchain is not installed", async () => {
		// A polyglot repo must not go red because one toolchain is absent. Asserted as
		// an invariant rather than by assuming the host lacks a compiler: either the
		// checker ran, or it reported itself skipped, and neither is a failure.
		const root = mkdtempSync(join(tmpdir(), "check-nobin-"));
		writeFileSync(join(root, "go.mod"), "module x\n");
		const check = createSkill({ cwd: root });
		const [result] = (await check("go")).results;
		if (result.skipped) {
			expect(result.skipped).toContain("no go");
			expect((await check("go")).ok).toBe(true);
		} else {
			expect(result.command).toContain("go");
		}
	});

	it("selects a single checker by name", async () => {
		const root = makeProject("Cargo.toml", "cargo", "exit 0");
		writeFileSync(join(root, "go.mod"), "module x\n");
		const check = createSkill({ cwd: root });
		expect((await check("rust")).results).toHaveLength(1);
		expect((await check()).results).toHaveLength(2);
	});

	it("shares one process between concurrent identical checks", async () => {
		// Two cells asking the same question must not run `cargo check` twice and
		// contend on its target lock.
		const root = makeProject("Cargo.toml", "cargo", 'echo run >> "$0.runs"; exit 0');
		const check = createSkill({ cwd: root });
		const [a, b] = await Promise.all([check(), check()]);
		expect(a.results[0]).toBe(b.results[0]);
	});

	it("bounds a long report and says how much it dropped", async () => {
		const root = makeProject("Cargo.toml", "cargo", 'for i in $(seq 1 400); do echo "line $i"; done; exit 1');
		const check = createSkill({ cwd: root });
		const result = await check();
		expect(result.results[0].droppedLines).toBeGreaterThan(0);
		expect(result.results[0].output).toContain("lines omitted");
		// Head and tail both survive: the last diagnostics matter as much as the first.
		expect(result.results[0].output).toContain("line 1");
		expect(result.results[0].output).toContain("line 400");
	});
});
