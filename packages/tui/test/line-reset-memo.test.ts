import { describe, expect, it } from "bun:test";
import { LineResetMemo } from "../src/tui.js";

describe("LineResetMemo", () => {
	it("returns undefined for unseen keys and caches inserted values", () => {
		const memo = new LineResetMemo();
		expect(memo.get("raw")).toBeUndefined();
		memo.set("raw", "normalized");
		expect(memo.get("raw")).toBe("normalized");
		expect(memo.misses).toBe(1);
		expect(memo.hits).toBe(1);
	});

	it("treats distinct line content as distinct entries", () => {
		const memo = new LineResetMemo();
		memo.set("a", "a+");
		memo.set("b", "b+");
		expect(memo.get("a")).toBe("a+");
		expect(memo.get("b")).toBe("b+");
	});

	it("evicts the least recently used entry at capacity", () => {
		const memo = new LineResetMemo(2);
		memo.set("a", "A");
		memo.set("b", "B");
		expect(memo.get("a")).toBe("A"); // touch a so b becomes the LRU entry
		memo.set("c", "C"); // evicts b
		expect(memo.get("b")).toBeUndefined();
		expect(memo.get("a")).toBe("A");
		expect(memo.get("c")).toBe("C");
	});

	it("re-inserting an existing key does not grow past capacity", () => {
		const memo = new LineResetMemo(2);
		memo.set("a", "A");
		memo.set("a", "A2");
		memo.set("b", "B");
		expect(memo.get("a")).toBe("A2");
		expect(memo.get("b")).toBe("B");
	});
});
