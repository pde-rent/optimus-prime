import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/core/agent-session.js";
import { BunReplManager, expandInjectionRefs, scanInjectionRefs } from "../src/core/bun-repl/index.js";
import type { BunReplResolvedRef } from "../src/core/bun-repl/protocol.js";

// The scanner and splicer are pure; everything below the first describe drives a real
// `bun` child so the resolution path (host request -> child namespace -> rendered text)
// is exercised end to end, the way the model will actually use it.

const SKILLS_DIR = resolve(__dirname, "..", "skills");

function expandWith(text: string, values: Record<string, BunReplResolvedRef>, budget?: number) {
	const sites = scanInjectionRefs(text);
	const resolved = new Map(Object.entries(values));
	return expandInjectionRefs(text, sites, resolved, budget);
}

describe("injection reference syntax", () => {
	it("substitutes several references in one message", () => {
		const out = expandWith("rows: {{repl:table}}\n\nshape: {{repl:plot}} and again {{repl:table}}", {
			table: { name: "table", text: "TBL" },
			plot: { name: "plot", text: "PLOT" },
		});
		expect(out.text).toBe("rows: TBL\n\nshape: PLOT and again TBL");
		expect(out.injected).toEqual(["table", "plot", "table"]);
		expect(out.failed).toEqual([]);
	});

	it("leaves the syntax inside a code fence and an inline code span untouched", () => {
		const text = [
			"Write `{{repl:name}}` in your answer.",
			"",
			"```ts",
			'const template = "{{repl:name}}";',
			"```",
			"",
			"Result: {{repl:name}}",
		].join("\n");
		const out = expandWith(text, { name: { name: "name", text: "VALUE" } });

		expect(out.text).toContain("Write `{{repl:name}}` in your answer.");
		expect(out.text).toContain('const template = "{{repl:name}}";');
		expect(out.text).toContain("Result: VALUE");
		expect(out.injected).toEqual(["name"]);
	});

	it("substitutes a reference that is the whole line inside a fence, so a chart can be a code block", () => {
		const out = expandWith("```\n{{repl:plot}}\n```", { plot: { name: "plot", text: "▁▃▅█" } });
		expect(out.text).toBe("```\n▁▃▅█\n```");
	});

	it("does not treat an unterminated backtick run as a code span", () => {
		const out = expandWith("a ` b {{repl:x}}", { x: { name: "x", text: "V" } });
		expect(out.text).toBe("a ` b V");
	});

	it("marks an unresolved reference visibly instead of dropping it", () => {
		const out = expandWith("here: {{repl:gone}}", { gone: { name: "gone", error: "is not defined" } });
		expect(out.text).toBe("here: [repl:gone unavailable: is not defined]");
		expect(out.failed).toEqual([{ name: "gone", reason: "is not defined" }]);
	});

	it("fails a reference that would blow the per-message budget", () => {
		const out = expandWith("{{repl:big}}", { big: { name: "big", text: "x".repeat(200) } }, 100);
		expect(out.text).toContain("[repl:big unavailable: is 200 chars, over the 100 left");
		expect(out.injected).toEqual([]);
	});

	it("ignores text with no reference at all", () => {
		expect(scanInjectionRefs("plain {{name}} and {{ repl }} prose")).toEqual([]);
	});

	it("explains a malformed reference rather than leaving raw syntax in the answer", () => {
		const out = expandWith("see {{repl:rows[0].table}}", {});
		expect(out.text).toContain("[repl:rows[0].table unavailable: is not a plain variable name");
		expect(out.failed).toHaveLength(1);
	});
});

describe("resolving references against a live REPL", () => {
	let tempDir = "";
	let manager: BunReplManager;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-inject-"));
		manager = new BunReplManager({
			bunPath: "bun",
			cwd: tempDir,
			env: {
				OPTIMUS_REPL_SKILLS: JSON.stringify([
					{ name: "df", global: "df", entry: join(SKILLS_DIR, "df", "skill.js") },
					{ name: "chart", global: "chart", entry: join(SKILLS_DIR, "chart", "skill.js") },
				]),
			},
		});
		await manager.start();
	});

	afterEach(async () => {
		await manager.dispose().catch(() => {});
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("renders a non-string value through its own toString", async () => {
		await manager.execute("const frame = df([{ chain: 'Ethereum', tvl: 46 }, { chain: 'Solana', tvl: 5.1 }]);");
		const refs = await manager.resolveInjectionRefs(["frame"], 5000);
		expect(refs?.[0]?.text).toContain("Ethereum");
		expect(refs?.[0]?.text).not.toContain("[object Object]");
	});

	it("renders a plain object as JSON rather than [object Object]", async () => {
		await manager.execute("const cfg = { a: 1 };");
		expect((await manager.resolveInjectionRefs(["cfg"], 5000))?.[0]?.text).toBe('{\n  "a": 1\n}');
	});

	it("reports an unknown name, a declared-but-unset name, and a null", async () => {
		await manager.execute("const pending = undefined; const nothing = null;");
		const refs = await manager.resolveInjectionRefs(["missing", "pending", "nothing"], 5000);
		expect(refs?.[0]?.error).toContain("not a variable you defined");
		expect(refs?.[1]?.error).toContain("holds no value yet");
		expect(refs?.[2]?.error).toContain("is null");
		expect(refs?.every((r) => r.text === undefined)).toBe(true);
	});

	it("refuses a value over the size cap instead of truncating it", async () => {
		await manager.execute("const huge = 'x'.repeat(40000);");
		const ref = (await manager.resolveInjectionRefs(["huge"], 5000))?.[0];
		expect(ref?.text).toBeUndefined();
		expect(ref?.error).toContain("over the 32768-char injection limit");
	});

	it("refuses a host-injected binding, so a reference cannot dump an internal", async () => {
		expect((await manager.resolveInjectionRefs(["df"], 5000))?.[0]?.error).toContain("not a variable you defined");
	});
});

// The message object mutated here is the one agent-core holds, the TUI renders, and
// SessionManager persists, so asserting on it is asserting on what the user sees.
describe("assistant message expansion", () => {
	let tempDir = "";
	let manager: BunReplManager;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-inject-msg-"));
		manager = new BunReplManager({
			bunPath: "bun",
			cwd: tempDir,
			env: {
				OPTIMUS_REPL_SKILLS: JSON.stringify([
					{ name: "df", global: "df", entry: join(SKILLS_DIR, "df", "skill.js") },
					{ name: "chart", global: "chart", entry: join(SKILLS_DIR, "chart", "skill.js") },
				]),
			},
		});
		await manager.start();
	});

	afterEach(async () => {
		await manager.dispose().catch(() => {});
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	async function expandMessage(text: string) {
		const message = { role: "assistant" as const, content: [{ type: "text" as const, text }] };
		const notices: Array<{ content: string }> = [];
		const stub = {
			_replKernelProvisioner: { manager },
			sendCustomMessage: async (m: { content: string }) => void notices.push(m),
		};
		await (
			AgentSession.prototype as unknown as {
				_expandReplReferences(this: unknown, message: unknown): Promise<void>;
			}
		)._expandReplReferences.call(stub, message);
		return { text: message.content[0].text, notices };
	}

	it("expands a table and a chart the model referenced instead of retyped", async () => {
		await manager.execute(
			"const table = df([{ chain: 'Ethereum', tvl: 46 }, { chain: 'Solana', tvl: 5.1 }]);\n" +
				"const plot = chart.spark([1, 3, 2, 8, 5]);",
		);
		const { text, notices } = await expandMessage("Top chains:\n\n```\n{{repl:table}}\n```\n\nTrend: {{repl:plot}}");

		expect(text).toContain("Ethereum");
		expect(text).toContain("Solana");
		expect(text).not.toContain("{{repl:");
		expect(notices).toEqual([]);
	});

	it("shows the user a marker and tells the model when a name does not resolve", async () => {
		const { text, notices } = await expandMessage("Chart:\n\n{{repl:missingChart}}");

		expect(text).toContain("[repl:missingChart unavailable:");
		expect(notices).toHaveLength(1);
		expect(notices[0]?.content).toContain("<repl_injection_failed>");
		expect(notices[0]?.content).toContain("missingChart");
		expect(notices[0]?.content).toContain("do not retype the content by hand");
	});
});
