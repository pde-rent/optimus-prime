import { describe, expect, it } from "bun:test";
import { KeyedRenderCache, VersionedRenderCache } from "../src/render-cache.js";

describe("KeyedRenderCache", () => {
	it("returns the cached value only for an identical key", () => {
		const cache = new KeyedRenderCache();
		const lines = ["a", "b"];
		expect(cache.get("x", 10)).toBeUndefined();
		cache.set(["x", 10], lines);
		expect(cache.get("x", 10)).toBe(lines);
		expect(cache.get("x", 11)).toBeUndefined();
		expect(cache.get("y", 10)).toBeUndefined();
	});

	it("set replaces the previous entry", () => {
		const cache = new KeyedRenderCache();
		cache.set(["k", 1], ["1"]);
		cache.set(["k", 1], ["2"]);
		expect(cache.get("k", 1)).toEqual(["2"]);
	});

	it("invalidate clears the entry", () => {
		const cache = new KeyedRenderCache();
		cache.set(["k"], ["v"]);
		cache.invalidate();
		expect(cache.get("k")).toBeUndefined();
	});
});

describe("VersionedRenderCache", () => {
	it("keys on width and version", () => {
		const cache = new VersionedRenderCache();
		cache.set(80, 0, ["v1"]);
		expect(cache.get(80, 0)).toEqual(["v1"]);
		expect(cache.get(81, 0)).toBeUndefined();
		cache.invalidate();
		expect(cache.get(80, 0)).toBeUndefined();
	});
});
