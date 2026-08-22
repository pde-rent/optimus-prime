import { describe, expect, it } from "bun:test";
import { createBashTool } from "../src/core/tools/bash.js";
import { buildBashDigest } from "../src/core/tools/bash-digest.js";

describe("buildBashDigest", () => {
	it("returns null for unrecognized commands", () => {
		expect(
			buildBashDigest({
				command: "ls -la",
				outputHead: "",
				outputTail: "total 0",
				totalLines: 1,
				totalBytes: 8,
				exitCode: 0,
			}),
		).toBeNull();
	});

	it("parses npm install package counts", () => {
		const digest = buildBashDigest({
			command: "npm install express",
			outputHead: "",
			outputTail: "added 87 packages, removed 3 packages, changed 2 packages, and audited 90 packages in 4s",
			totalLines: 3000,
			totalBytes: 120_000,
			exitCode: 0,
		});
		expect(digest).toContain("added 87");
		expect(digest).toContain("removed 3");
		expect(digest).toContain("changed 2");
		expect(digest).toContain("audited 90");
		expect(digest).toContain("exit=0");
		expect(digest).toContain("3000 lines");
	});

	it("parses bun install counts", () => {
		const digest = buildBashDigest({
			command: "bun install",
			outputHead: "",
			outputTail: "42 packages installed [462.00ms]",
			totalLines: 5000,
			totalBytes: 200_000,
			exitCode: 0,
		});
		expect(digest).toContain("added 42");
	});

	it("parses git status branch state and entry counts", () => {
		const head = [
			"On branch feat/token-hygiene",
			"Your branch is ahead of 'origin/main' by 2 commits.",
			"Changes to be committed:",
			"\tmodified:   a.ts",
			"\tnew file:   b.ts",
			"",
			"Changes not staged for commit:",
			"\tmodified:   c.ts",
			"\tdeleted:    d.ts",
			"",
			"Untracked files:",
			"\te.ts",
			"\tf.ts",
			"\tg.ts",
			"",
		].join("\n");
		const digest = buildBashDigest({
			command: "git status",
			outputHead: head,
			outputTail: "nothing added to commit but untracked files present",
			totalLines: 4000,
			totalBytes: 160_000,
			exitCode: 0,
		});
		expect(digest).toContain("branch=feat/token-hygiene");
		expect(digest).toContain("ahead of 'origin/main' by 2 commits".toLowerCase());
		expect(digest).toContain("staged=2");
		expect(digest).toContain("unstaged=2");
		expect(digest).toContain("untracked=3");
	});

	it("parses kubectl describe identity fields", () => {
		const tail = [
			"Name:         btr-keeper-7d9f",
			"Namespace:    prod",
			"Reason:       CrashLoopBackOff",
			"Events:",
			"  Type     Reason            Age                  Message",
			"  ----     ------            ----                 -------",
			"  Normal   Scheduled         12m                  Assigned",
			"  Warning  BackOff           4m                   Back-off restarting",
		].join("\n");
		const digest = buildBashDigest({
			command: "kubectl describe pod btr-keeper-7d9f",
			outputHead: "",
			outputTail: tail,
			totalLines: 2500,
			totalBytes: 90_000,
			exitCode: 0,
		});
		expect(digest).toContain("name=btr-keeper-7d9f");
		expect(digest).toContain("ns=prod");
		expect(digest).toContain("reason=CrashLoopBackOff");
		expect(digest).toContain("events=2");
	});
});

describe("bash tool digest integration", () => {
	it("prepends a digest when a noisy command's output is truncated", async () => {
		const bigOutput = `${"x".repeat(80)}\n`.repeat(1500);
		const tool = createBashTool("/tmp", {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(bigOutput, "utf-8"));
					return { exitCode: 0 };
				},
			},
			spawnHook: (context) => ({ ...context, command: "npm install left-pad" }),
		});
		const result = await tool.execute("call-digest", { command: "install-it" });
		const text =
			(result.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text ??
			"";
		expect(text.startsWith("[digest]")).toBe(true);
		expect(text).toContain("exit=0");
		expect(text).toContain("[Showing lines");
	});

	it("does not prepend a digest for non-noisy commands", async () => {
		const bigOutput = `${"y".repeat(80)}\n`.repeat(1500);
		const tool = createBashTool("/tmp", {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(bigOutput, "utf-8"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("call-nodigest", { command: "cat big.log" });
		const text =
			(result.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text ??
			"";
		expect(text.startsWith("[digest]")).toBe(false);
	});
});
