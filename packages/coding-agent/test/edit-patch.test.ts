import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - bundled skill is plain JS with JSDoc types, no .d.ts
import createSkill from "../skills/edit/skill.js";

/** Minimal structural type for the untyped skill module's documented calls. */
interface EditPatchHunk {
	at?: [number, number];
	after?: number;
	text?: string;
}

interface EditSkill {
	(path: string, oldText: string, newText: string): Promise<unknown>;
	src(path: string, from?: number, to?: number): Promise<string>;
	patch(path: string, tag: string, hunks: EditPatchHunk[]): Promise<string>;
}

const SOURCE = [
	"function greet(name) {",
	"  const msg = 'hi ' + name;",
	"  console.log(msg);",
	"}",
	"greet('world');",
].join("\n");

function makeSkill(content = SOURCE, name = "a.ts") {
	const dir = mkdtempSync(join(tmpdir(), "edit-patch-"));
	const path = join(dir, name);
	writeFileSync(path, content);
	// The skill module is untyped JS; the tests exercise it through its documented calls.
	const edit = createSkill({ display: () => {}, cwd: dir }) as EditSkill;
	return { edit, path, dir };
}

const tagOf = (view: string) => view.match(/#([0-9A-F]{4})\]/)?.[1] ?? "";

describe("edit.src", () => {
	it("prints a tagged, line-numbered view", async () => {
		const { edit } = makeSkill();
		const view = await edit.src("a.ts");
		expect(view.split("\n")[0]).toMatch(/^\[a\.ts#[0-9A-F]{4}\]$/);
		expect(view).toContain("2:  const msg = 'hi ' + name;");
	});

	it("windows a range without changing the tag", async () => {
		const { edit } = makeSkill();
		const whole = await edit.src("a.ts");
		const slice = await edit.src("a.ts", 2, 3);
		// The tag is the whole file, so any view of one file state anchors the same edits.
		expect(tagOf(slice)).toBe(tagOf(whole));
		expect(slice.split("\n")).toHaveLength(3);
	});
});

describe("edit.patch", () => {
	it("applies several hunks against the original numbering in one call", async () => {
		const { edit, path } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		await edit.patch("a.ts", tag, [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, not an interpolation
			{ at: [2, 3], text: "  console.log(`hi ${name}`);" },
			{ after: 4, text: "greet('there');" },
		]);
		// The insertion after line 4 is unaffected by the earlier hunk shrinking the file.
		expect(await Bun.file(path).text()).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, not an interpolation
			["function greet(name) {", "  console.log(`hi ${name}`);", "}", "greet('there');", "greet('world');"].join(
				"\n",
			),
		);
	});

	it("returns a tag that chains straight into the next patch", async () => {
		const { edit, path } = makeSkill();
		const first = tagOf(await edit.src("a.ts"));
		const second = await edit.patch("a.ts", first, [{ at: [5, 5], text: "greet('there');" }]);
		await edit.patch("a.ts", second, [{ at: [1, 1], text: "function greet(name = 'you') {" }]);
		expect(await Bun.file(path).text()).toContain("name = 'you'");
	});

	it("deletes a range when a hunk carries no text", async () => {
		const { edit, path } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		await edit.patch("a.ts", tag, [{ at: [2, 2] }]);
		expect(await Bun.file(path).text()).not.toContain("const msg");
	});

	it("inserts at the head with after:0", async () => {
		const { edit, path } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		await edit.patch("a.ts", tag, [{ after: 0, text: "// header" }]);
		expect((await Bun.file(path).text()).split("\n")[0]).toBe("// header");
	});

	it("rejects a stale tag and reports the fresh one with the text at each anchor", async () => {
		const { edit, path } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		writeFileSync(path, SOURCE.replace("greet('world');", "greet('everyone');"));

		const error = (await edit
			.patch("a.ts", tag, [{ at: [1, 1], text: "x" }])
			.catch((caught: Error) => caught)) as Error;
		expect(error.message).toContain(`changed since tag #${tag}`);
		// Everything needed to retry without a re-read.
		expect(error.message).toMatch(/it now hashes to #[0-9A-F]{4}/);
		expect(error.message).toContain("1:function greet(name) {");
		expect(await Bun.file(path).text()).toContain("everyone");
	});

	it("says so when the tag was never issued in this session", async () => {
		const { edit } = makeSkill();
		const error = (await edit
			.patch("a.ts", "0000", [{ at: [1, 1], text: "x" }])
			.catch((caught: Error) => caught)) as Error;
		expect(error.message).toContain("not issued in this session");
	});

	it("survives a formatter-only change, because trailing whitespace is normalised", async () => {
		const { edit, path } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		writeFileSync(path, `${SOURCE.replace("}", "}   ")}   `);
		await edit.patch("a.ts", tag, [{ at: [1, 1], text: "function greet(who) {" }]);
		expect(await Bun.file(path).text()).toContain("greet(who)");
	});

	it("throws instead of quietly doing nothing when the body already matches", async () => {
		const { edit } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		const error = (await edit
			.patch("a.ts", tag, [{ at: [1, 1], text: "function greet(name) {" }])
			.catch((caught: Error) => caught)) as Error;
		expect(error.message).toContain("byte-identical");
	});

	it("refuses overlapping hunks rather than applying them in some order", async () => {
		const { edit } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		const error = (await edit
			.patch("a.ts", tag, [
				{ at: [1, 3], text: "a" },
				{ at: [2, 4], text: "b" },
			])
			.catch((caught: Error) => caught)) as Error;
		expect(error.message).toContain("overlap");
	});

	it("rejects a range past the end of the file without writing", async () => {
		const { edit, path } = makeSkill();
		const tag = tagOf(await edit.src("a.ts"));
		const error = (await edit
			.patch("a.ts", tag, [{ at: [4, 99], text: "x" }])
			.catch((caught: Error) => caught)) as Error;
		expect(error.message).toContain("outside 1..5");
		expect(await Bun.file(path).text()).toBe(SOURCE);
	});

	it("keeps CRLF line endings", async () => {
		const { edit, path } = makeSkill(SOURCE.replace(/\n/g, "\r\n"));
		const tag = tagOf(await edit.src("a.ts"));
		await edit.patch("a.ts", tag, [{ at: [1, 1], text: "function greet(who) {" }]);
		const after = await Bun.file(path).text();
		expect(after).toContain("\r\n");
		expect(after).not.toMatch(/[^\r]\n/);
	});

	it("lets a string edit chain into a patch without re-reading", async () => {
		const { edit, path } = makeSkill();
		await edit.src("a.ts");
		await edit("a.ts", "greet('world');", "greet('everyone');");
		// run() re-records, so the file's live hash is known and a fresh src is enough.
		const tag = tagOf(await edit.src("a.ts"));
		await edit.patch("a.ts", tag, [{ at: [1, 1], text: "function greet(who) {" }]);
		expect(await Bun.file(path).text()).toContain("greet(who)");
	});
});
