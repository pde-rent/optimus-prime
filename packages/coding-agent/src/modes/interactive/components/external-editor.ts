import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Run $VISUAL/$EDITOR synchronously over a temp copy of `text` and return the
 * edited content, or undefined when no editor is configured or the editor
 * exited non-zero (original text is kept). Temp-file cleanup always runs.
 */
export function runExternalEditor(text: string, options?: { tmpPrefix?: string }): string | undefined {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		return undefined;
	}
	const tmpFile = path.join(os.tmpdir(), `${options?.tmpPrefix ?? "pi-editor"}-${Date.now()}.md`);
	try {
		fs.writeFileSync(tmpFile, text, "utf-8");

		// Split by space to support editor arguments (e.g., "code --wait")
		const [editor, ...editorArgs] = editorCmd.split(" ");
		const result = spawnSync(editor, [...editorArgs, tmpFile], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});

		if (result.status === 0) {
			return fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
		}
		return undefined;
	} finally {
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}
