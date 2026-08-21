import { describe, expect, it } from "bun:test";
import { hasStaticImport, transformTopLevel } from "../src/core/bun-repl/transform.js";

// The REPL evaluates cells as vm scripts, where a static `import` is a SyntaxError
// whose message ("import call expects one or two arguments") reads like a mis-called
// function. The transformer rewrites the top-level forms into `await import(...)` and
// binds them onto `globalThis`, the same persistence path top-level `const` uses.

const code = (src: string): string => transformTopLevel(src).code;

describe("transformTopLevel: static imports", () => {
	it("rewrites named imports, including aliases", () => {
		const out = code('import { a, b as c } from "m"');
		expect(out).toContain('await import("m")');
		expect(out).toContain("globalThis.a =");
		expect(out).toContain("globalThis.c =");
		expect(out).not.toContain("globalThis.b =");
	});

	it("rewrites a default import to the module's default", () => {
		expect(code('import d from "m"')).toContain("globalThis.d = __mod0.default;");
	});

	it("rewrites a namespace import to the namespace object", () => {
		expect(code('import * as ns from "m"')).toContain("globalThis.ns = __mod0;");
	});

	it("rewrites default + named", () => {
		const out = code('import d, { a } from "m"');
		expect(out).toContain("globalThis.d = __mod0.default;");
		expect(out).toContain('globalThis.a = __mod0["a"];');
	});

	it("rewrites default + namespace", () => {
		const out = code('import d, * as ns from "m"');
		expect(out).toContain("globalThis.d = __mod0.default;");
		expect(out).toContain("globalThis.ns = __mod0;");
	});

	it("rewrites a side-effect-only import", () => {
		expect(code('import "m"').trim()).toBe('await import("m");');
	});

	it("reads `default as d` off the namespace", () => {
		expect(code('import { default as d } from "m"')).toContain('globalThis.d = __mod0["default"];');
	});

	it("handles a multi-line specifier list with a trailing comma", () => {
		const out = code('import {\n\ta,\n\tb,\n} from "m"');
		expect(out).toContain('globalThis.a = __mod0["a"];');
		expect(out).toContain('globalThis.b = __mod0["b"];');
	});

	it("handles several imports in one cell without colliding temporaries", () => {
		const result = transformTopLevel('import { a } from "m"\nimport { b } from "n"\na + b');
		expect(result.code).toContain('await import("m")');
		expect(result.code).toContain('await import("n")');
		expect(result.code).not.toContain('__mod0 = await import("n")');
		expect(result.lastExpression).toBe("a + b");
	});

	it("keeps imports interleaved with other statements in source order", () => {
		const out = code('import { a } from "m"\nconst x = a + 1\nimport * as p from "node:path"');
		const importA = out.indexOf('await import("m")');
		const assignX = out.indexOf("globalThis.x =");
		const importP = out.indexOf('await import("node:path")');
		expect(importA).toBeGreaterThanOrEqual(0);
		expect(importA).toBeLessThan(assignX);
		expect(assignX).toBeLessThan(importP);
	});

	it("keeps a leading comment and still rewrites the import under it", () => {
		const out = code('// load the shell\nimport { $ } from "bun"');
		expect(out).toContain("// load the shell");
		expect(out).toContain('globalThis.$ = __mod0["$"];');
	});

	it("rewrites an import that carries a trailing comment", () => {
		const out = code('import { a } from "m" // why\nfoo()');
		expect(out).toContain('globalThis.a = __mod0["a"];');
	});

	it("never captures an import as the cell's result value", () => {
		expect(transformTopLevel('import { a } from "m"').lastExpression).toBeUndefined();
	});

	it("is deterministic", () => {
		const src = 'import d, { a as b } from "m"\nimport "side"\nd(b)';
		expect(transformTopLevel(src)).toEqual(transformTopLevel(src));
	});
});

describe("transformTopLevel: type-only imports are erased", () => {
	it("erases `import type { A } from`", () => {
		expect(code('import type { A } from "m"').trim()).toBe("");
	});

	it("erases `import type A from`", () => {
		expect(code('import type A from "m"').trim()).toBe("");
	});

	it("erases `import type * as ns from`", () => {
		expect(code('import type * as NS from "m"').trim()).toBe("");
	});

	it("drops inline `type` specifiers but keeps the value ones", () => {
		const out = code('import { type A, b } from "m"');
		expect(out).toContain('globalThis.b = __mod0["b"];');
		expect(out).not.toContain("globalThis.A");
	});

	it("treats a binding actually named `type` as a value", () => {
		expect(code('import type from "m"')).toContain("globalThis.type = __mod0.default;");
		expect(code('import { type } from "m"')).toContain('globalThis.type = __mod0["type"];');
		expect(code('import { type as t } from "m"')).toContain('globalThis.t = __mod0["type"];');
	});
});

describe("transformTopLevel: what must never be rewritten", () => {
	const untouched = (src: string): void => {
		expect(code(src)).toContain("import");
		expect(code(src)).not.toContain("__mod");
	};

	it("leaves `import` inside a string literal alone", () => {
		expect(code(`const s = "import { a } from 'm'"`)).toBe(`globalThis.s = "import { a } from 'm'";\n`);
	});

	it("leaves `import` inside a template literal alone", () => {
		expect(code("const s = `import { a } from 'm'`")).toBe("globalThis.s = `import { a } from 'm'`;\n");
	});

	it("leaves `import` inside a comment alone", () => {
		const out = code('// import { a } from "m"\n1 + 1');
		expect(out).not.toContain("__mod");
	});

	it("leaves an already-dynamic `await import()` alone", () => {
		expect(code('const m = await import("m")')).toBe('globalThis.m = await import("m");\n');
	});

	it("leaves `import.meta` alone", () => {
		untouched("import.meta.url");
	});

	it("leaves an identifier that merely starts with `import` alone", () => {
		expect(transformTopLevel("importAll()").lastExpression).toBe("importAll()");
	});

	it("leaves a computed specifier alone rather than guessing", () => {
		untouched("import { a } from someVar");
	});

	it("leaves an unsupported specifier form alone rather than guessing", () => {
		untouched('import { "x" as y } from "m"');
		untouched('import json from "./a.json" with { type: "json" }');
	});

	it("does not treat `from(...)` after a class body as an import clause", () => {
		const result = transformTopLevel("class C {}\nfrom(1)");
		expect(result.code).toContain("globalThis.C = class C {}");
		expect(result.lastExpression).toBe("from(1)");
	});

	it("does not return a comment-only trailing segment as the result", () => {
		const result = transformTopLevel("foo()\n// done");
		expect(result.lastExpression).toBe("foo()");
	});

	// A comment directly above a block used to be classified from the raw text, so the
	// statement started with `//`, matched no keyword, and was captured as the cell's result:
	// `return (// note\nfor (…) {…});`. Every cell that annotated a loop failed to compile.
	it.each([
		["// note\nfor (const x of [1]) {\n  console.log(x);\n}"],
		["// note\nif (1) {\n  console.log(1);\n}"],
		["let i = 0;\n// note\nwhile (i < 1) {\n  i++;\n}"],
		["/* block */\ntry {\n  console.log(1);\n} catch {}"],
		["const a = 1;\n/* inline */ for (const q of [a]) {\n  console.log(q);\n}"],
	] as const)("does not capture a commented block as the result value: %p", (src) => {
		const result = transformTopLevel(src);
		const assembled = result.lastExpression ? `${result.code}\nreturn (${result.lastExpression});` : result.code;
		expect(() => new Function(`return (async () => {${assembled}})`)).not.toThrow();
	});

	it("still returns a trailing expression that carries a leading comment", () => {
		const result = transformTopLevel("const a = 1;\n// note\na + 1");
		expect(result.lastExpression).toContain("a + 1");
	});
});

describe("hasStaticImport", () => {
	it.each([
		['import { a } from "m"', true],
		['import "m"', true],
		['// note\nimport d from "m"', true],
		["import { a } from someVar", true],
		['const m = await import("m")', false],
		["import.meta.url", false],
		["importAll()", false],
		[`const s = "import { a } from 'm'"`, false],
		["// import { a } from 'm'\n1", false],
	] as const)("%p -> %p", (src, expected) => {
		expect(hasStaticImport(src)).toBe(expected);
	});
});

describe("transformTopLevel: declarations preceded by comments", () => {
	it("rewrites a const preceded by a line comment", () => {
		const out = code("// compute\nconst lines = report.split('\\n');\nlines");
		expect(out).toContain("globalThis.lines = report.split('\\n');");
		expect(out).toContain("// compute");
	});

	it("rewrites a const preceded by a block comment", () => {
		const out = code("/* note */ const x = 1;");
		expect(out).toContain("globalThis.x = 1;");
		expect(out).toContain("/* note */");
	});

	it("rewrites a function preceded by a line comment", () => {
		const out = code("// helper\nfunction f() {\n  return 1;\n}");
		expect(out).toContain("globalThis.f = function f()");
		expect(out).toContain("// helper");
	});

	it("keeps the declaration as the cell result boundary (not an expression)", () => {
		const r = transformTopLevel("// c\nconst y = 2;\ny + 1;");
		expect(r.lastExpression).toBe("y + 1");
		expect(r.code).toContain("globalThis.y = 2;");
	});
});
