import { describe, expect, it } from "bun:test";
import { chunkSerializedParts, summarizeChunkCharBudget } from "../src/core/compaction/compaction.js";

describe("summarizeChunkCharBudget", () => {
	it("falls back to 128k when the context window is unknown", () => {
		const budget = summarizeChunkCharBudget(0, 16384);
		expect(budget).toBe((128000 - 16384 - 2048) * 4);
	});

	it("scales with the context window and stays positive for small windows", () => {
		expect(summarizeChunkCharBudget(1000000, 16384)).toBeGreaterThan(summarizeChunkCharBudget(200000, 16384));
		expect(summarizeChunkCharBudget(1000, 16384)).toBeGreaterThanOrEqual(4096 * 4);
	});
});

describe("chunkSerializedParts", () => {
	it("keeps small inputs in a single chunk", () => {
		expect(chunkSerializedParts(["a", "b"], 100)).toEqual(["a\n\nb"]);
	});

	it("splits into chunks that each respect the limit", () => {
		const parts = ["x".repeat(60), "y".repeat(60), "z".repeat(60)];
		const chunks = chunkSerializedParts(parts, 100);
		expect(chunks.length).toBe(3);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(100);
		}
	});

	it("groups consecutive parts up to the limit", () => {
		const parts = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
		const chunks = chunkSerializedParts(parts, 100);
		expect(chunks).toEqual([`${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n${"c".repeat(30)}`]);
	});

	it("truncates a single part larger than the limit", () => {
		const chunks = chunkSerializedParts(["x".repeat(500)], 100);
		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBeLessThanOrEqual(200);
		expect(chunks[0]).toContain("truncated");
	});

	it("returns no chunks for empty input", () => {
		expect(chunkSerializedParts([], 100)).toEqual([]);
	});
});
