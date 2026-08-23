import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseSkillBlock } from "../src/core/skill-blocks.js";
import { createAllToolDefinitions } from "../src/core/tools/index.js";
import { createSkillTool } from "../src/core/tools/skill.js";
import { getTextOutput } from "./helpers/render.js";

function makeSkillDir(root: string, name: string, body = `Use ${name} for things.\n`): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}`);
	return dir;
}

describe("skill tool", () => {
	let root: string;

	const setup = (): void => {
		root = mkdtempSync(join(tmpdir(), "skill-tool-"));
		makeSkillDir(root, "alpha");
		makeSkillDir(root, "beta", "Beta contract body.");
	};

	const teardown = (): void => {
		rmSync(root, { recursive: true, force: true });
	};

	const makeTool = () => {
		const dirs = new Map([
			["alpha", join(root, "alpha")],
			["beta", join(root, "beta")],
		]);
		return createSkillTool(root, {
			getSkills: () =>
				Array.from(dirs.entries()).map(([name, dir]) => ({
					name,
					filePath: join(dir, "SKILL.md"),
					baseDir: dir,
					disableModelInvocation: false,
				})),
		});
	};

	it("should return the SKILL.md wrapped in the canonical envelope", async () => {
		setup();
		try {
			const result = await makeTool().execute("call-1", { name: "beta" });
			const text = getTextOutput(result);

			expect(text).toContain('<skill name="beta"');
			expect(text).toContain(`location="${join(root, "beta", "SKILL.md")}"`);
			expect(text).toContain(`References are relative to ${join(root, "beta")}.`);
			expect(text).toContain("</skill>");
			// Frontmatter is stripped; only the body is injected.
			expect(text).not.toContain("description:");
			expect(text).toContain("Beta contract body.");
			expect(result.details).toEqual({
				location: join(root, "beta", "SKILL.md"),
				baseDir: join(root, "beta"),
			});
		} finally {
			teardown();
		}
	});

	it("should produce an envelope parseSkillBlock can read back", async () => {
		setup();
		try {
			const result = await makeTool().execute("call-2", { name: "alpha" });
			const parsed = parseSkillBlock(getTextOutput(result));

			expect(parsed).not.toBeNull();
			expect(parsed?.name).toBe("alpha");
			expect(parsed?.location).toBe(join(root, "alpha", "SKILL.md"));
			expect(parsed?.content).toContain("Use alpha for things.");
		} finally {
			teardown();
		}
	});

	it("should fail with the available names listed when not found", async () => {
		setup();
		try {
			let message = "";
			try {
				await makeTool().execute("call-3", { name: "gamma" });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).toContain('Unknown skill "gamma"');
			expect(message).toContain("Available skills: alpha, beta");
		} finally {
			teardown();
		}
	});

	it("should report an empty roster without a skill provider", async () => {
		const tool = createSkillTool(process.cwd());
		let message = "";
		try {
			await tool.execute("call-4", { name: "anything" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toBe('Unknown skill "anything". No skills are installed.');
	});

	it("should register as a read-only built-in alongside repl", () => {
		const definitions = createAllToolDefinitions(process.cwd());

		expect(definitions.skill.name).toBe("skill");
		expect(definitions.skill.kind).toBe("skill");
		expect(definitions.skill.read_only).toBe(true);
	});
});
