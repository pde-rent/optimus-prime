import { getLogger } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import ignore from "../utils/ignore-matcher.js";
import { canonicalizePath } from "../utils/paths.js";
import { toPosixPath } from "../utils/shared.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { addIgnoreRules, type IgnoreMatcher } from "./ignore-rules.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { expandTildePath } from "./tools/path-utils.js";

const log = getLogger("coding-agent.skills");

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Tier-1 roster budget, per skill.
 *
 * The roster is prompt prefix: every request pays for every skill, and most turns use
 * none of them. A routing line only has to get the model from "I need to do X" to the
 * right SKILL.md; the contract itself is one `read()` away and is paid for only by the
 * turn that needs it. The cap binds an author-written `summary` too, so a third-party
 * skill cannot price itself into every request.
 */
const MAX_SUMMARY_LENGTH = 80;

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	/**
	 * Optional one-line routing text for the prompt roster. Absent, the first sentence of
	 * `description` is used, so no existing skill has to be rewritten to benefit.
	 *
	 * YAML trap: a plain unquoted scalar cannot contain ": " anywhere, so a summary like
	 * `summary: Charts: bar, line` silently drops the entire skill. Quote it or reword.
	 */
	summary?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export type SkillKind = "markdown" | "js";

export interface SkillJsMetadata {
	/** Global the skill is bound to inside the REPL sandbox (name with `-` -> `_`). */
	importName: string;
	/** Skill root directory. */
	packagePath: string;
	/** ESM module the REPL imports to build the skill API. */
	entryPath: string;
}

interface BaseSkill {
	name: string;
	description: string;
	/** Author-written roster line; derived from `description` when absent. */
	summary?: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface MarkdownSkill extends BaseSkill {
	kind: "markdown";
	js?: undefined;
}

export interface JsSkill extends BaseSkill {
	kind: "js";
	js: SkillJsMetadata;
}

export type Skill = MarkdownSkill | JsSkill;

export interface JsSkillRuntimeInfo extends SkillJsMetadata {
	name: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];

	if (name !== parentDirName) {
		errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	}

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

function jsImportNameForSkill(name: string): string {
	return name.replaceAll("-", "_");
}

function isValidJsImportName(name: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Entry-point candidates for a JS skill, in resolution order. */
const JS_SKILL_ENTRY_FILES = ["skill.js", "skill.mjs", "skill.ts"];

function detectJsSkill(skillDir: string, name: string, diagnostics: ResourceDiagnostic[]): SkillJsMetadata | null {
	let entryPath: string | null = null;
	for (const candidate of JS_SKILL_ENTRY_FILES) {
		const fullPath = join(skillDir, candidate);
		try {
			if (statSync(fullPath).isFile()) {
				entryPath = fullPath;
				break;
			}
		} catch {
			// candidate absent: try the next one
		}
	}
	if (!entryPath) {
		return null;
	}

	const importName = jsImportNameForSkill(name);
	if (!isValidJsImportName(importName)) {
		diagnostics.push({
			type: "warning",
			message: `js skill binding name "${importName}" is invalid`,
			path: entryPath,
		});
		return null;
	}

	return {
		importName,
		packagePath: skillDir,
		entryPath,
	};
}

export function getJsSkillRuntimeInfo(skills: readonly Skill[]): JsSkillRuntimeInfo[] {
	return skills
		.filter((skill): skill is JsSkill => skill.kind === "js")
		.map((skill) => ({
			name: skill.name,
			importName: skill.js.importName,
			packagePath: skill.js.packagePath,
			entryPath: skill.js.entryPath,
		}));
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		// Sort by name: readdir order is filesystem-dependent, and discovery order
		// decides which skill wins a name/js-binding collision.
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch (error) {
		log.warn("skill directory scan failed", {
			dir,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return { skills, diagnostics };
}

/**
 * Raw text of a top-level scalar key in frontmatter, joining indented continuation lines.
 *
 * Bun's YAML parses `description:` followed by an indented `key: value` as a nested
 * mapping instead of a string, which would drop the description. This recovers the
 * author's literal text; returns null when the key is absent or its value is empty.
 */
function rawTopLevelScalar(yamlString: string, key: string): string | null {
	const lines = yamlString.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (start === -1) {
		return null;
	}
	const parts = [lines[start].slice(key.length + 1).trim()];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "" || !/^\s/.test(line)) {
			break;
		}
		parts.push(line.trim());
	}
	const text = parts.join(" ").trim();
	return text === "" ? null : text;
}

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, yamlString } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		let description = frontmatter.description;
		if (typeof description !== "string" && yamlString) {
			// A plain YAML scalar cannot contain ": "; Bun parses the indented remnant as a
			// nested mapping rather than throwing. Recover the literal text and tell the
			// author to quote it, instead of dropping the skill with a cryptic error.
			const raw = rawTopLevelScalar(yamlString, "description");
			if (raw) {
				diagnostics.push({
					type: "warning",
					message: 'description contains ": " - wrap the value in quotes',
					path: filePath,
				});
				description = raw;
			}
		}

		const descErrors = validateDescription(description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		let name = parentDirName;
		if (typeof frontmatter.name === "string") {
			name = frontmatter.name;
		} else if (frontmatter.name != null) {
			diagnostics.push({
				type: "warning",
				message: `name must be a string, got ${typeof frontmatter.name} - using directory name "${parentDirName}"`,
				path: filePath,
			});
		}

		const nameErrors = validateName(name, parentDirName);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		if (!description || description.trim() === "") {
			return { skill: null, diagnostics };
		}

		const js = basename(filePath) === "SKILL.md" ? detectJsSkill(skillDir, name, diagnostics) : null;
		const rawSummary = typeof frontmatter.summary === "string" ? frontmatter.summary.trim() : "";
		const baseSkill: BaseSkill = {
			name,
			description,
			...(rawSummary ? { summary: rawSummary } : {}),
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		};

		return {
			skill: js ? { ...baseSkill, kind: "js", js } : { ...baseSkill, kind: "markdown" },
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		// Bun's YAML failure is position-less ("Unexpected token"), and the consequence — the
		// skill is absent from the session, bindings and all — is what a reader actually needs.
		// `": "` is far and away the most common cause: it terminates a plain scalar, so a
		// description mentioning a shape like `{ current, agents: [...] }` drops the whole skill.
		const cause = /yaml/i.test(message)
			? ' A plain (unquoted) YAML scalar cannot contain ": " — quote the value or drop the space after the colon.'
			: "";
		diagnostics.push({ type: "error", message: `${message}. Skill not loaded.${cause}`, path: filePath });
		return { skill: null, diagnostics };
	}
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * First sentence of a description.
 *
 * A `.` only closes a sentence when whitespace follows it. These descriptions are dense
 * with `websearch.run(...)`, `Bun.Image` and `0..1`, all of which would otherwise cut the
 * line to nothing; an abbreviation followed by a space is far rarer than any of them.
 */
function firstSentence(text: string): string {
	const end = text.search(/[.!?]\s/);
	return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * Tier-1 routing line: `summary` frontmatter if the author wrote one, else the first
 * sentence of `description` -- which is where these descriptions already put "what is
 * this for" before handing the rest of the text to the API contract.
 *
 * Truncation is visible on purpose. `…` is the model's cue that the line is an index
 * entry rather than the contract, and that the SKILL.md holds the rest.
 */
function summarizeSkillForPrompt(skill: Pick<Skill, "summary" | "description">): string {
	const explicit = skill.summary ? collapse(skill.summary) : "";
	const source = explicit || firstSentence(collapse(skill.description));
	if (source.length <= MAX_SUMMARY_LENGTH) return source;
	const cut = source.slice(0, MAX_SUMMARY_LENGTH);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, "")}…`;
}

/**
 * `summary` renders a routing line per skill and defers the contract to the SKILL.md;
 * `full` renders the whole description, as every request used to.
 */
export type SkillRosterMode = "summary" | "full";

/**
 * Deferring is the default because this harness cannot be used without the lookup it
 * depends on: `repl` is the only tool a session is guaranteed to have, and `read(path)`
 * is how every other file in the prompt is reached already. A model too weak to follow
 * a stated path to a file cannot run an agent loop here at all, so there is no config
 * in which `full` is the safer default -- only ones where it is the cheaper trade.
 */
const DEFAULT_SKILL_ROSTER_MODE: SkillRosterMode = "summary";

/**
 * Format skills for inclusion in a system prompt.
 *
 * One line per skill. The Agent Skills standard suggests a per-skill XML block
 * (https://agentskills.io/integrate-skills) and this deviates from it: nothing reads this
 * text back -- it is prompt prefix, paid on every request, and consumed only by the model --
 * so the tags, the repeated absolute paths and the entity escaping were charging ~4.5KB for
 * the same four facts a line carries. The SKILL.md files themselves still follow the spec.
 *
 * The same argument applied a second time gives the two tiers. A full description is the
 * contract for a skill the turn is about to call, and dead weight on every turn that is
 * not; `summary` bills the routing line always and the contract only when it is needed.
 * Nothing becomes undiscoverable: every name, binding and path still renders, and the
 * intro states the route to the rest.
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[], options?: { mode?: SkillRosterMode }): string {
	const mode = options?.mode ?? DEFAULT_SKILL_ROSTER_MODE;
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	// Every entry carries its own resolved absolute SKILL.md path. The previous format
	// grouped entries under a per-root `Files: <root>/{name}/SKILL.md` template, which
	// priced ~1KB cheaper on the bundled set but forced the reader to expand the template
	// itself -- a step models get wrong, and each miss costs a find plus a retry to load
	// one skill. One-step resolution wins; the bytes are the accepted cost.
	const lines = visibleSkills
		.map((skill, index) => ({ skill, root: dirname(skill.filePath), index }))
		.sort((a, b) => (a.root === b.root ? a.index - b.index : a.root < b.root ? -1 : 1))
		.map(({ skill }) => {
			const binding = skill.kind === "js" ? ` [${skill.js.importName}]` : "";
			// A folded or multi-line YAML description would otherwise break one-line-per-skill.
			const text = mode === "full" ? collapse(skill.description) : summarizeSkillForPrompt(skill);
			return `- ${skill.name}${binding} (${skill.filePath}): ${text}`;
		});

	// The route out of Tier 1 is stated here rather than assumed: an entry the model
	// cannot expand is worse than no entry, because it reads as the whole contract.
	const intro =
		mode === "full"
			? [
					"\n\nSkills are specialized instructions for specific tasks. Load a skill with the skill tool when the task matches its description; read_file on the listed path is the fallback. Resolve relative paths inside a SKILL.md against that skill's directory.",
					"Entries are `name [binding] (path/to/SKILL.md): description`; a binding is preloaded into the persistent JavaScript REPL and callable directly.",
				]
			: [
					"\n\nSkills are specialized instructions for specific tasks. Each entry is a routing summary, not the contract: prefer the skill tool to load a skill before using it; read_file on the listed path is the fallback. Resolve relative paths inside a SKILL.md against that skill's directory.",
					"Entries are `name [binding] (path/to/SKILL.md): summary`, and `…` marks an abridged line. A binding is preloaded into the persistent JavaScript REPL and callable directly, but its call signature lives in the SKILL.md — read that, or `Object.keys(<binding>)`, before the first call.",
				];

	return [...intro, "", "<available_skills>", ...lines, "</available_skills>"].join("\n");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

function resolveSkillPath(p: string, cwd: string): string {
	const normalized = expandTildePath(p.trim());
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { cwd, agentDir, skillPaths, includeDefaults } = options;

	const resolvedAgentDir = agentDir ?? getAgentDir();

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const jsBindingMap = new Map<string, Skill>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];
	const jsBindingDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const realPath = canonicalizePath(skill.filePath);

			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
				if (skill.kind === "js") {
					const existingJsSkill = jsBindingMap.get(skill.js.importName);
					if (existingJsSkill) {
						jsBindingDiagnostics.push({
							type: "warning",
							message: `js binding name "${skill.js.importName}" is shared by skills "${existingJsSkill.name}" and "${skill.name}"`,
							path: skill.filePath,
						});
					} else {
						jsBindingMap.set(skill.js.importName, skill);
					}
				}
			}
		}
	}

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolveSkillPath(rawPath, cwd);
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics, ...jsBindingDiagnostics],
	};
}
