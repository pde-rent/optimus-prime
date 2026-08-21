import { describe, expect, it } from "bun:test";
import { formatDisplayPath, formatSplashCwd } from "../src/modes/interactive/path-formatting.js";

describe("path-formatting home replacement", () => {
	it("replaces the home directory prefix with ~", () => {
		const home = process.env.HOME ?? "";
		expect(formatDisplayPath(`${home}/foo/bar.ts`)).toBe("~/foo/bar.ts");
		expect(formatDisplayPath(home)).toBe("~");
	});

	it("does not replace sibling directories that share the home prefix", () => {
		const home = (process.env.HOME ?? "").replace(/\/$/, "");
		const sibling = `${home}-server/foo`;
		expect(formatDisplayPath(sibling)).toBe(sibling);
	});

	it("normalizes separators and replaces home in splash cwd", () => {
		const home = (process.env.HOME ?? "").replace(/\/$/, "");
		expect(formatSplashCwd(`${home}\\proj`)).toBe("~/proj");
	});
});
