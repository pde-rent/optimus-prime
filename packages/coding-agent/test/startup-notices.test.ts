import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { formatTmuxWarningNotice } from "../src/modes/shared/startup-notices.js";
import { stripAnsi } from "./helpers/render.js";

describe("startup notice formatters", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("tmux warning notice is prefixed with the warning glyph", () => {
		const output = stripAnsi(formatTmuxWarningNotice("tmux extended-keys is off."));
		expect(output).toBe("⚠ tmux extended-keys is off.");
	});
});
