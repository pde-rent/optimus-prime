import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { readFile as fsReadFile } from "fs/promises";
import { stripFrontmatter } from "../../utils/frontmatter.js";
import type { ToolDefinition } from "../extensions/types.js";
import { buildSkillBlock } from "../skill-blocks.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const skillSchema = Type.Object(
	{
		name: Type.String({
			description:
				'The skill name exactly as it appears in the roster (e.g. "websearch", not a path). On an unknown name the error lists every available name; only retry with one of those.',
		}),
	},
	{ additionalProperties: false },
);

export type SkillToolInput = Static<typeof skillSchema>;

export interface SkillToolDetails {
	/** Absolute path of the SKILL.md that was loaded. */
	location?: string;
	/** Skill directory that relative references inside the SKILL.md resolve against. */
	baseDir?: string;
}

/**
 * Minimal shape the tool needs. Structural on purpose: callers hand over the live
 * ResourceLoader result, tests hand over fixtures.
 */
export interface SkillToolSkill {
	name: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
}

/**
 * Pluggable operations for the skill tool.
 * Override these to load skills from remote systems (for example SSH).
 */
export interface SkillOperations {
	/** List currently available skills, in discovery order. */
	list: () => SkillToolSkill[];
	/** Read a SKILL.md as text (throws when unreadable). */
	readFile: (absolutePath: string) => Promise<string>;
}

const defaultSkillOperations: SkillOperations = {
	list: () => [],
	readFile: (path) => fsReadFile(path, "utf-8"),
};

export interface SkillToolOptions {
	/** Live skill provider; defaults to an empty roster. */
	getSkills?: () => SkillToolSkill[];
	/** Custom operations. Default: local filesystem */
	operations?: SkillOperations;
}

/**
 * Load one skill's SKILL.md into context in a single step.
 *
 * Use whenever a task matches an installed skill's description and the contract is
 * needed before calling it -- this replaces path-guessing plus read_file entirely. Do
 * not use it to browse: the roster line already carries name, binding, path and
 * summary, so loading is only worth a call when the task matches the summary. Output
 * contract: success returns the SKILL.md body wrapped in the same <skill> envelope as
 * /skill:name expansion, with relative paths resolved against the stated baseDir;
 * failure throws `Unknown skill "<name>". Available skills: ...`.
 */
export function createSkillToolDefinition(
	_cwd: string,
	options?: SkillToolOptions,
): ToolDefinition<typeof skillSchema, SkillToolDetails> {
	const getSkills = options?.getSkills ?? defaultSkillOperations.list;
	const ops = options?.operations ?? { ...defaultSkillOperations, list: getSkills };
	const definition: ToolDefinition<typeof skillSchema, SkillToolDetails> = {
		name: "skill",
		label: "Load skill",
		description:
			"Load an installed skill's SKILL.md by name - the default and fastest way to get a skill's full contract into context; runs in-process on Windows/macOS/Linux; replaces catting the roster path via bash. Not for deciding relevance - the roster summary already covers that; loaded skills need no re-read.",
		promptSnippet: "Load an installed skill's SKILL.md by name",
		parameters: skillSchema,
		executionMode: "parallel",
		// Machine-readable envelope so permission prompts and TUI grouping can drive off
		// it instead of hard-coding tool names: read-only, no confirmation needed.
		kind: "skill",
		read_only: true,
		async execute(
			_toolCallId,
			input: SkillToolInput,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: SkillToolDetails }> {
			const skills = ops.list();
			const skill = skills.find((candidate) => candidate.name === input.name);
			if (!skill) {
				const available = skills.map((candidate) => candidate.name).join(", ");
				throw new Error(
					available
						? `Unknown skill "${input.name}". Available skills: ${available}.`
						: `Unknown skill "${input.name}". No skills are installed.`,
				);
			}

			try {
				const content = await ops.readFile(skill.filePath);
				const body = stripFrontmatter(content).trim();
				return {
					content: [{ type: "text", text: buildSkillBlock(skill, body) }],
					details: { location: skill.filePath, baseDir: skill.baseDir },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Could not read SKILL.md for skill "${input.name}" at ${skill.filePath}: ${message}`);
			}
		},
	};
	return definition;
}

export function createSkillTool(
	_cwd: string,
	options?: SkillToolOptions,
): AgentTool<typeof skillSchema, SkillToolDetails> {
	return wrapToolDefinition(createSkillToolDefinition(_cwd, options)) as AgentTool<
		typeof skillSchema,
		SkillToolDetails
	>;
}
