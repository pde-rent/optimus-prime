import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TurnMetadataComponent } from "../src/modes/interactive/components/turn-metadata.js";
import { initTheme, setRegisteredThemes } from "../src/modes/interactive/theme/theme.js";

// Minimal theme bootstrap so theme.fg works outside the TUI.
setRegisteredThemes(new Map([["dark", {} as never]]) as unknown as Parameters<typeof setRegisteredThemes>[0]);
try {
	initTheme("dark", true);
} catch {
	// Already registered by another test file in the same process.
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("TurnMetadataComponent", () => {
	const meta = {
		endedAtMs: Date.UTC(2026, 0, 1, 14, 32, 5),
		durationMs: 42_300,
		inputTokens: 1234,
		outputTokens: 56_789,
		costUsd: 0.0321,
	};

	test("right-aligns metadata behind a dot rule within the given width", () => {
		const lines = new TurnMetadataComponent(meta).render(80);
		expect(lines.length).toBe(1);
		const plain = stripAnsi(lines[0]!);
		expect(visibleWidth(lines[0]!) <= 80).toBe(true);
		expect(plain.trimEnd().endsWith("$0.032")).toBe(true);
		expect(plain).toContain("↑1.2k");
		expect(plain).toContain("↓57k tok");
		expect(plain).toContain("14:32:05");
		expect(plain).toContain("42.3s");
		// The rule is dots up to the metadata block.
		expect(plain.startsWith("·")).toBe(true);
	});

	test("narrow widths truncate without throwing", () => {
		const lines = new TurnMetadataComponent(meta).render(20);
		expect(lines.length).toBe(1);
		expect(visibleWidth(lines[0]!) <= 20).toBe(true);
	});

	test("zero-cost turns omit the cost segment", () => {
		const lines = new TurnMetadataComponent({ ...meta, costUsd: 0 }).render(100);
		expect(stripAnsi(lines[0]!)).not.toContain("$");
	});
});
