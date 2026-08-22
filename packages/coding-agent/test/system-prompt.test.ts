import { describe, expect, test } from "bun:test";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import { DEFAULT_RLM_RUNTIME_LABELS } from "../src/core/prompts/rlm.js";
import type { HarnessEntry, HarnessState, RefinementKind } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			source: "local",
			path: `/skills/${name}/SKILL.md`,
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
		kind: "markdown",
	};
}

function jsSkill(name: string, importName = name.replaceAll("-", "_")): Skill {
	const base = skill(name);
	return {
		...base,
		kind: "js",
		js: {
			importName,
			packagePath: `/skills/${name}`,
			entryPath: `/skills/${name}/skill.js`,
		},
	};
}

function harnessEntry(kind: RefinementKind, id: string, title: string, path: string, content: string): HarnessEntry {
	return {
		id,
		kind,
		title,
		content,
		path,
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: "2026-06-08T00:00:00.000Z",
		updated_at: "2026-06-08T00:00:00.000Z",
		version: 1,
	};
}

describe("buildRlmPrompt", () => {
	const CODE_CRAFT_MARKER = "Before adding code, take the cheapest option";
	const VERIFICATION_MARKER = "exercise the path you changed and read the diff";

	test("omits code craft and verification without a code-changing tool", () => {
		for (const activeTools of [[], ["websearch"]]) {
			const prompt = buildRlmPrompt({
				cwd: "/repo",
				messagesPath: "/repo/session.jsonl",
				activeTools,
				allowRecursion: false,
			});
			expect(prompt).not.toContain(CODE_CRAFT_MARKER);
			expect(prompt).not.toContain(VERIFICATION_MARKER);
		}
	});

	test("includes code craft for bash-only and edit-only sessions", () => {
		// Guards the shared CODE_CHANGING_TOOLS set: `repl` is the default, so a
		// regression here would otherwise stay invisible.
		for (const activeTools of [["bash"], ["edit"]]) {
			const prompt = buildRlmPrompt({
				cwd: "/repo",
				messagesPath: "/repo/session.jsonl",
				activeTools,
				allowRecursion: false,
			});
			expect(prompt).toContain(CODE_CRAFT_MARKER);
			expect(prompt).toContain(VERIFICATION_MARKER);
		}
	});

	test("applies code craft to child agents", () => {
		// Unlike the progress and output-shape sections, which are root-only: a child
		// writes code the parent merges.
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["repl"],
			depth: 1,
			parentAgent: "root",
		});
		expect(prompt).toContain(CODE_CRAFT_MARKER);
		expect(prompt).toContain(VERIFICATION_MARKER);
	});

	test("keeps code craft inside the cacheable prefix", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["repl"],
			allowRecursion: false,
		});
		// Everything before the first per-session line is shared by every sibling agent.
		expect(prompt.indexOf(CODE_CRAFT_MARKER)).toBeLessThan(prompt.lastIndexOf("Conversation log:"));
		expect(prompt.indexOf(VERIFICATION_MARKER)).toBeLessThan(prompt.lastIndexOf("Conversation log:"));
	});

	test("builds the rlm prompt without recursion", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch", "refine"],
			activeTools: ["repl"],
			allowRecursion: false,
		});

		expect(prompt).toBe(
			[
				"You are a general purpose agent that uses code to solve tasks.",
				"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
				"When you are done, stop calling tools and state your final answer.",
				"",
				"For slow or independently completing work, use a nonblocking control loop: start the work, record its handle or output location, then end your turn. Read the result on a later turn or when a reply arrives.",
				"When delegation is available and useful, assign independent substantive tasks to separate workers. Start independent workers without waiting for each one sequentially, and let them run in parallel.",
				"Do not keep the turn open by polling with `Bun.sleep()`, `setTimeout`, or shell `sleep`, and do not replace polling with a long blocking `await`. Await only the short operation needed to start work or inspect a result that is already available; otherwise end the turn.",
				"",
				"As the user-facing root agent, when work follows a plan, uses many subagents, or spans multiple turns, proactively give regular concise progress updates so the user does not have to ask. State the current plan, what has completed, any blockers, the proposed fixes, and the next actions. Lead with user-visible outcomes rather than internal process or gate names. Mention internal details only when they explain a blocker or decision. Send an update at meaningful milestones and before ending a turn while work is still running. Do not repeat unchanged status or interrupt short work with unnecessary updates.",
				"",
				"Choose the shape that carries the result, not prose by default. Prose for judgements and next steps. A table for a handful of labelled values the reader will compare exactly. Code or a diff for anything they will copy or apply. A chart when the shape of the data is the answer.",
				"When the `chart` skill is loaded its output is plain text, so it goes anywhere prose goes. `chart(values)` for a trend, `chart.bar` for magnitudes, `chart.spark` inline in a sentence or table cell, `chart.gauge(ratio)` for progress, `chart.histogram` for a distribution, `chart.candle` for OHLC.",
				"Reach for a chart on latency and timing distributions, token or cost trends over a run, benchmark comparisons, error-rate movement, file-size or coverage changes, and anything you would otherwise describe as rising, falling, or spiky. Three numbers do not need a chart; twenty usually do.",
				"Do not chart and then restate the same numbers in prose. Lead with the shape, then say what it means and what follows from it.",
				"",
				"Use simplified technical English by default for user-facing prose.",
				"Prefer short sentences, common words, and concrete verbs. State one main action or fact per sentence when practical. Use lists for steps or conditions.",
				"Keep necessary technical terms, names, commands, code, paths, and exact quoted text unchanged. State uncertainty directly.",
				"Treat this as clarity guidance, not a claim of formal ASD-STE100 compliance. Preserve a requested format, terminology, and necessary precision.",
				"Answer the question that was asked, first. No preamble, no restating the request, no closing offer of further help. If a table or list carries the answer, lead with it.",
				"Casual phrasing from the user is not a request to perform friendliness. Match their brevity, never their register: no greetings, no exclamations, no emoji unless the user is using emoji as data.",
				"",
				"Before adding code, take the cheapest option that fully solves the stated task: reuse what this codebase already has, then the standard library or an installed dependency, then new code. Read the code the task touches and trace the real flow before choosing; the smallest change in the wrong place is a second bug. This is a bar on inventing extra structure, never a licence to under-build what was asked for.\nConsolidate aggressively. When the same logic would live in more than one place, make it one unit -- one function, one module, one class, one table, one test -- and use genericity or polymorphism to collapse near-identical variants into it. Less code is less to read, less to audit, and less to keep true. The limit is comprehension, not line count: a consolidation a peer cannot follow, review, and test is not one.\nAdd no abstraction, dependency, file, or config nobody asked for, and match the idiom of the code you edit. Collapsing duplication you are already touching is in scope; rewriting code the task never reaches is not.\nFix root causes: when a bug sits in a shared function, fix it once there rather than patching the single path the report named. Know the blast radius before you widen it -- changing a shared function, signature, schema, or default changes every caller, so enumerate them first and say what breaks. Prefer the local fix when the shared one would reach code the task never asked you to touch.\nNever trade away input validation at trust boundaries, error handling that prevents data loss, security, or anything explicitly requested. When two options are the same size, take the edge-case-correct one.\nNon-trivial logic leaves one runnable check behind, in whatever form this repository already uses for tests and with no new framework or fixtures added for it. Trivial changes need none.",
				"",
				"Before reporting work as done, exercise the path you changed and read the diff you actually produced. A successful build, a clean type check, and your own summary are not evidence that behaviour is correct. When running the real path is destructive or unavailable, state plainly what you did and did not verify. When a check fails unexpectedly, question your observation method once, then trust the failure.",
				"",
				"Working directory: /repo",
				"Recursive agent depth: 0",
				`REPL runtime — Bun, not Node (\`%%bash\` cells included): package and script commands are \`bun\`/\`bunx\`, never \`npm\`/\`npx\`/\`node\`. Available in every cell with no install step:\n${DEFAULT_RLM_RUNTIME_LABELS.map((label) => `- ${label}`).join("\n")}`,
				"",

				'Your training has a cutoff; this session does not. Never assert today\'s date, the current version of anything, recent events, or that a library still behaves as you remember — check with `websearch` instead. Treat "current", "latest" and "today" in a task as instructions to look, not to recall. Low confidence is itself a reason to search: one search costs less than one confident wrong answer.',
				"",
				"The `repl` tool is a persistent JavaScript/TypeScript REPL (Bun): a long-lived control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction.",
				"All scripting, computing, data wrangling, and one-off parsing happens in this JS REPL - never assume `python3` or any other interpreter exists on the host; do not shell out to Python for tasks the REPL does natively (JSON/regex/text processing, stats, file inspection). Shell out only for real binaries the task needs.",
				"",
				"Do not assume the REPL is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use the REPL to coordinate the process and analyze what comes back.",
				"",
				"When running shell commands, use `%%bash` cells. If you use `%%bash`, it must be the first line of the code cell: no comments, spaces, blank lines, or statements before it. Cell bodies are otherwise plain JavaScript/TypeScript; top-level `await` is supported and the last expression is echoed as the cell result.",
				"",
				"Important: do not install dependencies into the REPL just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface (its documented commands, `bun run ...`, `uv run ...`, the project's own interpreter, from the repo root). Treat failures from that native environment as the relevant result.",
				"",
				"Read and write files with the synchronous globals `read` and `write` — no `await` needed. `const head = read('pkg/file.ts', { from: 1, to: 80 })` returns that 1-based inclusive line slice as raw text, so slice a large file instead of pulling all of it into context; `write('out/report.md', text)` creates parent directories, replaces atomically, and returns `{ path, bytes }`. Use `read` to consume content as a value and `edit.src` when the next step is an edit. Assign read and search results to named variables so you can slice, filter, and act on them without re-reading. For plain reads and writes of whole files, prefer the `read_file` and `write_file` tools instead: they are visible in the TUI and writes render reviewable diffs. Keep the `read`/`write` globals for computed or generated content and batch operations.",
				"",
				"Each `%%bash` cell runs in a throw-away subshell, so shell-level state (`cd`, `export`, `source`, shell variables) does NOT carry to later cells. Keep dependent shell steps inside one `%%bash` cell when they need shared shell state, or use REPL-level equivalents that survive across calls: `cd('<dir>')` for the working directory and `env.VAR = '...'` for environment variables — these apply to all subsequent `%%bash` calls and to file paths resolved in later cells.",
				"",
				"For long-running tasks (builds, downloads, batch jobs), pass an explicit timeout parameter sized to the task instead of relying on defaults; the toolTimeouts.bashSeconds and toolTimeouts.replMs settings set those defaults.",
				"",
				"Inject REPL values into your answer instead of retyping them: `{{repl:name}}` is replaced at send time by that variable's rendered text (a `df` frame's table, a `chart` string). Put it alone on a line inside a fence for block output; inside `code` spans, and anywhere else inside a fence, it stays literal. An unresolvable name becomes a visible `[repl:name unavailable: ...]` marker and is reported back to you.",
				"",
				"REPL state, by contrast, persists across cells: `const`/`let`/`function`/`class` declarations, imports, notes, parsed outputs, and helper data structures all remain available in every later turn. Tool calls are themselves `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
				"",
				"Load extra modules with `await import('<specifier>')` (node builtins, project files by path, and installed packages), but prefer a Bun API where one exists — `Bun.spawn` over `child_process`, `Bun.file` over `fs` reads, `$` over shelling out for a simple pipeline — because the Bun namespace is already loaded and needs no import.",
				"",
				"Continual harness state is available as `rlm.harness` and `rlm.get_harness_state()`. Memory contents are never injected into the system prompt: search persisted facts on demand with `await rlm.harness.search_memory({ query, top_k?, scope? })` and read one in full with `await rlm.harness.get_memory({ id, scope? })`. CRUD calls are local to this Optimus Prime session by default: `rlm.harness.create_memory(...)`, `rlm.harness.update_memory(...)`, `rlm.harness.delete_memory(...)`, `rlm.harness.create_skill(...)`, `rlm.harness.update_skill(...)`, `rlm.harness.delete_skill(...)`, `rlm.harness.create_subagent(...)`, `rlm.harness.update_subagent(...)`, `rlm.harness.delete_subagent(...)`, `rlm.harness.create_prompt_note(...)`, `rlm.harness.update_prompt_note(...)`, `rlm.harness.delete_prompt_note(...)`, plus `rlm.harness.record_refinement(...)` and `rlm.harness.overview()`. Pass `{ global: true }` only for stable cross-session lessons.",
				"",
				"Terminology: continual harness names the persisted prompt, memory, skill, and subagent layer; RLM names the runtime, REPL, and native call interface exposed to the model.",
				"",
				"Reasoning effort is adjustable at runtime: `await rlm.set_effort('<level>')` applies to your next turn, `await rlm.get_effort()` reports the level in force and the levels this model supports, and `await rlm('sub-task', { effort: '<level>' })` sets a child's level instead of inheriting yours; unsupported levels are clamped and a level the policy will not grant comes back as `effort_refused` with the child left inheriting, raise only after observed failure, and lower once a task proves trivial.",
				"Recursion depth is dynamic too: `await rlm.get_max_depth()` reports the current limit, your depth, and the ceiling; `await rlm.set_max_depth(n)` raises it only after an observed failure and never past the ceiling. A raise rebuilds the system prompt, so set it before spawning a subtree rather than mid-run.",
				"Context budget is dynamic as well: `await rlm.get_context_budget()` reports the effective context budget, compaction trigger point, and the model window; `await rlm.set_context_budget({ maxContextTokens?, compactAtTokens? })` adjusts them for this session only. Values are hard-capped by the model window and the change is refused when dynamic context is disabled.",
				"",
				"RLM-native call contract: installed skills are preloaded bindings in the REPL global scope. Read the matching SKILL.md and call its documented function, such as `await <skill_binding>.<function>(...)`. Continual harness skill entries carry an explicit `reference` and `arguments` contract. Spawn a reusable delegation spec with `await rlm('sub-task')`; admission returns a child handle immediately. Results arrive only through an available messaging capability or files, never as an `rlm()` return value. Do not invent non-native wrappers such as `call_skill(...)` or `run_subagent(...)`.",
				"",
				"Continual harness refinement is a small, evidence-backed update after an observed failure or reusable tactic: a repeated delegation pattern becomes a subagent spec, a repeated procedure a skill, a durable fact or preference a memory, a narrow behavioral policy a prompt addendum. Update the smallest component that fits and validate it on the next action; never rewrite the whole harness.",
				"",
				// Last on purpose: the only per-agent-unique line, kept out of the
				// cacheable prefix so siblings share it.
				"Conversation log: /repo/.pi/sessions/session.jsonl",
			].join("\n"),
		);
	});

	test("states the runtime is Bun rather than Node", () => {
		// Without the negative the model reaches for npm/npx/node and hand-rolls what Bun ships.
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["repl"],
			allowRecursion: false,
		});
		expect(prompt).toContain("Bun, not Node");
		expect(prompt).toContain("`bun`/`bunx`, never `npm`/`npx`/`node`");
		// `node:` builtins still work; the Bun preference must not read as a prohibition.
		expect(prompt).toContain("Load extra modules with `await import('<specifier>')` (node builtins");
	});

	test("keeps the per-agent conversation log out of the cacheable prefix", () => {
		// Siblings spawned from one parent differ only by their session file. If that
		// path appears anywhere but the tail, it splits the shared prefix and every
		// sibling pays a full cache write instead of a read.
		const base = {
			cwd: "/repo",
			installedSkills: ["websearch", "refine"],
			activeTools: ["repl"],
			allowRecursion: false,
		};
		const first = buildRlmPrompt({ ...base, messagesPath: "/repo/.pi/sessions/child-a.jsonl" });
		const second = buildRlmPrompt({ ...base, messagesPath: "/repo/.pi/sessions/child-b.jsonl" });

		expect(first).not.toBe(second);

		let shared = 0;
		while (shared < first.length && shared < second.length && first[shared] === second[shared]) {
			shared++;
		}
		// The prompts may only diverge at or after the trailing log line, so
		// everything before it is a byte-identical shared prefix.
		const logStart = first.lastIndexOf("Conversation log:");
		expect(logStart).toBeGreaterThan(0);
		expect(shared).toBeGreaterThanOrEqual(logStart);
		expect(second.slice(0, logStart)).toBe(first.slice(0, logStart));
		// The unique tail is a single short line, not a meaningful slice of the prompt.
		expect(first.length - logStart).toBeLessThan(120);
	});

	test("defaults omitted activeTools to repl guidance", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
		});

		// The names, the summaries and both routes to a full contract live in the
		// <available_skills> roster, emitted once by buildSystemPrompt.
		expect(prompt).not.toContain("Installed skills");
		expect(prompt).not.toContain("Object.keys");
		expect(prompt).toContain("A callable `rlm` is already in your global namespace");
		expect(prompt).toContain("persistent JavaScript/TypeScript REPL (Bun)");
		expect(prompt).toContain("Each `%%bash` cell runs in a throw-away subshell");
	});

	test("discovers requested models through a bounded authenticated host search", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["repl"],
		});

		expect(prompt).toContain("await rlm.find_models(...)");
		expect(prompt).toContain("exact returned selector");
		expect(prompt).toContain("An unavailable requested model fails spawn");
		expect(prompt).toContain("decide whether to retry or omit `model`");
		expect(prompt).not.toContain("model choices for subagents");
	});

	test("only documents repl control guidance when repl is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).not.toContain("The `repl` tool is a persistent JavaScript/TypeScript REPL");
	});

	test("names the skills only when no roster will be rendered", () => {
		// buildSystemPrompt renders <available_skills> whenever the model can read a
		// file, which includes a bash-only session, so the names are not repeated there.
		const withBash = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["bash"],
			allowRecursion: false,
		});
		expect(withBash).not.toContain("Installed skills: `websearch`.");
		// File access is also what makes a roster summary expandable, so the roster owns
		// both the names and the route out of them; nothing about skills is said twice.
		expect(withBash).not.toContain("Object.keys");

		// With no file access there is no roster, so this is the only place they appear.
		const withoutTools = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: [],
			allowRecursion: false,
		});
		expect(withoutTools).toContain("Installed skills: `websearch`. Read their SKILL.md files for usage.");
	});

	test("gates agent messaging and observation doctrine on installed skills", () => {
		const withoutCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["repl"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withoutCapabilities).not.toContain("agent_message.send");
		expect(withoutCapabilities).not.toContain("agent_message.list_agents");
		expect(withoutCapabilities).not.toContain("agent_observe");

		const systemPromptWithoutCapabilities = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});
		expect(systemPromptWithoutCapabilities).not.toContain("agent_message.send");
		expect(systemPromptWithoutCapabilities).not.toContain("agent_observe");

		const withCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message", "agent_observe"],
			activeTools: ["repl"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withCapabilities).toContain("agent_message.send");
		expect(withCapabilities).toContain("agent_message.list_agents");
		expect(withCapabilities).toContain("agent_observe");
		expect(withCapabilities).toContain("restricted to your parent, siblings, and direct children");
	});

	test("does not prescribe kernel-only child replies without repl", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message"],
			activeTools: ["bash"],
			depth: 1,
		});

		expect(prompt).toContain("You are a child agent");
		expect(prompt).not.toContain("When a task calls for an answer, reply explicitly with `await agent_message.send");
	});

	test("exposes the automatic child registry independently of observation skills", () => {
		const withoutObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["repl"],
		});
		const withObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["agent_observe"],
			activeTools: ["repl"],
		});

		for (const prompt of [withoutObserve, withObserve]) {
			expect(prompt).toContain("await rlm.list_subagents()");
			expect(prompt).toContain("await rlm.delete_subagent(child)");
			expect(prompt).toContain("recover direct child handles");
			expect(prompt).not.toContain("Write a small disk registry");
		}
	});

	test("documents the %%bash first-line rule when repl is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["repl"],
			allowRecursion: false,
		});

		expect(prompt).toContain("it must be the first line of the code cell");
	});

	test("documents the read/write globals for file work when repl is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["repl"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Read and write files with the synchronous globals `read` and `write`");
		// The division of labour is the part a model gets wrong: `read` yields a value, `edit.src`
		// yields the anchor `edit.patch` needs.
		expect(prompt).toContain("Use `read` to consume content as a value and `edit.src` when the next step is an edit");
		expect(prompt).toContain("Assign read and search results to named variables");
	});

	test("includes the edit skill guidance only when the edit skill is installed", () => {
		const withEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["edit"],
			activeTools: ["repl"],
			allowRecursion: false,
		});

		expect(withEdit).toContain("from inspected slices");
		expect(withEdit).toContain('await edit.src("pkg/file.ts")');
		expect(withEdit).toContain("never shift between hunks in one call");
		// Only the snapshot mechanics belong here. Both call shapes are in the skill's
		// roster entry, which buildSystemPrompt renders alongside this block.
		expect(withEdit).not.toContain('await edit("pkg/file.ts", oldText, newText)');

		const withoutEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["repl"],
			allowRecursion: false,
		});

		expect(withoutEdit).not.toContain("await edit(");
	});
});

describe("buildSystemPrompt", () => {
	test("a custom prompt replaces the built-in guidance, code craft included", () => {
		// Documented contract, not an oversight: customPrompt already drops every other
		// built-in section, so it drops these two the same way.
		const prompt = buildSystemPrompt({
			customPrompt: "You are a narrow tool.",
			cwd: "/repo",
			selectedTools: ["repl"],
		});
		expect(prompt).not.toContain("Before adding code, take the cheapest option");
	});

	test("tells the model that project context outranks the general guidance", () => {
		// The precedence line is how a repository switches a default off -- this repo's
		// own AGENTS.md forbids commands the verification guidance would otherwise invite.
		const prompt = buildSystemPrompt({
			cwd: "/repo",
			selectedTools: ["repl"],
			contextFiles: [{ path: "AGENTS.md", content: "Never run the test suite." }],
		});
		expect(prompt).toContain("Where these conflict with the general guidance above, these win.");
		expect(prompt.indexOf("Before adding code, take the cheapest option")).toBeLessThan(
			prompt.indexOf("Where these conflict with the general guidance above"),
		);
	});

	test("injects compact global harness context and refine guidance by default", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {
					focused_edits: {
						id: "focused_edits",
						kind: "prompt",
						title: "Focused edits",
						content: "Prefer small prompt, memory, skill, or subagent updates over broad rewrites.",
						path: "policy",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				memory: {
					validation: {
						id: "validation",
						kind: "memory",
						title: "Validation",
						content: "Run `npm run check` after Optimus code changes.",
						path: "repo/optimus",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 2,
					},
				},
				skill: {
					review_refinement: {
						id: "review_refinement",
						kind: "skill",
						title: "Review refinement",
						content: "Check requested edit coverage, rollback safety, and validation commands.",
						path: "quality",
						reference: {
							type: "js",
							binding: "review_refinement",
							callable: "run",
							call_pattern: "await review_refinement.run({ task })",
						},
						arguments: {
							task: { type: "string", required: true, description: "Review task to perform." },
						},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				subagent: {
					refinement_reviewer: {
						id: "refinement_reviewer",
						kind: "subagent",
						title: "Refinement reviewer",
						content: "Review proposed harness edits for scope, evidence, and unintended behavior.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [
				{
					id: "refine_1",
					trigger: "Observed validation miss",
					changes: ["create memory:validation"],
					evidence: "manual test",
					outcome: "Future runs should name npm run check.",
					created_at: "2026-06-08T00:00:00.000Z",
				},
			],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [jsSkill("refine"), jsSkill("agent-message"), jsSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Local continual harness entries belong to this Optimus Prime session");
		expect(prompt).toContain("The continual harness entries below are compact summaries, not full descriptions");
		expect(prompt).toContain("Use global continual harness refinement only for stable cross-session lessons");
		expect(prompt).toContain("When to call `await refine.run()`");
		expect(prompt).toContain("Call contract: read each installed JS skill's SKILL.md");
		expect(prompt).toContain("Continual harness skill entries are JS REPL skills");
		expect(prompt).toContain("Spawn a continual harness subagent spec by composing a concise task prompt");
		expect(prompt).toContain("handle = await rlm('sub-task')");
		expect(prompt).toContain("admission returns immediately");
		expect(prompt).toContain("never the child's answer");
		expect(prompt).toContain("receiver_role: 'parent'");
		expect(prompt).toContain("await rlm.list_subagents()");
		expect(prompt).toContain("receiver_role: 'child'");
		expect(prompt).toContain("after a repeated failure");
		expect(prompt).toContain("a reusable tactic emerges");
		expect(prompt).toContain("a repeated delegation role should become a subagent spec");
		expect(prompt).toContain("a repeated procedure should become a skill");
		expect(prompt).toContain("a durable fact/preference should become a memory");
		expect(prompt).toContain("a narrow behavioral policy should become a prompt addendum");
		expect(prompt).toContain("validation shows a continual harness entry is wrong");
		expect(prompt).toContain("[global:focused_edits] Focused edits (policy)");
		expect(prompt).toContain("[global:review_refinement] Review refinement (quality)");
		expect(prompt).toContain("[global:refinement_reviewer] Refinement reviewer (review)");
		expect(prompt).toContain(
			'memory: search on demand with `await rlm.harness.search_memory({ query: "...", top_k: 5 })`',
		);
		expect(prompt).toContain("`await rlm.harness.get_memory({ id, scope })`");
		expect(prompt).toContain(
			"call `await rlm.harness.overview()` to list every saved continual harness entry (id, title, path) -- memories included -- alongside recent refinement events.",
		);
		// Memory bodies must never reach the cached system prompt, and no rendered line may
		// carry a version, a count, or the refinement log: all of them churn the cache.
		expect(prompt).not.toContain("[global:validation]");
		expect(prompt).not.toContain("Run `npm run check`");
		expect(prompt).not.toContain("recent refinements");
		expect(prompt).not.toContain("[refine_1] Observed validation miss");
		expect(prompt).not.toContain("(policy, v1)");
		expect(prompt).not.toContain("memory: 1");
		expect(prompt.indexOf("# Continual Harness State")).toBeGreaterThan(prompt.indexOf("Conversation log:"));
	});

	test("keeps injected harness context compact", () => {
		const longContent = "x".repeat(500);
		const memoryEntries: HarnessState["entries"]["memory"] = {};
		for (let i = 0; i < 8; i++) {
			memoryEntries[`memory_${i}`] = {
				id: `memory_${i}`,
				kind: "memory",
				title: `Memory ${i}`,
				content: longContent,
				path: "overflow",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: "2026-06-08T00:00:00.000Z",
				updated_at: "2026-06-08T00:00:00.000Z",
				version: 1,
			};
		}
		const skillEntries: HarnessState["entries"]["skill"] = {};
		for (let i = 0; i < 8; i++) {
			skillEntries[`skill_${i}`] = {
				id: `skill_${i}`,
				kind: "skill",
				title: `Skill ${i}`,
				content: longContent,
				path: "overflow",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: "2026-06-08T00:00:00.000Z",
				updated_at: "2026-06-08T00:00:00.000Z",
				version: 1,
			};
		}
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: memoryEntries,
				skill: skillEntries,
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("- +2 more skill entries");
		expect(prompt).toContain(`[global:skill_0] Skill 0 (overflow): ${"x".repeat(177)}...`);
		expect(prompt).not.toContain(longContent);
		expect(prompt).not.toContain("memory: 8");
		expect(prompt).not.toContain("[global:memory_0]");
		expect(prompt).not.toContain("more memory entries");
	});

	test("describes memory as unreachable when repl is inactive", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					validation: harnessEntry("memory", "validation", "Validation", "repo/optimus", "Run bun run check."),
				},
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain(
			"memory: not reachable in this session (no `repl` tool); memory contents are never injected into this prompt.",
		);
		expect(prompt).toContain("Refinement history is not injected.");
		expect(prompt).not.toContain("rlm.harness.search_memory");
		expect(prompt).not.toContain("rlm.harness.get_memory");
		expect(prompt).not.toContain("Run bun run check.");
	});

	test("harness writes do not change the cacheable system prompt", () => {
		const before: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					validation: harnessEntry("memory", "validation", "Validation", "repo/optimus", "Run bun run check."),
				},
				skill: {
					review: harnessEntry("skill", "review", "Review", "quality", "Check rollback safety."),
				},
				subagent: {},
			},
			refinements: [
				{
					id: "refine_1",
					trigger: "Observed validation miss",
					changes: ["create memory:validation"],
					evidence: "manual test",
					outcome: "",
					created_at: "2026-06-08T00:00:00.000Z",
				},
			],
		};
		// An ordinary write: one new memory, a version bump plus a fresh timestamp on an
		// existing skill whose visible fields are unchanged, and one more refinement event.
		const after: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					...before.entries.memory,
					deploys: harnessEntry("memory", "deploys", "Deploys", "repo/ops", "Deploy from main only."),
				},
				skill: {
					review: {
						...before.entries.skill.review,
						version: 7,
						updated_at: "2026-08-19T00:00:00.000Z",
					},
				},
				subagent: {},
			},
			refinements: [
				...before.refinements,
				{
					id: "refine_2",
					trigger: "Recorded a deploy rule",
					changes: ["create memory:deploys"],
					evidence: "user correction",
					outcome: "",
					created_at: "2026-08-19T00:00:00.000Z",
				},
			],
		};

		const build = (harnessState: HarnessState) =>
			buildSystemPrompt({
				selectedTools: ["repl"],
				contextFiles: [],
				skills: [],
				cwd: "/repo",
				harnessState,
			});

		expect(build(after)).toBe(build(before));
	});

	test("uses the model-agnostic rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [jsSkill("refine"), jsSkill("agent-message"), jsSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.pi/sessions/session.jsonl");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("returns immediately after task admission");
		expect(prompt).toContain("Results arrive only through an available messaging capability or files");
		expect(prompt).toContain("recover direct child handles");
		expect(prompt).toContain("kernel restart or compaction");
		expect(prompt).toContain("rlm.list_subagents");
		expect(prompt).toContain("rlm.delete_subagent");
		expect(prompt).toContain("rlm_child_id");
		expect(prompt).toContain("name='api-reviewer'");
		expect(prompt).toContain("session_dir");
		expect(prompt).toContain("agent_observe");
		expect(prompt).toContain("restricted to your parent, siblings, and direct children");
	});

	test("omits repl-only subagent guidance when repl is inactive", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {},
				subagent: {
					worker: {
						id: "worker",
						kind: "subagent",
						title: "Worker",
						content: "Review a self-contained task and report findings.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Installed skills ship no CLI entry points, so never invoke them as shell commands");
		expect(prompt).not.toContain("use installed skills as shell commands");
		expect(prompt).toContain("subagent specs (delegation roles to match a task against):");
		expect(prompt).toContain("[global:worker] Worker (review)");
		expect(prompt).not.toContain("The `repl` tool is a persistent JavaScript/TypeScript REPL");
		expect(prompt).not.toContain("Default to non-blocking subagents");
		expect(prompt).not.toContain("agent_observe.list_agents");
		expect(prompt).not.toContain("await <skill_import>");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("omits shell guidance from harness state when shell is inactive", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {},
				subagent: {
					worker: {
						id: "worker",
						kind: "subagent",
						title: "Worker",
						content: "Review a self-contained task and report findings.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({
			selectedTools: ["edit"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("without the `repl` tool or shell access");
		expect(prompt).not.toContain("use installed skills as shell commands");
		expect(prompt).not.toContain("<skill_import> ...");
		expect(prompt).not.toContain("await <skill_import>");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("custom prompt override bypasses the rlm harness body", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					custom_memory: {
						id: "custom_memory",
						kind: "memory",
						title: "Custom memory",
						content: "Custom prompts still receive harness state.",
						path: "custom",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["repl"],
			appendSystemPrompt: "custom append",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("custom body");
		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain(
			'memory: search on demand with `await rlm.harness.search_memory({ query: "...", top_k: 5 })`',
		);
		expect(prompt).not.toContain("[global:custom_memory]");
		expect(prompt).not.toContain("Custom prompts still receive harness state.");
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(
			prompt.indexOf("# Continual Harness State"),
		);
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(prompt.indexOf("custom append"));
		expect(prompt.indexOf("# Continual Harness State")).toBeLessThan(prompt.indexOf("custom append"));
	});

	test("adds child reply doctrine to custom prompts when messaging is available", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [jsSkill("agent-message")],
			cwd: "/repo",
			rlmDepth: 1,
			rlmParentAgent: "orchestrator",
		});

		expect(prompt).toContain("You are a child agent spawned by orchestrator");
		expect(prompt).toContain('await agent_message.send(message, { receiver_role: "parent" })');
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
	});

	test("gates custom-prompt child reply doctrine on the REPL and agent messaging", () => {
		const build = (selectedTools: string[], skills: Skill[]) =>
			buildSystemPrompt({
				customPrompt: "custom body",
				selectedTools,
				contextFiles: [],
				skills,
				cwd: "/repo",
				rlmDepth: 1,
			});

		expect(build(["repl"], [])).toContain("You are a child agent spawned by your parent agent");
		expect(build(["repl"], [])).not.toContain("agent_message.send");
		expect(build(["bash"], [jsSkill("agent-message")])).not.toContain("agent_message.send");
	});

	test("append system prompt content is included after the rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			appendSystemPrompt: "extra instruction",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt.indexOf("Treat harness refinement as a small, evidence-backed update")).toBeLessThan(
			prompt.indexOf("extra instruction"),
		);
		expect(prompt).not.toContain("Call at most one built-in tool per turn.");
	});

	test("project context files are appended", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## AGENTS.md\n\nproject rules");
	});

	test("markdown skills are included in rlm harness prompts without a REPL binding", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [skill("websearch")],
			cwd: "/repo",
		});

		expect(prompt).not.toContain("Installed skills (preloaded REPL bindings)");
		expect(prompt).toContain("<available_skills>");
		// No binding: a markdown skill is loaded, not called.
		expect(prompt).toContain("- websearch (/skills/websearch/SKILL.md): websearch description");
	});

	test("JS skills are preloaded into the REPL and included in skill metadata", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["repl"],
			contextFiles: [],
			skills: [jsSkill("web-search")],
			cwd: "/repo",
		});

		// The binding is stated once, in the <available_skills> roster.
		expect(prompt).not.toContain("Installed skills (preloaded REPL bindings)");
		expect(prompt).toContain("- web-search [web_search] (/skills/web-search/SKILL.md): web-search description");
		expect(prompt.match(/web_search/g)).toHaveLength(1);
	});

	test("prompt guidelines are appended and deduplicated", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["repl", "dynamic_tool"],
			promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Additional Guidance");
		expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
	});
});
