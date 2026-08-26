import { describe, expect, test } from "bun:test";
import { resolveToolAliasCall } from "../src/core/tool-aliases.js";
import { parsePatchBody, resolveApplyPatchCall } from "../src/core/tools/apply-patch.js";

const UPDATE_PATCH = `*** Begin Patch
*** Update File: src/util.ts
@@
 export function alpha() {
-	return 1;
+	return 2;
 }
*** End Patch`;

describe("apply_patch transpiler", () => {
	test("single-file update maps onto the edit tool with exact blocks", () => {
		const resolution = resolveToolAliasCall("apply_patch", {
			patch: UPDATE_PATCH,
		});
		expect(resolution?.name).toBe("edit");
		expect(resolution?.args.path).toBe("src/util.ts");
		const edits = resolution?.args.edits as Array<{ oldText: string; newText: string }>;
		expect(edits).toHaveLength(1);
		expect(edits[0].oldText).toBe("export function alpha() {\n\treturn 1;\n}\n");
		expect(edits[0].newText).toContain("return 2;");
	});

	test("add file maps onto write_file with full content", () => {
		const resolution = resolveToolAliasCall("apply_patch", {
			patch: "*** Begin Patch\n*** Add File: docs/new.md\n+# Hello\n+world\n*** End Patch",
		});
		expect(resolution?.name).toBe("write_file");
		expect(resolution?.args.path).toBe("docs/new.md");
		expect(resolution?.args.content).toBe("# Hello\nworld\n");
	});

	test("delete file routes through bash rm", () => {
		const resolution = resolveToolAliasCall("apply_patch", {
			patch: "*** Begin Patch\n*** Delete File: old/thing.txt\n*** End Patch",
		});
		expect(resolution?.name).toBe("bash");
		expect(String(resolution?.args.command)).toContain("rm -f 'old/thing.txt'");
	});

	test("multi-file patches transpile to one bash script", () => {
		const resolution = resolveToolAliasCall("apply_patch", {
			patch: [
				"*** Begin Patch",
				"*** Add File: a.txt",
				"+alpha",
				"*** Update File: b.txt",
				"@@",
				"-old line",
				"+new line",
				"*** Delete File: c.txt",
				"*** End Patch",
			].join("\n"),
		});
		expect(resolution?.name).toBe("bash");
		const command = String(resolution?.args.command);
		expect(command).toContain("cat > 'a.txt'");
		expect(command).toContain("python3 -");
		expect(command).toContain("rm -f 'c.txt'");
		expect(resolution?.note).toContain("transpiled to a shell script");
	});

	test("non-chat inputs and empty bodies degrade gracefully", () => {
		expect(resolveApplyPatchCall("bash", {})).toBeUndefined();
		const empty = resolveToolAliasCall("apply_patch", { patch: "   " });
		expect(empty?.name).toBe("bash");
		expect(empty?.note).toContain("no patch body found");
	});

	test("parsePatchBody tolerates missing End Patch and Move to", () => {
		const parsed = parsePatchBody("*** Begin Patch\n*** Update File: x.ts\n*** Move to: y.ts\n-old\n+new");
		expect(parsed.ops).toHaveLength(1);
		if (parsed.ops[0].kind === "update") {
			expect(parsed.ops[0].path).toBe("x.ts");
			expect(parsed.ops[0].moveTo).toBe("y.ts");
			expect(parsed.ops[0].blocks[0].oldText).toBe("old\n");
			expect(parsed.ops[0].blocks[0].newText).toBe("new\n");
		} else {
			throw new Error("expected update op");
		}
	});
});
