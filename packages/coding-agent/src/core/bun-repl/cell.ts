/**
 * Minimal cell parser for the Bun REPL.
 *
 * A cell is `%%bash ...` (shell, routed to Bun.spawn) or a plain JS/TS block
 * (routed to the vm). `%%js` is accepted as an explicit alias for JS.
 */

const BASH_CELL_MAGIC = /^((?:[ \t]*\r?\n)*)([ \t]*)(%%bash|%%js)\b([^\r\n]*)(\r?\n|$)/;

export interface ParsedCell {
	kind: "bash" | "js";
	leadingWhitespace: string;
	indent: string;
	magic: string;
	/** Arguments after the magic on the first line (e.g. shell flags); only meaningful for bash. */
	magicArguments: string;
	lineBreak: string;
	/** The cell body after the magic line. */
	body: string;
}

export function parseCell(code: string): ParsedCell {
	const m = BASH_CELL_MAGIC.exec(code);
	if (!m) {
		// Plain JS/TS cell.
		return {
			kind: "js",
			leadingWhitespace: "",
			indent: "",
			magic: "",
			magicArguments: "",
			lineBreak: "\n",
			body: code,
		};
	}
	const magic = m[3] as "%%bash" | "%%js";
	return {
		kind: magic === "%%bash" ? "bash" : "js",
		leadingWhitespace: m[1] ?? "",
		indent: m[2] ?? "",
		magic,
		magicArguments: m[4] ?? "",
		lineBreak: m[5] ?? "\n",
		body: code.slice(m[0].length),
	};
}

/** Sort the body of a bash cell into a shell command (discarding the "raw" prefix niceties). */
export function bashCommand(body: string): string {
	return body.trimEnd();
}
