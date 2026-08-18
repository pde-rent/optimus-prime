/** Runtime capabilities the REPL sandbox exposes without any install step. */
export const DEFAULT_RLM_RUNTIME_LABELS = [
	"Bun (Bun.file, Bun.write, Bun.Glob, Bun.spawn)",
	"native fetch",
	"Web Crypto (crypto.randomUUID, crypto.subtle)",
	"Buffer",
	"TextEncoder/TextDecoder",
	"URL/URLSearchParams",
];

export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	depth?: number;
	parentAgent?: string;
	activeTools?: string[];
}

const REPL_CONTROL_PROMPT = [
	"The `ipython` tool is a persistent JavaScript/TypeScript REPL (Bun): a long-lived control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction.",
	"",
	"Do not assume the REPL is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use the REPL to coordinate the process and analyze what comes back.",
	"",
	"When running shell commands, use `%%bash` cells. If you use `%%bash`, it must be the first line of the code cell: no comments, spaces, blank lines, or statements before it. Cell bodies are otherwise plain JavaScript/TypeScript; top-level `await` is supported and the last expression is echoed as the cell result.",
	"",
	"Important: do not install dependencies into the REPL just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface (its documented commands, `bun run ...`, `uv run ...`, the project's own interpreter, from the repo root). Treat failures from that native environment as the relevant result.",
	"",
	"Use JavaScript for reading, searching, and editing files — it gives you reusable variables you can slice, filter, and act on without re-reading. Always assign read/search results to named variables so you can revisit them later.",
	"",
	"Each `%%bash` cell runs in a throw-away subshell, so shell-level state (`cd`, `export`, `source`, shell variables) does NOT carry to later cells. Keep dependent shell steps inside one `%%bash` cell when they need shared shell state, or use REPL-level equivalents that survive across calls: `cd('<dir>')` for the working directory and `env.VAR = '...'` for environment variables — these apply to all subsequent `%%bash` calls and to file paths resolved in later cells.",
	"",
	"REPL state, by contrast, persists across cells: `const`/`let`/`function`/`class` declarations, imports, notes, parsed outputs, and helper data structures all remain available in every later turn. Tool calls are themselves `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
	"",
	"Load extra modules with `await import('<specifier>')` (node builtins, project files by path, and installed packages). Prefer the standard library and the project's own dependencies over adding new ones.",
	"",
	"Continual harness state is available as `rlm.harness` and `rlm.get_harness_state()`. CRUD calls are local to this Prime Agent session by default: `rlm.harness.create_memory(...)`, `rlm.harness.update_memory(...)`, `rlm.harness.delete_memory(...)`, `rlm.harness.create_skill(...)`, `rlm.harness.update_skill(...)`, `rlm.harness.delete_skill(...)`, `rlm.harness.create_subagent(...)`, `rlm.harness.update_subagent(...)`, `rlm.harness.delete_subagent(...)`, `rlm.harness.create_prompt_note(...)`, `rlm.harness.update_prompt_note(...)`, `rlm.harness.delete_prompt_note(...)`, plus `rlm.harness.record_refinement(...)` and `rlm.harness.overview()`. Pass `{ global: true }` only for stable cross-session lessons.",
	"",
	"Terminology: continual harness names the persisted prompt, memory, skill, and subagent layer; RLM names the runtime, REPL, and native call interface exposed to the model.",
	"",
	"RLM-native call contract: installed skills are preloaded bindings in the REPL global scope. Read the matching SKILL.md and call its documented function, such as `await <skill_binding>.<function>(...)`. Continual harness skill entries carry an explicit `reference` and `arguments` contract. Spawn a reusable delegation spec with `await rlm('sub-task')`; admission returns a child handle immediately. Results arrive only through an available messaging capability or files, never as an `rlm()` return value. Do not invent non-native wrappers such as `call_skill(...)` or `run_subagent(...)`.",
].join("\n");

export interface ChildAgentDoctrineOptions {
	depth?: number;
	parentAgent?: string;
	installedSkills?: string[];
	activeTools?: string[];
}

export function buildChildAgentDoctrine(options: ChildAgentDoctrineOptions): string | undefined {
	const depth = options.depth ?? 0;
	const hasIpython = options.activeTools === undefined || options.activeTools.includes("ipython");
	const hasAgentMessage = options.installedSkills?.includes("agent_message") ?? false;
	if (depth <= 0) return undefined;

	const lines = [
		`You are a child agent spawned by ${options.parentAgent ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
	];
	if (hasAgentMessage && hasIpython) {
		lines.push(
			'When a task calls for an answer, reply explicitly with `await agent_message.send(message, { receiver_role: "parent" })`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.',
		);
	}
	return lines.join("\n");
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const hasAgentMessage = installedSkills.includes("agent_message");
	const hasAgentObserve = installedSkills.includes("agent_observe");
	const allowRecursion = options.allowRecursion ?? true;
	const depth = options.depth ?? 0;
	const activeTools = options.activeTools ?? [];
	const hasIpython = options.activeTools === undefined ? true : activeTools.includes("ipython");
	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
		`Recursive agent depth: ${depth}`,
		`REPL runtime: ${DEFAULT_RLM_RUNTIME_LABELS.join(", ")}.`,
	];

	const childDoctrine = buildChildAgentDoctrine(options);
	if (childDoctrine) {
		parts.push("", childDoctrine);
	}

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		if (hasIpython) {
			skillLines.push(`Installed skills (preloaded REPL bindings): ${installed}.`);
			skillLines.push(
				"Read each skill's SKILL.md for its API. Inspect a binding with `Object.keys(<skill>)`, then read its SKILL.md for the argument contract.",
			);
		} else {
			skillLines.push(`Installed skills: ${installed}. Read their SKILL.md files for usage.`);
		}
		if (hasIpython && installedSkills.includes("edit")) {
			skillLines.push(
				'For targeted existing-file edits, prefer the preloaded async `edit` skill: `await edit("pkg/file.ts", oldText, newText)`. Use exact old/new strings, built from inspected file slices when the text contains backticks or template placeholders.',
			);
		}
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}
	if (hasAgentMessage) {
		parts.push(
			"Agent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.",
		);
	}
	if (hasAgentObserve) {
		parts.push(
			"Agent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child.",
		);
	}

	if (allowRecursion && hasIpython) {
		parts.push(
			"",
			"A callable `rlm` is already in your global namespace. `await rlm('sub-task')` spawns a child and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, and `model`; it never waits for or returns the child's answer.",
			"Choose a stable child name with `await rlm('sub-task', name='api-reviewer')`; names must be unique among siblings. If omitted, the host generates a readable unique name.",
			"A child inherits your model. If a different model is explicitly requested, use `await rlm.find_models(...)` and an exact returned selector. An unavailable requested model fails spawn; decide whether to retry or omit `model`.",
		);
		if (hasAgentMessage) {
			parts.push(
				"Children reply explicitly with `await agent_message.send(message, { receiver_role: 'parent' })` when an answer is needed. Replies and follow-ups arrive as ordinary agent messages; not every task requires a reply.",
				"Use `await agent_message.list_agents()` to discover family and `await rlm.list_subagents()` to recover direct child handles. Use `agent_message.send(message, { receiver_role: 'child', receiver_name: child.name })` for follow-ups.",
			);
		} else {
			parts.push("Use `await rlm.list_subagents()` to recover direct child handles after admission.");
		}
		if (hasAgentObserve) {
			parts.push(
				"Use `agent_observe` to inspect a child's rollout. Observation is restricted to your parent, siblings, and direct children; relay through the intermediate child for deeper descendants.",
			);
		} else {
			parts.push("Inspect files a child wrote when you need to collect its work without an observation capability.");
		}
		parts.push(
			"Spawn independent children in separate calls and end your turn instead of awaiting completion. Multiple replies may arrive over multiple turns. Delete a direct child explicitly with `await rlm.delete_subagent(child)` when it is no longer needed.",
		);
	}

	if (hasIpython) {
		parts.push("", REPL_CONTROL_PROMPT);
		if (installedSkills.includes("refine")) {
			parts.push(
				"",
				"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Use `await refine.run()` to turn repeated delegation patterns into reusable subagent specs, repeated procedures into skills, durable facts/preferences into memories, and narrow behavioral policies into prompt addendums. It returns immediately and runs when the current turn ends, so continue working normally after calling it. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
			);
		}
	}

	return parts.join("\n");
}

/**
 * Supplemental sub-agent delegation guidance, appended after the base RLM
 * prompt (see system-prompt.ts). The recursion block covers the mechanics
 * (`rlm(...)` admission and handle management); this block adds the
 * when and why in the same When -> Why -> menu order Claude Code's Agent tool
 * uses. The subagent-spec menu itself renders just after this, inside the
 * harness-state block.
 */
export function buildSubagentGuidance(
	options: { includeRefineExamples?: boolean; hasAgentMessage?: boolean; hasAgentObserve?: boolean } = {},
): string {
	const lines = [
		"# Delegating to sub-agents",
		"",
		"Spawn independent, self-contained work with `const handle = await rlm('task', { name: 'worker' })`. This returns at admission, not completion; keep the handle to stop or inspect the child later.",
	];
	if (options.hasAgentMessage) {
		lines.push(
			"Ask for an explicit reply when needed. A child replies with `await agent_message.send(message, { receiver_role: 'parent' })`; parent follow-ups use `receiver_role: 'child'` plus the child's name or id. Not every message needs a reply.",
		);
	}
	lines.push("Use `await rlm.list_subagents()` after kernel restart or compaction.");
	if (options.hasAgentObserve) {
		lines.push("Use `agent_observe` for bounded transcript inspection.");
	}
	lines.push(
		"Have children write files and read those files for fan-in.",
		"Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
	);
	if (options.includeRefineExamples ?? true) {
		lines.push("Persist genuinely reusable delegation patterns with `await refine.run()`.");
	}
	return lines.join("\n");
}
