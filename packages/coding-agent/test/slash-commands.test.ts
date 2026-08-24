import { describe, expect, test } from "bun:test";
import { parseHeartbeatCommand } from "../src/core/cron-jobs.js";
import { parseNewSessionCommand } from "../src/core/new-session-command.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	isSessionSlashCommandName,
	parseLoopCommand,
	parseRefineCommandOptions,
	parseSessionSlashCommand,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
	resolveSlashCommand,
	SESSION_SLASH_COMMAND_NAMES,
} from "../src/core/slash-commands.js";

describe("built-in slash commands", () => {
	test("exposes heartbeat without exposing a cron slash command", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).toContain("heartbeat");
		expect(commandNames).not.toContain("cron");
	});

	test("describes the fine-grained /rlm-max-depth semantics", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rlm-max-depth")).toMatchObject({
			description:
				"Set/view the per-chat persistent RLM max depth immediately; never interrupts or queues the running turn",
			argumentHint: "[<n>|unlimited] [--global]",
			takesArgument: true,
		});
	});

	test("exposes heartbeat syntax guidance that leads with the interrupting default", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "heartbeat")).toMatchObject({
			description:
				"Set or view a persistent heartbeat; by default it interrupts the running turn every 5 minutes, use --follow-up to queue behind it instead; supports pause, resume, stop, and clear",
			argumentHint: "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
			takesArgument: true,
		});
	});

	test("exposes /loop and says plainly that it queues where /heartbeat interrupts", () => {
		const loop = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "loop");

		expect(loop).toMatchObject({
			argumentHint: "<interval> [--steer|--follow-up] <prompt>",
			takesArgument: true,
		});
		expect(loop?.description).toContain("queues behind the running turn");
		expect(loop?.description).toContain("/heartbeat");
	});

	test("exposes /effort for selecting the thinking level", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "effort")).toMatchObject({
			description: "Select how deeply thinking-capable models reason before replying (opens selector UI)",
			argumentHint: "[off|minimal|low|medium|high|xhigh|max]",
			aliases: ["thinking", "reasoning"],
		});
	});

	test("exposes /btw as an argument command with /side as an alias", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "btw")).toMatchObject({
			argumentHint: "<question>",
			aliases: ["side"],
			takesArgument: true,
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "side")).toBeUndefined();
		expect(builtinSlashCommandTakesArgument("side")).toBe(true);
	});

	test("describes /mcp as the MCP Connections menu entry point", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "mcp")).toMatchObject({
			description: "Open MCP Connections or manage MCP integrations",
			argumentHint: "[list|login <name>|logout <name>]",
			takesArgument: true,
		});
	});

	test("marks argument commands as taking a free-form argument", () => {
		for (const [name, argumentHint] of [
			["model", "[search]"],
			["export", "[path|--clipboard]"],
			["import", "<path.jsonl>"],
			["name", "[name]"],
		] as const) {
			expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === name)).toMatchObject({
				argumentHint,
				takesArgument: true,
			});
		}
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "goal")).toMatchObject({
			takesArgument: true,
		});
		expect(builtinSlashCommandTakesArgument("goal")).toBe(true);
		expect(builtinSlashCommandTakesArgument("effort")).toBe(false);
		expect(builtinSlashCommandTakesArgument("thinking")).toBe(false);
		expect(builtinSlashCommandTakesArgument("heartbeat")).toBe(true);
		expect(builtinSlashCommandTakesArgument("mcp")).toBe(true);
		expect(builtinSlashCommandTakesArgument("new")).toBe(true);
		expect(builtinSlashCommandTakesArgument("clear")).toBe(false);
	});
});

describe("slash command aliases", () => {
	test("keeps aliases hidden on canonical command entries", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "clear")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "usage")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rename")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "new")).toMatchObject({
			description: "Start a new session, optionally named and/or with an initial prompt",
			argumentHint: '[--name "session name" --] [prompt]',
			aliases: ["clear"],
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "context")).toMatchObject({
			description: "Show token, cost, and context usage for agent and sub-agents",
			aliases: ["usage", "cost"],
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "name")).toMatchObject({
			description: "Set or show the session display name",
			argumentHint: "[name]",
			takesArgument: true,
			aliases: ["rename"],
		});
	});

	test("resolves /rename to /name through the alias path", () => {
		const parsed = parseSlashCommand("/rename my session");

		expect(isBuiltinSlashCommandName("rename")).toBe(true);
		expect(resolveBuiltinSlashCommandName("rename")).toBe("name");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "name",
			args: "my session",
			originalName: "rename",
			isAlias: true,
		});
	});

	test("resolves /clear to /new through the alias path", () => {
		const parsed = parseSlashCommand("/clear");

		expect(parsed).toEqual({ name: "clear", args: "" });
		expect(parseSlashCommand("/new\n  multiline prompt")).toEqual({ name: "new", args: "multiline prompt" });
		expect(isBuiltinSlashCommandName("clear")).toBe(true);
		expect(resolveBuiltinSlashCommandName("clear")).toBe("new");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "new",
			args: "",
			originalName: "clear",
			isAlias: true,
		});
		expect(parseNewSessionCommand(" write a\n  multiline prompt  ")).toEqual({
			prompt: "write a\n  multiline prompt  ",
		});
		expect(parseNewSessionCommand(" --name stable")).toEqual({ name: "stable" });
		expect(parseNewSessionCommand(' --name "stable name" --  \n  --keep\nformat  ')).toEqual({
			name: "stable name",
			prompt: "  --keep\nformat  ",
		});
		expect(() => parseNewSessionCommand(" --name")).toThrow("Missing value");
		expect(() => parseNewSessionCommand(' --name "one" --name "two"')).toThrow("Duplicate");
		expect(() => parseNewSessionCommand(" --other value")).toThrow("Unknown /new option");
		expect(() => parseNewSessionCommand(' --name "broken')).toThrow("Unterminated quote");
	});

	test("resolves /thinking to /effort through the alias path", () => {
		const parsed = parseSlashCommand("/thinking");

		expect(isBuiltinSlashCommandName("thinking")).toBe(true);
		expect(resolveBuiltinSlashCommandName("thinking")).toBe("effort");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "effort",
			args: "",
			originalName: "thinking",
			isAlias: true,
		});
	});

	test("preserves arguments when resolving aliases", () => {
		const parsed = parseSlashCommand("/usage latest turn");

		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "context",
			args: "latest turn",
			originalName: "usage",
			isAlias: true,
		});
	});

	test("resolves /side to /btw", () => {
		const parsed = parseSlashCommand("/side Is this cached?");

		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "btw",
			args: "Is this cached?",
			originalName: "side",
			isAlias: true,
		});
	});
});

describe("session slash commands", () => {
	test("keeps the authoritative names and built-in execution metadata in sync", () => {
		expect(
			BUILTIN_SLASH_COMMANDS.filter((command) => command.execution === "session").map((command) => command.name),
		).toEqual([...SESSION_SLASH_COMMAND_NAMES]);
		for (const name of SESSION_SLASH_COMMAND_NAMES) expect(isSessionSlashCommandName(name)).toBe(true);
		expect(isSessionSlashCommandName("settings")).toBe(false);
	});

	test("splits at the first horizontal Unicode whitespace and preserves the raw text", () => {
		for (const text of ["/goal ship it", "/goal\tship it", "/goal\u00a0ship it", "/goal\u2003ship it"]) {
			expect(parseSlashCommand(text)).toEqual({ name: "goal", args: "ship it" });
			expect(parseSessionSlashCommand(text)).toEqual({ name: "goal", args: "ship it", text });
		}
		expect(parseSlashCommand("/goal\t  ship it  ")).toEqual({ name: "goal", args: "ship it" });
		for (const lineTerminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
			expect(parseSessionSlashCommand(`/goal${lineTerminator}ship it`)).toBeUndefined();
			expect(parseSessionSlashCommand(`/goal\t${lineTerminator}ship it`)).toBeUndefined();
			expect(parseSessionSlashCommand(`/autonomous\t${lineTerminator}on`)).toBeUndefined();
		}
	});

	test("parses refine rollback ids and --global placement without consuming instruction text", () => {
		expect(parseRefineCommandOptions("rollback refine_123")).toEqual({ rollbackId: "refine_123", global: false });
		expect(parseRefineCommandOptions("rollback refine_456 --global")).toEqual({
			rollbackId: "refine_456",
			global: true,
		});
		expect(parseRefineCommandOptions("--global rollback refine_789")).toEqual({
			rollbackId: "refine_789",
			global: true,
		});
		expect(parseRefineCommandOptions("--global focus on validation")).toEqual({
			instructions: "focus on validation",
			global: true,
		});
		expect(parseRefineCommandOptions("update docs to explain --global")).toEqual({
			instructions: "update docs to explain --global",
			global: false,
		});
		for (const args of ["rollback", "rollback --global"]) {
			expect(() => parseRefineCommandOptions(args)).toThrow("Usage: /refine rollback <refinement-id>");
		}
	});

	test("classifies only exact leading session-owned commands", () => {
		expect(parseSessionSlashCommand("/compact focus on tests")).toEqual({
			name: "compact",
			args: "focus on tests",
			text: "/compact focus on tests",
		});
		expect(parseSessionSlashCommand("/refine")).toEqual({ name: "refine", args: "", text: "/refine" });
		expect(parseSessionSlashCommand("/goal ship it")).toEqual({
			name: "goal",
			args: "ship it",
			text: "/goal ship it",
		});
		expect(parseSessionSlashCommand("/autonomous status")).toEqual({
			name: "autonomous",
			args: "status",
			text: "/autonomous status",
		});
		expect(parseSessionSlashCommand("/rlm-max-depth 3 --global")).toBeUndefined();
		expect(parseSessionSlashCommand("Explain /compact")).toBeUndefined();
		expect(parseSessionSlashCommand(" /compact")).toBeUndefined();
		expect(parseSessionSlashCommand("/compaction")).toBeUndefined();
		expect(parseSessionSlashCommand("/settings")).toBeUndefined();
	});
});

describe("parseLoopCommand", () => {
	const now = new Date("2026-01-01T12:00:00.000Z");

	test("accepts every documented interval form and normalizes it like /heartbeat", () => {
		for (const [input, schedule] of [
			["/loop 30s tail the logs", "every 30s"],
			["/loop 5m check the deploy", "every 5m"],
			["/loop 2h sweep stale branches", "every 2h"],
			["/loop every 10m check status", "every 10m"],
			["/loop each 10 minutes check status", "every 10 minutes"],
			["/loop @hourly check status", "@hourly"],
			['/loop "*/5 * * * *" check status', "*/5 * * * *"],
		] as const) {
			expect(parseLoopCommand(input, now)).toMatchObject({ type: "set", schedule });
		}
	});

	test("defaults to follow_up so a loop queues behind the running turn", () => {
		expect(parseLoopCommand("/loop 5m check the deploy", now)).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check the deploy",
			deliveryMode: "follow_up",
		});
	});

	test("still honours an explicit delivery flag on either side of the prompt", () => {
		expect(parseLoopCommand("/loop 5m --steer check the deploy", now)).toMatchObject({ deliveryMode: "steer" });
		expect(parseLoopCommand("/loop 5m check the deploy --steer", now)).toMatchObject({ deliveryMode: "steer" });
		expect(parseLoopCommand("/loop 5m --follow-up check the deploy", now)).toMatchObject({
			deliveryMode: "follow_up",
		});
	});

	test("produces the same job shape /heartbeat does, apart from the delivery default", () => {
		const loop = parseLoopCommand("/loop 10m check status", now);
		const heartbeat = parseHeartbeatCommand("/heartbeat every 10m check status");

		expect(loop).toEqual({ ...heartbeat, deliveryMode: "follow_up" });
		expect(parseLoopCommand("/loop 10m --steer check status", now)).toEqual(
			parseHeartbeatCommand("/heartbeat every 10m --steer check status"),
		);
	});

	test("loops a prompt that happens to be a heartbeat subcommand word", () => {
		expect(parseLoopCommand("/loop 30s status", now)).toMatchObject({ type: "set", instruction: "status" });
	});

	test("rejects a missing interval with the interval grammar rather than inventing one", () => {
		for (const input of ["/loop", "/loop check the deploy", "/loop   "]) {
			expect(() => parseLoopCommand(input, now)).toThrow("Usage: /loop <interval>");
		}
		expect(() => parseLoopCommand("/loop check the deploy", now)).toThrow("minimum 10s");
	});

	test("rejects an interval with no prompt", () => {
		expect(() => parseLoopCommand("/loop 5m", now)).toThrow("Usage: /loop <interval>");
	});

	test("rejects invalid intervals instead of folding them into the prompt", () => {
		expect(() => parseLoopCommand("/loop 5x do the thing", now)).toThrow('Invalid loop interval "5x"');
		expect(() => parseLoopCommand("/loop 5s do the thing", now)).toThrow('Invalid loop interval "5s"');
		expect(() => parseLoopCommand('/loop "* * *" do the thing', now)).toThrow('Invalid loop interval "* * *"');
	});
});
