import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "./helpers/render.js";

const GIT_DIFF_OUTPUT = [
	"diff --git a/src/sample.ts b/src/sample.ts",
	"index 1234567..89abcde 100644",
	"--- a/src/sample.ts",
	"+++ b/src/sample.ts",
	"@@ -1,2 +1,2 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
].join("\n");

function contextOverrides() {
	return {
		state: {} as Record<string, unknown>,
		invalidate: () => {},
		lastComponent: undefined,
		cwd: "/tmp/project",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showExpandHint: false,
		showImages: false,
		includeImageDimensions: false,
		isError: false,
	};
}

describe("bash result renderer unified-diff detection", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		initTheme("dark");
	});

	it("renders git diff output as a rich diff with a file summary anchor", () => {
		const definition = createBashToolDefinition("/tmp/project");
		const component = definition.renderResult!(
			{ content: [{ type: "text", text: GIT_DIFF_OUTPUT }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			contextOverrides() as Parameters<NonNullable<typeof definition.renderResult>>[3],
		);
		const rendered = component.render(120).map((line) => stripAnsi(line));
		const joined = rendered.join("\n");
		expect(joined).toContain("src/sample.ts");
		expect(joined).toContain("+1 -1");
		expect(joined).toContain("const b = 3;");
		expect(joined).toContain("2 + ");
		expect(joined).not.toContain("diff --git");
	});

	it("keeps ordinary output plain", () => {
		const definition = createBashToolDefinition("/tmp/project");
		const component = definition.renderResult!(
			{ content: [{ type: "text", text: "just some\nordinary output" }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			contextOverrides() as Parameters<NonNullable<typeof definition.renderResult>>[3],
		);
		const rendered = component.render(120).map((line) => stripAnsi(line));
		expect(rendered.join("\n")).toContain("ordinary output");
		expect(rendered.join("\n")).not.toContain("╰─");
	});
});
