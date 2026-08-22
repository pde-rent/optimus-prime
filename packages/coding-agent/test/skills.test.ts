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
	summary?: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	js?: SkillJsMetadata;
	source?: string;
}): Skill {
	const base = {
		name: options.name,
		description: options.description,
		...(options.summary ? { summary: options.summary } : {}),
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

		it("should read an optional summary from frontmatter", () => {
			const root = mkdtempSync(join(tmpdir(), "skill-summary-"));
			try {
				mkdirSync(join(root, "with-summary"), { recursive: true });
				writeFileSync(
					join(root, "with-summary", "SKILL.md"),
					// The summary must not contain ": " -- an unquoted YAML scalar ends there and
					// the whole skill disappears. Kept single-clause on purpose.
					"---\nname: with-summary\ndescription: Long contract text. More of it.\nsummary: Short routing line.\n---\n\nBody.\n",
				);
				mkdirSync(join(root, "no-summary"), { recursive: true });
				writeFileSync(
					join(root, "no-summary", "SKILL.md"),
					"---\nname: no-summary\ndescription: Long contract text. More of it.\n---\n\nBody.\n",
				);

				const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });
				const byName = new Map(skills.map((skill) => [skill.name, skill]));

				expect(byName.get("with-summary")?.summary).toBe("Short routing line.");
				expect(byName.get("no-summary")?.summary).toBeUndefined();
				expect(diagnostics).toHaveLength(0);

				const roster = formatSkillsForPrompt(skills);
				expect(roster).toContain(`- with-summary (${join(root, "with-summary", "SKILL.md")}): Short routing line.`);
				// Degrades to the first sentence for a third-party skill that declares none.
				expect(roster).toContain(`- no-summary (${join(root, "no-summary", "SKILL.md")}): Long contract text.`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
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

		it("should render one line per skill carrying its own absolute SKILL.md path", () => {
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
			expect(result).toContain("- test-skill (/path/to/test-skill/SKILL.md): A test skill.");
		});

		it("should give every entry its own resolved path and keep no Files: templates", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First.",
					filePath: "/root/one/skill-one/SKILL.md",
					baseDir: "/root/one/skill-one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second.",
					filePath: "/root/two/skill-two/SKILL.md",
					baseDir: "/root/two/skill-two",
				}),
				createTestSkill({
					name: "loose",
					description: "Loose.",
					filePath: "/elsewhere/loose.md",
					baseDir: "/elsewhere",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const entries = result.split("\n").filter((line) => line.startsWith("- "));

			// Every entry carries an absolute SKILL.md path inline: zero path reasoning left
			// to the reader.
			expect(entries).toHaveLength(3);
			for (const entry of entries) {
				expect(entry).toMatch(/^- [a-z0-9-]+( \[[a-z0-9_]+\])? \(\/[^)]+\): .+$/);
			}
			expect(entries.filter((entry) => entry.includes("/root/one/skill-one/SKILL.md"))).toHaveLength(1);
			expect(entries.filter((entry) => entry.includes("/root/two/skill-two/SKILL.md"))).toHaveLength(1);
			// The grouped-template format is gone for good: nothing to mis-expand.
			expect(result).not.toContain("Files:");
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

			expect(formatSkillsForPrompt(skills)).toContain(
				"- js-skill [js_skill] (/path/to/js-skill/SKILL.md): A JS skill.",
			);
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
			expect(introText).toContain("prefer the skill tool");
			expect(introText).toContain("read_file on the listed path is the fallback");
			expect(introText).toContain("`name [binding] (path/to/SKILL.md): summary`");
		});

		// Tier 2 has no dedicated call: the route out of a summary is the same `read` the
		// prompt already documents. A summary the model cannot expand reads as the whole
		// contract, so the route is not optional and neither is this assertion.
		it("should state the route from a summary to the full contract", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill. It has a much longer contract than the summary shows.",
					filePath: "/path/to/test-skill/SKILL.md",
					baseDir: "/path/to/test-skill",
					js: {
						importName: "test_skill",
						packagePath: "/path/to/test-skill",
						entryPath: "/path/to/test-skill/skill.js",
					},
				}),
			];

			const result = formatSkillsForPrompt(skills);

			// Name, binding and path all survive the tiering: nothing is undiscoverable.
			expect(result).toContain("- test-skill [test_skill] (/path/to/test-skill/SKILL.md): A test skill.");
			expect(result).toContain("prefer the skill tool");
			expect(result).toContain("`Object.keys(<binding>)`");
			// The deferred half must not leak back in.
			expect(result).not.toContain("much longer contract");
		});

		it("should reproduce the full description in full mode", () => {
			const description = "A test skill. It has a much longer contract than the summary shows.";
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description,
					summary: "Ignored in full mode.",
					filePath: "/path/to/test-skill/SKILL.md",
					baseDir: "/path/to/test-skill",
				}),
			];

			const result = formatSkillsForPrompt(skills, { mode: "full" });

			expect(result).toContain(`- test-skill (/path/to/test-skill/SKILL.md): ${description}`);
			expect(result).toContain("Load a skill with the skill tool when the task matches its description");
			expect(result).toContain("read_file on the listed path is the fallback");
			expect(result).toContain("`name [binding] (path/to/SKILL.md): description`");
			expect(result).not.toContain("Ignored in full mode.");
		});

		describe("tier-1 summaries", () => {
			const format = (options: { description: string; summary?: string }): string => {
				const line = formatSkillsForPrompt([
					createTestSkill({
						name: "s",
						description: options.description,
						summary: options.summary,
						filePath: "/r/s/SKILL.md",
						baseDir: "/r/s",
					}),
				])
					.split("\n")
					.find((candidate) => candidate.startsWith("- s (/r/s/SKILL.md): "));
				return line!.slice("- s (/r/s/SKILL.md): ".length);
			};

			it("should fall back to the first sentence when no summary is declared", () => {
				expect(
					format({ description: "Run the checker. `await check()` -> `{ ok, results }`. Use it often." }),
				).toBe("Run the checker.");
			});

			it("should prefer a declared summary over the description", () => {
				expect(
					format({ description: "Run the checker. Plus a lot more.", summary: "Run the project's own checker." }),
				).toBe("Run the project's own checker.");
			});

			// `websearch.run(...)`, `Bun.Image` and `0..1` all appear in real descriptions and
			// would each cut the line to nothing if a bare `.` ended a sentence.
			it("should not treat a dotted call or range as a sentence end", () => {
				expect(format({ description: "Search with `await websearch.run(q)` over 0..1 of the corpus." })).toBe(
					"Search with `await websearch.run(q)` over 0..1 of the corpus.",
				);
			});

			it("should truncate an over-long summary at a word boundary and mark it", () => {
				const result = format({
					description:
						"Load on-disk images (PNG, JPEG, GIF, WebP) into context as attachments you can actually SEE, including screenshots and scans.",
				});

				expect(result.endsWith("…")).toBe(true);
				expect(result.length).toBeLessThanOrEqual(81);
				// Truncation lands between words, never mid-word.
				expect(result).toBe("Load on-disk images (PNG, JPEG, GIF, WebP) into context as attachments you can…");
			});

			// A declared summary is the escape hatch for a bad first sentence, not a way to
			// buy unlimited prompt prefix: the cap binds whoever wrote it.
			it("should cap a declared summary too", () => {
				const result = format({ description: "Short.", summary: "x".repeat(200) });

				expect(result.length).toBeLessThanOrEqual(81);
				expect(result.endsWith("…")).toBe(true);
			});

			it("should keep a summary that has no sentence terminator", () => {
				expect(format({ description: "JSON-RPC 2.0 over HTTP" })).toBe("JSON-RPC 2.0 over HTTP");
			});
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

			expect(result).toContain(
				'- quote-skill (/path/to/quote-skill/SKILL.md): A skill with <angles> & "quotes" and an apostrophe.',
			);
			expect(result).not.toContain("&amp;");
			expect(result).not.toContain("&quot;");
			expect(result).not.toContain("&apos;");
			expect(result).not.toContain("<skill>");
			expect(result).not.toContain("<description>");
			// Each entry states its own path; nothing beyond that.
			expect(result.match(/\/path\/to\//g)).toHaveLength(2);
		});

		const make = (count: number, description: string): Skill[] =>
			Array.from({ length: count }, (_, index) =>
				createTestSkill({
					name: `skill-${index}`,
					description,
					filePath: `/skills/skill-${index}/SKILL.md`,
					baseDir: `/skills/skill-${index}`,
				}),
			);

		// The old per-skill XML form charged ~4.5KB beyond the descriptions across the
		// bundled set, most of it tags and a repeated absolute path. A line costs a name,
		// a binding and two separators; pin the marginal cost so neither can creep back.
		it("should charge only a line prefix per additional skill", () => {
			const description = "A description long enough to dominate the line it sits on.";
			const marginal =
				(formatSkillsForPrompt(make(17, description)).length - formatSkillsForPrompt(make(1, description)).length) /
				16;

			// The prefix is name + binding + inline absolute path + summary cap; the test
			// paths are ~24 chars, so the ceiling carries them explicitly.
			expect(marginal).toBeLessThanOrEqual(description.length + 20 + 30);
		});

		// The second half of the same argument. Above, a line costs a description; here, a
		// description is deferred to the SKILL.md and a line costs a bounded routing summary
		// no matter how long the contract behind it is. Pin the ceiling so a skill with a
		// 600-character description cannot charge every request for it again.
		it("should cap the marginal cost at the tier-1 budget regardless of description length", () => {
			const long = `A short purpose line. ${"Contract detail that belongs in the SKILL.md. ".repeat(12)}`;

			const summaryMarginal =
				(formatSkillsForPrompt(make(17, long)).length - formatSkillsForPrompt(make(1, long)).length) / 16;
			const fullMarginal =
				(formatSkillsForPrompt(make(17, long), { mode: "full" }).length -
					formatSkillsForPrompt(make(1, long), { mode: "full" }).length) /
				16;

			expect(summaryMarginal).toBeLessThanOrEqual(80 + 20);
			expect(fullMarginal).toBeGreaterThan(long.length);
			// The whole point of the tiering, stated as a number.
			expect(summaryMarginal * 5).toBeLessThan(fullMarginal);
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

			expect(result).toContain("- folded-skill (/path/to/folded-skill/SKILL.md): First clause second clause.");
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
			// Sorted by root directory, then by name within a root.
			const dirSkill = lines.findIndex((line) => line.startsWith("- dir-skill"));
			const loose = lines.findIndex((line) => line.startsWith("- loose-skill"));
			expect(loose).toBeLessThan(dirSkill);
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

			expect(result).toContain("- skill-one (/path/one/skill-one/SKILL.md): First skill.");
			expect(result).toContain("- skill-two (/path/two/skill-two/SKILL.md): Second skill.");
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

			expect(result).toContain("- visible-skill (/path/visible-skill/SKILL.md):");
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
