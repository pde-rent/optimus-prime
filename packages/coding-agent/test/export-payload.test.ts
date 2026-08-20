import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportFromFile,
	exportSessionToHtml,
	NEVER_PRE_RENDERED_TOOLS,
	type ToolHtmlRenderer,
} from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createAllToolDefinitions } from "../src/core/tools/index.js";

interface ExportedEntry {
	type: string;
	id: string;
	parentId: string | null;
}

function readSessionData(htmlPath: string): {
	entries: ExportedEntry[];
	leafId: string | null;
	renderedTools?: Record<string, unknown>;
} {
	const html = readFileSync(htmlPath, "utf-8");
	const match = html.match(/<script id="session-data" type="application\/json">([^<]*)<\/script>/);
	if (!match) throw new Error("No session-data script in export");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "export-payload-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function entry(id: string, parentId: string | null, body: Record<string, unknown>): string {
	return JSON.stringify({ id, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...body });
}

function userMessage(id: string, parentId: string | null, text: string): string {
	return entry(id, parentId, { type: "message", message: { role: "user", content: text } });
}

function writeSession(dir: string, lines: string[]): string {
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
			...lines,
		].join("\n"),
		"utf-8",
	);
	return file;
}

describe("HTML export payload", () => {
	it("exports only the leaf branch, not abandoned ones", async () => {
		await withTempDir(async (dir) => {
			const file = writeSession(dir, [
				userMessage("a", null, "root"),
				userMessage("b", "a", "abandoned"),
				userMessage("c", "a", "kept"),
			]);
			const out = join(dir, "out.html");
			await exportFromFile(file, out);

			const data = readSessionData(out);
			expect(data.entries.map((e) => e.id)).toEqual(["a", "c"]);
			expect(data.leafId).toBe("c");
		});
	});

	it("drops bookkeeping entries and re-chains parentIds across the hole", async () => {
		await withTempDir(async (dir) => {
			const file = writeSession(dir, [
				userMessage("a", null, "one"),
				entry("b", "a", { type: "child_usage_attributed", targetId: "a", childUsage: {}, aggregateUsage: {} }),
				entry("c", "b", { type: "agent_status", status: { summary: "x", basedOnMessageCount: 1 } }),
				entry("d", "c", { type: "git_state", git: { branch: "main" } }),
				entry("e", "d", { type: "session_state", state: { status: "active" } }),
				userMessage("f", "e", "two"),
			]);
			const out = join(dir, "out.html");
			await exportFromFile(file, out);

			const data = readSessionData(out);
			expect(data.entries.map((e) => e.id)).toEqual(["a", "f"]);
			// template.js walks parentId to rebuild the path; a dangling id truncates it.
			expect(data.entries.map((e) => e.parentId)).toEqual([null, "a"]);
			expect(data.leafId).toBe("f");
		});
	});

	it("keeps entry types the template renders", async () => {
		await withTempDir(async (dir) => {
			const file = writeSession(dir, [
				userMessage("a", null, "one"),
				entry("b", "a", { type: "model_change", provider: "p", modelId: "m" }),
				entry("c", "b", { type: "compaction", summary: "s", firstKeptEntryId: "a", tokensBefore: 1 }),
				entry("d", "c", { type: "custom_message", customType: "note", content: "hi", display: true }),
				entry("e", "d", { type: "label", targetId: "a", label: "start" }),
			]);
			const out = join(dir, "out.html");
			await exportFromFile(file, out);

			expect(readSessionData(out).entries.map((e) => e.type)).toEqual([
				"message",
				"model_change",
				"compaction",
				"custom_message",
				"label",
			]);
		});
	});

	it("pre-renders extension tools only, never repl or the other built-ins", async () => {
		await withTempDir(async (dir) => {
			const calls = [
				{ id: "call-repl", name: "repl", arguments: { code: "1" } },
				{ id: "call-bash", name: "bash", arguments: { command: "ls" } },
				{ id: "call-ext", name: "weather", arguments: { city: "oslo" } },
			];
			const file = writeSession(dir, [
				entry("a", null, {
					type: "message",
					message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", ...c })) },
				}),
				...calls.map((call, index) =>
					entry(`r${index}`, index === 0 ? "a" : `r${index - 1}`, {
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "out" }],
							isError: false,
						},
					}),
				),
			]);

			// Renders whatever it is handed, so anything pre-rendered shows up in the payload.
			const toolRenderer: ToolHtmlRenderer = {
				renderCall: (_id, name) => `call:${name}`,
				renderResult: (_id, name) => ({ collapsed: `c:${name}`, expanded: `e:${name}` }),
			};
			const out = join(dir, "out.html");
			await exportSessionToHtml(SessionManager.open(file), undefined, { outputPath: out, toolRenderer });

			expect(Object.keys(readSessionData(out).renderedTools ?? {})).toEqual(["call-ext"]);
		});
	});

	it("skips every tool template.js or the built-in registry already draws", () => {
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		const start = templateJs.indexOf("function renderToolCall(");
		const end = templateJs.indexOf("window.downloadSessionJson", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);

		const templateTools = [...templateJs.slice(start, end).matchAll(/^\s+case '([a-z_]+)':/gm)].map((m) => m[1]);
		expect(templateTools).toContain("bash");

		// The skip list restates knowledge that lives in template.js and core/tools; pin both.
		for (const name of [...templateTools, ...Object.keys(createAllToolDefinitions(process.cwd()))]) {
			expect(NEVER_PRE_RENDERED_TOOLS.has(name)).toBe(true);
		}
	});
});
