import { describe, expect, it } from "bun:test";
import { previewBashCommand, previewJsCode, previewReplCode } from "../src/core/tools/code-preview.js";

describe("code preview", () => {
	it("skips bash setup and previews the real command", () => {
		expect(previewBashCommand("set -e\nnpm run check")).toEqual({ language: "bash", text: "npm check" });
	});

	it("simplifies common runner wrappers", () => {
		expect(
			previewBashCommand("npx tsx ../../node_modules/vitest/dist/cli.js --run test/code-preview.test.ts"),
		).toEqual({
			language: "bash",
			text: "vitest --run test/code-preview.test.ts",
		});
	});

	it("keeps the JS toolchain readable and leaves other ecosystems verbatim", () => {
		// No per-language branches: an unrecognised runner is shown as typed rather
		// than special-cased, so no ecosystem is privileged over another.
		const preview = (command: string) => previewBashCommand(`set -e\n${command}`)?.text;
		expect(preview("bun run check")).toBe("bun check");
		expect(preview("bunx biome check .")).toBe("bunx biome check .");
		expect(preview("cargo test --release")).toBe("cargo test --release");
		expect(preview("go test ./...")).toBe("go test ./...");
		expect(preview("uv run pytest tests/")).toBe("uv run pytest tests/");
		expect(preview("python3 -m pytest tests")).toBe("python3 -m pytest tests");
	});

	it("unwraps js heredocs in bash", () => {
		const command = `set -e
bun run /dev/stdin <<'JS'
const p = "package.json";
const text = await Bun.file(p).text();
await Bun.write(p, text);
JS`;
		// `p` holds no slash, so it is not treated as a path variable (parity with the
		// upstream analyzer); the write statement itself is still the preview.
		expect(previewBashCommand(command)).toEqual({ language: "js", text: "await Bun.write(p, text)" });
	});

	it("unwraps bash cells in repl", () => {
		const code = `%%bash
set -e
node --input-type=module <<'JS'
const data = new Map(Object.entries({}));
console.log(data.keys());
JS`;
		expect(previewReplCode(code)).toEqual({ language: "js", text: "data.keys()" });
	});

	it("prefers meaningful js effects over setup assignments", () => {
		const code = `import { readFileSync } from "node:fs";
const p = "packages/coding-agent/src/modes/interactive/components/repl-cell.ts";
const txt = await Bun.file(p).text();
await Bun.write(p, txt.replace("old", "new"));`;
		expect(previewJsCode(code)).toEqual({
			language: "js",
			text: "write packages/coding-agent/src/modes/interactive/components/re…",
		});
	});

	it("handles stronger bash heuristics", () => {
		expect(previewBashCommand("cd packages/coding-agent && npm --prefix ../.. run check")).toEqual({
			language: "bash",
			text: "npm check (../..)",
		});
		expect(previewBashCommand("echo setup\ngit add packages/foo.ts")).toEqual({
			language: "bash",
			text: "git add packages/foo.ts",
		});
		expect(previewBashCommand("cat > packages/foo.ts <<'EOF'\nhello\nEOF")).toEqual({
			language: "bash",
			text: "write packages/foo.ts",
		});
	});

	it("extracts js subprocesses and control-block effects", () => {
		const subprocessCode = `const proc = Bun.spawn(["npm", "run", "check"]);
`;
		expect(previewJsCode(subprocessCode)).toEqual({ language: "js", text: "npm check" });

		const controlCode = `import { unlink } from "node:fs/promises";
const p = "packages/foo.ts";
if (await Bun.file(p).exists()) {
	await unlink(p);
}
`;
		expect(previewJsCode(controlCode)).toEqual({ language: "js", text: "delete packages/foo.ts" });
	});

	it("summarises bun shell and child_process commands", () => {
		expect(previewJsCode("await Bun.$`npm run check`;")).toEqual({ language: "js", text: "npm check" });
		expect(previewJsCode('const out = execSync("git add packages/foo.ts");')).toEqual({
			language: "js",
			text: "git add packages/foo.ts",
		});
		expect(previewJsCode('Bun.spawnSync({ cmd: ["git", "commit", "-m", "wip"] });')).toEqual({
			language: "js",
			text: "git commit -m wip",
		});
	});

	it("summarises node fs helpers and dynamic imports", () => {
		expect(previewJsCode('const text = readFileSync("packages/foo.ts", "utf8");')).toEqual({
			language: "js",
			text: "read packages/foo.ts",
		});
		expect(previewJsCode('writeFileSync("packages/foo.ts", body);')).toEqual({
			language: "js",
			text: "write packages/foo.ts",
		});
		expect(previewJsCode('await writeFile("packages/foo.ts", body);')).toEqual({
			language: "js",
			text: "write packages/foo.ts",
		});
		expect(previewJsCode('const mod = await import("./src/core/tools/code-preview.js");')).toEqual({
			language: "js",
			text: "import src/core/tools/code-preview.js",
		});
	});

	it("resolves simple path variables", () => {
		const code = `const target = "packages/coding-agent/src/foo.ts";
const before = await Bun.file(target).text();
await Bun.write(target, before.toUpperCase());`;
		expect(previewJsCode(code)).toEqual({
			language: "js",
			text: "write packages/coding-agent/src/foo.ts",
		});
	});

	it("surfaces the inner call of a console.log", () => {
		expect(previewJsCode("console.log(collectDiagnostics());")).toEqual({
			language: "js",
			text: "collectDiagnostics()",
		});
	});

	it("skips imports, comments and literal setup lines", () => {
		const code = `import { readFileSync } from "node:fs";
// rebuild the index
const limit = 10;

runCheck();`;
		expect(previewJsCode(code)).toEqual({ language: "js", text: "runCheck()" });
	});

	it("prefers executable calls over helper definitions", () => {
		const code = `function helper() {
	return 1;
}
runCheck();
`;
		expect(previewJsCode(code)).toEqual({ language: "js", text: "runCheck()" });
	});

	it("redacts sensitive js preview values", () => {
		expect(previewJsCode('const password = "supersecretvalue";')).toEqual({
			language: "js",
			text: "const password=<redacted>",
		});
		expect(previewJsCode('const client = new OpenAI({ apiKey: "sk-testsecretvalue" });')).toEqual({
			language: "js",
			text: 'const client = new OpenAI({ apiKey: "<redacted>" })',
		});
	});

	it("falls back when heredoc has no useful preview", () => {
		const command = `npm run check
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import path from "node:path";
JS`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "npm check" });
	});

	it("continues past empty js heredocs", () => {
		const command = `node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import path from "node:path";
JS
bun run /dev/stdin <<'JS'
await Bun.write("packages/foo.ts", "hello");
JS`;
		expect(previewBashCommand(command)).toEqual({ language: "js", text: "write packages/foo.ts" });
	});

	it("does not treat a .sh script path as an inline bash heredoc", () => {
		const command = `./script.sh <<'EOF'
hello world
EOF`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "hello world" });
	});

	it("prefers a later meaningful heredoc over an earlier generic one", () => {
		const command = `cat <<'CFG'
key=value
CFG
bun run /dev/stdin <<'JS'
await Bun.write("packages/foo.ts", "hello");
JS`;
		expect(previewBashCommand(command)).toEqual({ language: "js", text: "write packages/foo.ts" });
	});
});
