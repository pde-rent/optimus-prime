import { beforeEach, describe, expect, it } from "bun:test";
import { type BashOperations, createBashTool, resetNativeCommandHints } from "../src/core/tools/bash.js";
import { getTextOutput } from "./helpers/render.js";

const stubOperations: BashOperations = {
	exec: async (_command, _cwd, { onData }) => {
		onData(Buffer.from("stub output\n", "utf-8"));
		return { exitCode: 0 };
	},
};

const bash = createBashTool(process.cwd(), { operations: stubOperations });

async function run(command: string): Promise<string> {
	const result = await bash.execute("test-call", { command });
	return getTextOutput(result);
}

function tipFor(tool: string): RegExp {
	return new RegExp(
		`tip: the ${tool} tool is the default and fastest path for this - in-process, cross-platform; try it next time$`,
	);
}

describe("bash native-tool hints", () => {
	beforeEach(() => {
		resetNativeCommandHints();
	});

	it("hints each mapped command to its native tool", async () => {
		const cases: Array<[string, string]> = [
			["grep foo file.txt", "grep tool"],
			["cat file.txt", "read_file"],
			["echo hi > out.txt", "write_file"],

			["sed 's/a/b/' file.txt", "sed tool"],
			["find . -name '*.ts'", "find tool"],
			["wc -l file.txt", "wc tool"],
			["head -5 file.txt", "head tool"],
			["tail -5 file.txt", "tail tool"],
			["ln -s a b", "ln tool"],
			["ps aux", "sysinfo"],
			["uname -a", "sysinfo"],
			["ss -tlnp", "netdiag"],
			["ifconfig", "netdiag"],
		];
		for (const [command, tool] of cases) {
			const output = await run(command);
			expect(output).toMatch(tipFor(tool));
		}
	});

	it("appends the tip after the output without replacing it", async () => {
		const output = await run("grep foo file.txt");
		const lines = output.split("\n");
		expect(lines[0]).toBe("stub output");
		expect(lines[lines.length - 1]).toMatch(tipFor("grep tool"));
		expect(lines[lines.length - 1].length).toBeLessThan(120);
	});

	it("shows each hint at most once per session", async () => {
		expect(await run("grep foo file.txt")).toMatch(tipFor("grep tool"));
		expect(await run("grep bar other.txt")).not.toMatch(/tip:/);
		expect(await run("grep baz third.txt")).not.toMatch(/tip:/);
	});

	it("never hints piped commands, even when every stage is covered", async () => {
		expect(await run("grep foo file.txt | awk '{print $1}'")).not.toMatch(/tip:/);
		expect(await run("cat file.txt | wc -l")).not.toMatch(/tip:/);
	});

	it("never hints chained commands", async () => {
		expect(await run("cat a.txt && cat b.txt")).not.toMatch(/tip:/);
		expect(await run("grep foo a.txt; grep bar b.txt")).not.toMatch(/tip:/);
		expect(await run("sleep 1 & echo hi > out.txt")).not.toMatch(/tip:/);
	});

	it("never hints uncovered commands", async () => {
		for (const command of ["git status", "curl example.com", "ls -la", "bun test"]) {
			expect(await run(command)).not.toMatch(/tip:/);
		}
	});

	it("hints echo with append redirection too", async () => {
		resetNativeCommandHints();
		expect(await run("echo hi >> out.txt")).toMatch(tipFor("write_file"));
	});
	it("does not hint echo without a redirect to a file", async () => {
		expect(await run("echo hello world")).not.toMatch(/tip:/);
	});
});
