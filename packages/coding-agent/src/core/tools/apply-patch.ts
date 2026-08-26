import type { ToolAliasResolution } from "@earendil-works/pi-agent-core";

/**
 * Transpiler for the OpenAI Codex `apply_patch` dialect (V4A format):
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +content
 *   *** Update File: <path>
 *    context
 *   -removed
 *   +added
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Codex-trained models emit this instinctively instead of per-file edit calls.
 * The body is parsed into per-file operations and routed onto the canonical
 * tools: single-file updates become `edit`, adds become `write_file`, deletes
 * become `bash rm`. Patches touching several files cannot map onto one
 * canonical call, so they transpile into an equivalent POSIX shell script
 * executed through `bash`.
 */

const APPLY_PATCH_NAMES = new Set(["apply_patch", "applypatch", "codex_apply_patch"]);

export function isApplyPatchCall(requestedName: string): boolean {
	return APPLY_PATCH_NAMES.has(requestedName.toLowerCase());
}

interface PatchOpAdd {
	kind: "add";
	path: string;
	content: string;
}
interface PatchOpUpdate {
	kind: "update";
	path: string;
	/** Contiguous replacement blocks: oldText must match current file content. */
	blocks: Array<{ oldText: string; newText: string }>;
	moveTo?: string;
}
interface PatchOpDelete {
	kind: "delete";
	path: string;
}
type PatchOp = PatchOpAdd | PatchOpUpdate | PatchOpDelete;

export interface ParsedPatch {
	ops: PatchOp[];
	parseNotes: string[];
}

/** Parse a V4A patch body. Tolerates missing End Patch and *-style markers. */
export function parsePatchBody(body: string): ParsedPatch {
	const notes: string[] = [];
	const ops: PatchOp[] = [];
	const lines = body.split("\n");
	let i = 0;

	const skipPreamble = () => {
		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (/^\*{2,5}\s*Begin Patch$/i.test(trimmed)) {
				i++;
				continue;
			}
			break;
		}
	};

	while (i < lines.length) {
		skipPreamble();
		if (i >= lines.length) break;
		const line = lines[i];
		const trimmed = line.trim();
		if (/^\*{2,5}\s*End Patch$/i.test(trimmed)) break;
		if (trimmed === "") {
			i++;
			continue;
		}

		let match = /^\*{2,5}\s*Add File:\s*(.+?)\s*$/.exec(trimmed);
		if (match) {
			i++;
			const content: string[] = [];
			while (i < lines.length && lines[i].startsWith("+")) {
				content.push(lines[i].slice(1));
				i++;
			}
			ops.push({ kind: "add", path: match[1], content: `${content.join("\n")}\n` });
			continue;
		}

		match = /^\*{2,5}\s*Delete File:\s*(.+?)\s*$/.exec(trimmed);
		if (match) {
			ops.push({ kind: "delete", path: match[1] });
			i++;
			continue;
		}

		match = /^\*{2,5}\s*(?:Update|Move) File:\s*(.+?)\s*$/.exec(trimmed);
		if (match) {
			const path = match[1];
			i++;
			const blocks: Array<{ oldText: string; newText: string }> = [];
			let oldText = "";
			let newText = "";
			let sawChange = false;
			let moveTo: string | undefined;
			const flushBlock = () => {
				if (!sawChange) return;
				blocks.push({ oldText, newText });
				oldText = "";
				newText = "";
				sawChange = false;
			};
			while (i < lines.length) {
				const body = lines[i];
				const bodyTrimmed = body.trim();
				if (/^\*{2,5}\s*(End Patch|Add File|Update File|Move File|Delete File)/i.test(bodyTrimmed)) break;
				if (/^@@/.test(bodyTrimmed)) {
					flushBlock();
					i++;
					continue;
				}
				const moveMatch = /^\*{2,5}\s*Move to:\s*(.+?)\s*$/.exec(bodyTrimmed);
				if (moveMatch) {
					moveTo = moveMatch[1];
					i++;
					continue;
				}
				if (body.startsWith("-")) {
					oldText += `${body.slice(1)}\n`;
					sawChange = true;
					i++;
					continue;
				}
				if (body.startsWith("+")) {
					newText += `${body.slice(1)}\n`;
					sawChange = true;
					i++;
					continue;
				}
				if (body.startsWith(" ") || bodyTrimmed === "") {
					oldText += `${body.startsWith(" ") ? body.slice(1) : bodyTrimmed}\n`;
					newText += `${body.startsWith(" ") ? body.slice(1) : bodyTrimmed}\n`;
					i++;
					continue;
				}
				// Unprefixed non-empty line: not part of the patch vocabulary.
				break;
			}
			flushBlock();
			if (blocks.length === 0 && !moveTo) {
				notes.push(`Update File "${path}" contained no applicable changes`);
				continue;
			}
			ops.push({ kind: "update", path, blocks, moveTo });
			continue;
		}

		notes.push(`skipped unrecognized patch line: ${trimmed.slice(0, 60)}`);
		i++;
	}

	return { ops, parseNotes: notes };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build one POSIX shell command performing a whole-file add. */
function addShell(op: PatchOpAdd): string {
	const dir = op.path.includes("/") ? `mkdir -p ${shellQuote(op.path.slice(0, op.path.lastIndexOf("/")))} && ` : "";
	return `${dir}cat > ${shellQuote(op.path)} <<'OPTIMUS_PATCH_EOF'\n${op.content}OPTIMUS_PATCH_EOF`;
}

/**
 * Build one python3 command applying the update blocks as exact-string
 * replacements. Used only for patches the single-file edit path cannot serve.
 */
function updateShell(op: PatchOpUpdate): string {
	const pairs = op.blocks.map((block) => ({ old: JSON.stringify(block.oldText), new: JSON.stringify(block.newText) }));
	const script = [
		`import pathlib`,
		`p = pathlib.Path(${JSON.stringify(op.path)})`,
		`t = p.read_text()`,
		...pairs.map((pair) => `t = t.replace(${pair.old}, ${pair.new}, 1)`),
		...(op.moveTo ? [`p.unlink()`, `p = pathlib.Path(${JSON.stringify(op.moveTo)})`] : []),
		`p.write_text(t)`,
	].join("\n");
	return `python3 - <<'OPTIMUS_PATCH_PY'\n${script}\nOPTIMUS_PATCH_PY`;
}

function countFiles(ops: PatchOp[]): number {
	return new Set(ops.map((op) => op.path)).size;
}

/**
 * Resolve an apply_patch call. Returns undefined when the name is not an
 * apply_patch dialect or the body parses to nothing usable.
 */
export function resolveApplyPatchCall(requestedName: string, args: unknown): ToolAliasResolution | undefined {
	if (!isApplyPatchCall(requestedName)) return undefined;
	const notes: string[] = [`"${requestedName}" transpiled from the Codex apply_patch dialect`];

	const input = (args ?? {}) as Record<string, unknown>;
	const body =
		(typeof input.patch === "string" && input.patch) ||
		(typeof input.input === "string" && input.input) ||
		(typeof input.diff === "string" && input.diff) ||
		"";
	for (const key of Object.keys(input)) {
		if (key !== "patch" && key !== "input" && key !== "diff") notes.push(`ignored parameter: ${key}`);
	}
	if (!body.trim()) {
		notes.push("no patch body found");
		return { name: "bash", args: { command: "true" }, ignoredArgs: [], note: notes.join("; ") };
	}

	const { ops, parseNotes } = parsePatchBody(body);
	notes.push(...parseNotes);
	if (ops.length === 0) {
		notes.push("patch produced no file operations");
		return { name: "bash", args: { command: "true" }, ignoredArgs: [], note: notes.join("; ") };
	}

	// Single-operation patches map onto the best native tool directly.
	if (ops.length === 1) {
		const op = ops[0];
		if (op.kind === "update") {
			if (op.moveTo) notes.push(`rename to "${op.moveTo}" must be applied separately (edit cannot move files)`);
			return {
				name: "edit",
				args: {
					path: op.path,
					edits: op.blocks.map((block) => ({ oldText: block.oldText, newText: block.newText })),
				},
				ignoredArgs: [],
				note: notes.join("; "),
			};
		}
		if (op.kind === "add") {
			return {
				name: "write_file",
				args: { path: op.path, content: op.content },
				ignoredArgs: [],
				note: notes.join("; "),
			};
		}
	}

	// Everything else routes through one bash call.
	const commands: string[] = [];
	for (const op of ops) {
		if (op.kind === "add") commands.push(addShell(op));
		else if (op.kind === "delete") commands.push(`rm -f ${shellQuote(op.path)}`);
		else commands.push(updateShell(op));
	}
	notes.push(
		`${countFiles(ops)} file(s) in one patch; transpiled to a shell script (single-file updates would use the edit tool directly)`,
	);
	return {
		name: "bash",
		args: { command: commands.join("\n") },
		ignoredArgs: [],
		note: notes.join("; "),
	};
}
