import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import {
	formatSkillsForPrompt,
	getJsSkillRuntimeInfo,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillJsMetadata,
} from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	js?: SkillJsMetadata;
	source?: string;
}): Skill {
	const base = {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
	return options.js
		? {
				...base,
				kind: "js",
				js: options.js,
			}
		: {
				...base,
				kind: "markdown",
			};
}

function writeJsSkill(root: string, name: string): void {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ${name}
description: Test skill ${name}
---

Use this skill for tests.
`,
	);
	writeFileSync(join(skillDir, "skill.js"), "export default () => ({ run: async () => 'ok' });\n");
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name doesn't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(true);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			// The parser's message is its own; what is contracted is that the failure is reported.
			expect(diagnostics.some((d: ResourceDiagnostic) => /yaml/i.test(d.message))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});

		it("should load JS-backed skills from the same skill root", () => {
			const skillDir = join(fixturesDir, "js-skill");
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: skillDir,
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0]).toMatchObject({
				name: "js-skill",
				kind: "js",
				js: {
					importName: "js_skill",
					packagePath: skillDir,
					entryPath: join(skillDir, "skill.js"),
				},
			});
			expect(getJsSkillRuntimeInfo(skills)).toEqual([
				{
					name: "js-skill",
					importName: "js_skill",
					packagePath: skillDir,
					entryPath: join(skillDir, "skill.js"),
				},
			]);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should render one line per skill under a shared path template", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/test-skill/SKILL.md",
					baseDir: "/path/to/test-skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("Files: /path/to/{name}/SKILL.md");
			expect(result).toContain("- test-skill: A test skill.");
		});

		it("should name the REPL binding inline for JS-backed skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "js-skill",
					description: "A JS skill.",
					filePath: "/path/to/js-skill/SKILL.md",
					baseDir: "/path/to/js-skill",
					js: {
						importName: "js_skill",
						packagePath: "/path/to/js-skill",
						entryPath: "/path/to/js-skill/skill.js",
					},
				}),
			];

			expect(formatSkillsForPrompt(skills)).toContain("- js-skill [js_skill]: A JS skill.");
		});

		it("should include intro text before the roster", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/test-skill/SKILL.md",
					baseDir: "/path/to/test-skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const rosterStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, rosterStart);

			expect(introText).toContain("Skills are specialized instructions for specific tasks");
			expect(introText).toContain("Read a skill's SKILL.md with the repl tool");
			expect(introText).toContain("`name [binding]: description`");
		});

		// The block is permanent prompt prefix: XML tags, per-skill absolute paths and
		// entity escaping cost ~4.5KB across the bundled set for no extra fact. Pin the
		// format so none of them creeps back in.
		it("should spend no bytes on markup, entities, or repeated paths", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "quote-skill",
					description: 'A skill with <angles> & "quotes" and an apostrophe.',
					filePath: "/path/to/quote-skill/SKILL.md",
					baseDir: "/path/to/quote-skill",
				}),
				createTestSkill({
					name: "other-skill",
					description: "Another skill.",
					filePath: "/path/to/other-skill/SKILL.md",
					baseDir: "/path/to/other-skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain('- quote-skill: A skill with <angles> & "quotes" and an apostrophe.');
			expect(result).not.toContain("&amp;");
			expect(result).not.toContain("&quot;");
			expect(result).not.toContain("&apos;");
			expect(result).not.toContain("<skill>");
			expect(result).not.toContain("<description>");
			// One path for both skills, not one each.
			expect(result.match(/\/path\/to\//g)).toHaveLength(1);
		});

		// The old per-skill XML form charged ~4.5KB beyond the descriptions across the
		// bundled set, most of it tags and a repeated absolute path. A line costs a name,
		// a binding and two separators; pin the marginal cost so neither can creep back.
		it("should charge only a line prefix per additional skill", () => {
			const description = "A description long enough to dominate the line it sits on.";
			const make = (count: number): Skill[] =>
				Array.from({ length: count }, (_, index) =>
					createTestSkill({
						name: `skill-${index}`,
						description,
						filePath: `/skills/skill-${index}/SKILL.md`,
						baseDir: `/skills/skill-${index}`,
					}),
				);

			const marginal = (formatSkillsForPrompt(make(17)).length - formatSkillsForPrompt(make(1)).length) / 16;

			expect(marginal).toBeLessThanOrEqual(description.length + 20);
		});

		it("should keep a multi-line description on one line", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "folded-skill",
					description: "First clause\nsecond clause.",
					filePath: "/path/to/folded-skill/SKILL.md",
					baseDir: "/path/to/folded-skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("- folded-skill: First clause second clause.");
			expect(result.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
		});

		it("should carry its own path for a skill outside the template shape", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "loose-skill",
					description: "A loose skill.",
					filePath: "/path/to/loose.md",
					baseDir: "/path/to",
				}),
				createTestSkill({
					name: "dir-skill",
					description: "A directory skill.",
					filePath: "/path/to/dir-skill/SKILL.md",
					baseDir: "/path/to/dir-skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const lines = result.split("\n");

			expect(result).toContain("- loose-skill (/path/to/loose.md): A loose skill.");
			// Path-carrying entries precede the template line that would otherwise claim them.
			expect(lines.findIndex((line) => line.startsWith("- loose-skill"))).toBeLessThan(
				lines.findIndex((line) => line.startsWith("Files: ")),
			);
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/skill-one/SKILL.md",
					baseDir: "/path/one/skill-one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/skill-two/SKILL.md",
					baseDir: "/path/two/skill-two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("- skill-one: First skill.");
			expect(result).toContain("- skill-two: Second skill.");
			// One template line per root directory.
			expect(result).toContain("Files: /path/one/{name}/SKILL.md");
			expect(result).toContain("Files: /path/two/{name}/SKILL.md");
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible-skill/SKILL.md",
					baseDir: "/path/visible-skill",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden-skill/SKILL.md",
					baseDir: "/path/hidden-skill",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("- visible-skill:");
			expect(result).not.toContain("hidden-skill");
			expect(result.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".pi/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.pi/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});

		it("should warn when JS skills share a binding name", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "optimus-skills-"));
			try {
				writeJsSkill(tempDir, "web-search");
				writeJsSkill(tempDir, "web_search");

				const { skills, diagnostics } = loadSkills({
					agentDir: emptyAgentDir,
					cwd: emptyCwd,
					skillPaths: [tempDir],
					includeDefaults: false,
				});

				expect(skills.map((skill) => skill.name).sort()).toEqual(["web-search", "web_search"]);
				expect(
					diagnostics.some((d: ResourceDiagnostic) =>
						d.message.includes('js binding name "web_search" is shared by skills "web-search" and "web_search"'),
					),
				).toBe(true);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
