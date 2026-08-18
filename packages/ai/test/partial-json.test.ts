import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.js";
import { parsePartialJson } from "../src/utils/partial-json.js";

/**
 * Representative streamed tool-call payloads. The truncation sweep below cuts
 * each of these at every index and asserts the parser is total (never throws)
 * and sound (never reports a value that differs from the final one).
 */
const PAYLOADS: Record<string, unknown> = {
	edit: {
		file_path: "/tmp/a b/main.ts",
		old_string: 'const x = "hi";\n\tif (x) {}',
		new_string: "const x = 'hi';",
		replace_all: false,
	},
	bash: { command: "rg -n 'foo\\\\bar' . | head -20", timeout: 120000, description: "search" },
	nested: {
		todos: [
			{ id: 1, content: "one", done: true, tags: ["a", "b"] },
			{ id: 23, content: "two é 😀", done: false, tags: [] },
		],
		meta: { count: 2, ratio: -1.5e2, missing: null },
	},
};

/** Walks `expected` alongside `actual`; every leaf present in `actual` must be a prefix/equal. */
function assertSound(actual: unknown, expected: unknown, path: string): void {
	if (actual === undefined) {
		return;
	}
	if (typeof expected === "string") {
		expect(typeof actual, path).toBe("string");
		expect(expected.startsWith(actual as string), `${path}: ${JSON.stringify(actual)}`).toBe(true);
		return;
	}
	if (Array.isArray(expected)) {
		expect(Array.isArray(actual), path).toBe(true);
		const items = actual as unknown[];
		expect(items.length, `${path}.length`).toBeLessThanOrEqual(expected.length);
		items.forEach((item, index) => {
			assertSound(item, expected[index], `${path}[${index}]`);
		});
		return;
	}
	if (expected !== null && typeof expected === "object") {
		expect(typeof actual, path).toBe("object");
		expect(actual, path).not.toBeNull();
		for (const [key, value] of Object.entries(actual as Record<string, unknown>)) {
			expect(Object.hasOwn(expected as object, key), `${path}.${key} invented`).toBe(true);
			assertSound(value, (expected as Record<string, unknown>)[key], `${path}.${key}`);
		}
		return;
	}
	// Numbers, booleans, null: must match exactly — a partial one must be omitted.
	expect(actual, path).toStrictEqual(expected);
}

describe("parsePartialJson truncation sweep", () => {
	for (const [name, payload] of Object.entries(PAYLOADS)) {
		const json = JSON.stringify(payload);

		it(`${name}: never throws at any of ${json.length} truncation points`, () => {
			for (let end = 0; end <= json.length; end++) {
				const slice = json.slice(0, end);
				expect(() => parsePartialJson(slice), `truncated at ${end}`).not.toThrow();
				expect(() => parseStreamingJson(slice), `truncated at ${end}`).not.toThrow();
			}
		});

		it(`${name}: never invents a value at any truncation point`, () => {
			for (let end = 0; end <= json.length; end++) {
				assertSound(parsePartialJson(json.slice(0, end)), payload, `${name}@${end}`);
			}
		});

		it(`${name}: recovers the exact payload once complete`, () => {
			expect(parsePartialJson(json)).toStrictEqual(payload);
			expect(parseStreamingJson(json)).toStrictEqual(payload);
		});

		it(`${name}: is monotonic — known keys are never withdrawn`, () => {
			let previousKeys: string[] = [];
			for (let end = 0; end <= json.length; end++) {
				const value = parsePartialJson(json.slice(0, end));
				const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
				if (keys.length > 0 || previousKeys.length > 0) {
					expect(keys.slice(0, previousKeys.length), `${name}@${end}`).toStrictEqual(previousKeys);
				}
				previousKeys = keys;
			}
		});
	}
});

describe("parsePartialJson fails closed", () => {
	it("drops a number that is still being written", () => {
		expect(parsePartialJson('{"count": 12')).toStrictEqual({});
		expect(parsePartialJson('{"count": 12, ')).toStrictEqual({ count: 12 });
		expect(parsePartialJson('{"count": 1.')).toStrictEqual({});
		expect(parsePartialJson('{"count": -')).toStrictEqual({});
		expect(parsePartialJson("[1, 2")).toStrictEqual([1]);
	});

	it("drops a literal that is still being written", () => {
		expect(parsePartialJson('{"ok": tru')).toStrictEqual({});
		expect(parsePartialJson('{"ok": n')).toStrictEqual({});
		expect(parsePartialJson('{"ok": true')).toStrictEqual({ ok: true });
		expect(parsePartialJson('{"ok": null}')).toStrictEqual({ ok: null });
	});

	it("drops a partial object key", () => {
		expect(parsePartialJson('{"file_pa')).toStrictEqual({});
		expect(parsePartialJson('{"a": 1, "file_pa')).toStrictEqual({ a: 1 });
		expect(parsePartialJson('{"a": 1, "b"')).toStrictEqual({ a: 1 });
		expect(parsePartialJson('{"a": 1, "b":')).toStrictEqual({ a: 1 });
	});

	it("returns undefined when nothing can be salvaged", () => {
		expect(parsePartialJson("")).toBeUndefined();
		expect(parsePartialJson("   ")).toBeUndefined();
		expect(parsePartialJson("hello")).toBeUndefined();
	});
});

describe("parsePartialJson strings", () => {
	it("keeps a partial string value as a prefix", () => {
		expect(parsePartialJson('{"s": "hel')).toStrictEqual({ s: "hel" });
		expect(parsePartialJson('{"s": "')).toStrictEqual({ s: "" });
	});

	it("drops a trailing incomplete escape rather than guessing", () => {
		expect(parsePartialJson('{"s": "a\\')).toStrictEqual({ s: "a" });
		expect(parsePartialJson('{"s": "a\\u')).toStrictEqual({ s: "a" });
		expect(parsePartialJson('{"s": "a\\u00')).toStrictEqual({ s: "a" });
		expect(parsePartialJson('{"s": "a\\u0041')).toStrictEqual({ s: "aA" });
	});

	it("decodes escapes, including unicode and surrogate pairs", () => {
		expect(parsePartialJson('{"s": "a\\nb\\tc\\"d\\\\e\\/f"}')).toStrictEqual({ s: 'a\nb\tc"d\\e/f' });
		expect(parsePartialJson('{"s": "\\u00e9\\ud83d\\ude00"}')).toStrictEqual({ s: "é😀" });
	});

	it("drops a dangling high surrogate from a partial string", () => {
		expect(parsePartialJson('{"s": "x\\ud83d')).toStrictEqual({ s: "x" });
		expect(parsePartialJson('{"s": "x\\ud83d\\ude00')).toStrictEqual({ s: "x😀" });
	});

	it("repairs raw control characters and unknown escapes", () => {
		expect(parsePartialJson('{"s": "a\nb"}')).toStrictEqual({ s: "a\nb" });
		expect(parsePartialJson('{"s": "a\\qb"}')).toStrictEqual({ s: "a\\qb" });
	});
});

describe("parsePartialJson structures", () => {
	it("handles nested objects and arrays", () => {
		// The third element is known to be an object, so it appears — but empty,
		// since its only value is still being written.
		expect(parsePartialJson('{"a": {"b": [1, 2, {"c":')).toStrictEqual({ a: { b: [1, 2, {}] } });
		expect(parsePartialJson('{"a": {"b": [1, 2, {"c": 3')).toStrictEqual({ a: { b: [1, 2, {}] } });
		expect(parsePartialJson('{"a": {"b": [1, 2, {"c": 3}')).toStrictEqual({ a: { b: [1, 2, { c: 3 }] } });
		expect(parsePartialJson("[[1, 2], [3")).toStrictEqual([[1, 2], []]);
		expect(parsePartialJson("[[1, 2], [3]")).toStrictEqual([[1, 2], [3]]);
		expect(parsePartialJson('{"a": [], "b": {}}')).toStrictEqual({ a: [], b: {} });
	});

	it("tolerates whitespace anywhere", () => {
		expect(parsePartialJson('  {\n  "a" :\t1 ,\n "b" : [ 2 ]\n}')).toStrictEqual({ a: 1, b: [2] });
	});
});

describe("parseStreamingJson", () => {
	it("prefers a strict parse of complete input", () => {
		expect(parseStreamingJson('{"a": 1}')).toStrictEqual({ a: 1 });
	});

	it("falls back to the partial parser and never throws", () => {
		expect(parseStreamingJson('{"a": 1, "b": "tw')).toStrictEqual({ a: 1, b: "tw" });
		expect(parseStreamingJson(undefined)).toStrictEqual({});
		expect(parseStreamingJson("   ")).toStrictEqual({});
		expect(parseStreamingJson("not json at all")).toStrictEqual({});
	});
});
