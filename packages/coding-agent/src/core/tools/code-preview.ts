const DESCRIPTOR_MAX_WIDTH = 64;

const BASH_CELL_MAGIC_PATTERN = /^((?:[ \t]*\r?\n)*)([ \t]*)%%bash\b([^\r\n]*)(\r?\n|$)/;

interface ParsedReplBashCell {
	leadingWhitespace: string;
	indent: string;
	magicArguments: string;
	lineBreak: string;
	body: string;
}

export function parseReplBashCell(code: string): ParsedReplBashCell | undefined {
	const match = BASH_CELL_MAGIC_PATTERN.exec(code);
	if (!match) {
		return undefined;
	}
	return {
		leadingWhitespace: match[1] ?? "",
		indent: match[2] ?? "",
		magicArguments: match[3] ?? "",
		lineBreak: match[4] ?? "",
		body: code.slice(match[0].length),
	};
}

const MAGIC_LINE_PATTERN = /^\s*!/;
const COMMENT_LINE_PATTERN = /^\s*#/;
const CD_PREFIX_PATTERN = /^\s*cd\s+([^&;|]+)(?:&&|;)\s*/;
const BASH_SET_PATTERN = /^\s*set\s+[-+][A-Za-z]*(?:\s+[-+]?\w+)*(?:\s+pipefail)?\s*$/;
const BASH_SETUP_PATTERN = /^(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/;
const JS_COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\/\*|\*)/;
const JS_IMPORT_PATTERN =
	/^\s*(?:import\s+[^(]|export\s+(?:\*|\{)|(?:const|let|var)\s+[^=]+=\s*require\s*\(|["']use strict["'])/;
const JS_DECORATOR_PATTERN = /^\s*@/;
const JS_DEFINITION_PATTERN =
	/^\s*(?:export\s+)?(?:(?:async\s+)?function\b|class\b|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/;
const JS_MAIN_PATTERN = /^\s*if\s*\(\s*import\.meta\.main\s*\)/;
const JS_CONTROL_PATTERN = /^\s*(?:\}\s*)?(?:if|else|for|while|do|try|catch|finally|switch)\b.*\{\s*$/;
const JS_BLOCK_CLOSE_PATTERN = /^\s*[})\]];?\s*$/;
const JS_CALL_PATTERN = /^\s*(?:await\s+)?[A-Za-z_$][\w$.]*\s*[(`]/;
const JS_LOW_SIGNAL_CALL_PATTERN =
	/^\s*(?:await\s+)?(?:console\.\w+|String|Number|Boolean|parseInt|parseFloat|JSON\.(?:parse|stringify)|Object\.(?:keys|values|entries)|Array\.from)\s*\(/;
const JS_ASSIGNMENT_CALL_PATTERN =
	/^\s*(?:(?:const|let|var)\s+)?[A-Za-z_${][\w$,:{}\s[\]]*(?:\s*:\s*[^=]+)?=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\s*[(`]/;
const JS_LOW_SIGNAL_ASSIGNMENT_CALL_PATTERN =
	/^\s*(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?(?:String|Number|Boolean|parseInt|parseFloat|JSON\.(?:parse|stringify)|Object\.(?:keys|values|entries)|Array\.from|new\s+(?:Map|Set|Array)|Bun\.file)\s*\(/;
const JS_EFFECT_CALL_PATTERN =
	/^\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.(?:write|writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|push|add|set|delete|update|append|close|commit|execute|exec|run|flush|end)\s*\(/;
const JS_LITERAL_ASSIGN_PATTERN =
	/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|-?\d[\d_.eExXoObB]*|true|false|null|undefined|\[[^\]]*\]|\{[^}]*\})\s*;?\s*$/;
const HEREDOC_PATTERN = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const JS_PATH_ASSIGN_PATTERN = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Bun\.file\(\s*["']([^"']+)["']/;
const JS_STRING_ASSIGN_PATTERN = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/;
const JS_DECLARATION_PATTERN =
	/(?:^|[^\w$.])(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*|[{[][^}\]]*[}\]])|^\s*import\s+([\s\S]*?)\s+from\b/g;
const JS_ASSIGNMENT_PREFIX_PATTERN = /^(?:(?:const|let|var)\s+)?[A-Za-z_${[][\w$,:{}\s[\]]*=(?!=)\s*/;
// Skill bindings are user-installable and the bundled set changes, so any literal list
// here rots silently: match the shape instead. Receiver is lower_snake_case because
// every binding is, while locals are camelCase and runtime namespaces are PascalCase.
const JS_CAPABILITY_CALL_PATTERN = /^(?:await\s+)?([a-z][a-z0-9_]*)\.([A-Za-z_$][\w$]*)\s*\(([\s\S]*)$/;
// Arguments before the descriptor must be plain references or numbers: refusing to look
// inside an object or array literal is what keeps `{ text: "hi" }` out of the label.
const JS_CAPABILITY_ARGUMENT_PATTERN = /^\s*(?:(?:[A-Za-z_$][\w$.]*|-?\d[\w.]*)\s*,\s*)*(["'`])([^"'`\r\n]*)\1\s*[,)]/;
// ECMAScript prototype/host names, fixed by the language rather than by what is installed.
const JS_PROTOTYPE_METHOD_PATTERN =
	/^(?:map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|some|every|includes|indexOf|lastIndexOf|slice|splice|concat|join|sort|reverse|flat|flatMap|at|push|pop|shift|unshift|fill|keys|values|entries|has|then|catch|finally|toString|toJSON|valueOf|trim|trimStart|trimEnd|split|replace|replaceAll|match|matchAll|test|startsWith|endsWith|padStart|padEnd|repeat|toUpperCase|toLowerCase|toFixed)$/;
const JS_HOST_RECEIVER_PATTERN =
	/^(?:console|process|globalThis|self|module|exports|require|crypto|performance|navigator|document|window|localStorage|sessionStorage|fetch)$/;

type CodePreviewLanguage = "bash" | "js";

interface CodePreview {
	language: CodePreviewLanguage;
	text: string;
}

interface PreviewCandidate {
	language: CodePreviewLanguage;
	text: string;
	score: number;
	index: number;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	if (text.length <= DESCRIPTOR_MAX_WIDTH) {
		return text;
	}
	return `${text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

function redactNoise(text: string): string {
	return text
		.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
		.replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(["'])[^"']*\2/gi, "$1=<redacted>")
		.replace(
			/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(?!<redacted>)(?!["'])\S+/gi,
			"$1=<redacted>",
		)
		.replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
		.replace(/(["']).{160,}\1/g, "$1…$1");
}

function descriptor(text: string): string {
	return truncateDescriptor(collapseWhitespace(redactNoise(text)));
}

function stripBashPrefix(line: string): string {
	return line.replace(MAGIC_LINE_PATTERN, "").trim().replace(CD_PREFIX_PATTERN, "").trim();
}

function isSkippableBashLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		!trimmed ||
		COMMENT_LINE_PATTERN.test(trimmed) ||
		BASH_SET_PATTERN.test(trimmed) ||
		BASH_SETUP_PATTERN.test(trimmed)
	);
}

function shellWords(line: string): string[] {
	const words: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const match of line.matchAll(pattern)) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

function pathTail(path: string): string {
	return path.replace(/^\.\//, "");
}

function simplifyRunnerCommand(line: string): string | undefined {
	const words = shellWords(line);
	const joined = words.join(" ");
	const vitestIndex = words.findIndex((word) => /(?:^|\/)vitest\/dist\/cli\.js$/.test(word));
	if (words[0] === "npx" && words[1] === "tsx" && vitestIndex >= 2) {
		return `vitest ${words.slice(vitestIndex + 1).join(" ")}`.trim();
	}
	if (words[0] === "npm") {
		const prefixIndex = words.indexOf("--prefix");
		const cwd = prefixIndex >= 0 ? words[prefixIndex + 1] : undefined;
		const runIndex = words.indexOf("run");
		if (runIndex >= 0 && words[runIndex + 1]) {
			const command = `npm ${words[runIndex + 1]} ${words.slice(runIndex + 2).join(" ")}`.trim();
			return cwd ? `${command} (${pathTail(cwd)})` : command;
		}
	}
	if (words[0] === "pnpm") {
		const cwdIndex = words.findIndex((word) => word === "-C" || word === "--dir");
		const cwd = cwdIndex >= 0 ? words[cwdIndex + 1] : undefined;
		const rest = words.filter((_, index) => index !== cwdIndex && index !== cwdIndex + 1);
		return cwd ? `${rest.join(" ")} (${pathTail(cwd)})` : undefined;
	}
	// No per-language runner branches. Special-casing one ecosystem's test command
	// means either playing favourites or maintaining a branch per language forever;
	// an unrecognised command falls through and is shown as the user typed it.
	if (words[0] === "bun" || words[0] === "bunx") {
		// `bunx` is not `bun run`; keep the verb the user typed.
		const runIndex = words[0] === "bun" ? words.indexOf("run") : -1;
		const rest = runIndex >= 0 ? words.slice(runIndex + 1) : words.slice(1);
		return rest.length > 0 ? `${words[0]} ${rest.join(" ")}`.trim() : undefined;
	}
	if (joined.includes("node_modules/.bin/")) {
		return joined.replace(/\S*node_modules\/\.bin\//g, "");
	}
	return undefined;
}

function simplifyMutationCommand(line: string): string | undefined {
	const words = shellWords(line);
	if (words.length === 0) return undefined;
	if (words[0] === "cat" && words[1] === ">" && words[2]) return `write ${pathTail(words[2])}`;
	if (words[0] === "tee" && words.at(-1))
		return `${words.includes("-a") ? "append" : "write"} ${pathTail(words.at(-1) ?? "")}`;
	if (words[0] === "apply_patch") return "apply patch";
	if (["rm", "mv", "cp", "git", "npm"].includes(words[0] ?? "")) return line;
	if (
		(words[0] === "sed" && words.some((word) => word.startsWith("-i"))) ||
		(words[0] === "perl" && words.includes("-pi"))
	) {
		return line;
	}
	return undefined;
}

function simplifyBashCommandLine(line: string): string {
	return simplifyRunnerCommand(line) ?? simplifyMutationCommand(line) ?? line;
}

function splitCommandChain(line: string): string[] {
	return line
		.split(/\s*(?:&&|;)\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function heredocBody(lines: readonly string[], startIndex: number, delimiter: string): string | undefined {
	// While args stream, preview the partial heredoc body rather than the low-signal heredoc opener.
	const body: string[] = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === delimiter) {
			return body.join("\n");
		}
		body.push(line);
	}
	return body.length > 0 ? body.join("\n") : undefined;
}

function previewHeredoc(lines: readonly string[]): CodePreview | undefined {
	// A generic heredoc body is low-signal; keep it as a fallback and prefer a
	// later, more specific heredoc (node/bash/write/patch) if one follows.
	let fallback: CodePreview | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = stripBashPrefix(lines[i] ?? "");
		if (isSkippableBashLine(line)) {
			continue;
		}
		const heredocMatch = line.match(HEREDOC_PATTERN);
		const delimiter = heredocMatch?.[1];
		if (!delimiter) {
			continue;
		}
		const body = heredocBody(lines, i, delimiter);
		if (!body) {
			continue;
		}
		// Match bun/node as an interpreter word, not a path suffix like run.node.
		if (/(?<![\w.])(?:bun|node)\b/.test(line)) {
			const preview = previewJsCode(body);
			if (preview.text) {
				return preview;
			}
			continue;
		}
		// Match bash/sh as an interpreter word (incl. /bin/sh), not a path suffix like script.sh.
		if (/(?<![\w.])(?:bash|sh)\b/.test(line)) {
			const preview = previewBashCommand(body);
			return preview.text ? preview : { language: "bash", text: descriptor(body) };
		}
		const catWrite = line.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
		if (catWrite?.[1]) {
			return { language: "bash", text: `${line.includes("tee -a") ? "append" : "write"} ${pathTail(catWrite[1])}` };
		}
		if (/\bapply_patch\b/.test(line)) {
			return { language: "bash", text: "apply patch" };
		}
		fallback ??= { language: "bash", text: descriptor(body) };
	}
	return fallback;
}

function bashLineScore(line: string, index: number): number {
	const simplified = simplifyBashCommandLine(line);
	const words = shellWords(line);
	let score = 30;
	if (simplified !== line) score += 40;
	if (["rm", "mv", "cp", "git", "npm", "pnpm", "bun", "bunx"].includes(words[0] ?? "")) score += 20;
	if (/\b(?:rm|mv|cp|git\s+(?:add|commit)|npm\s+install|sed\s+-i|perl\s+-pi|tee|cat\s*>|apply_patch)\b/.test(line))
		score += 40;
	return score + index;
}

export function previewBashCommand(command: string): CodePreview {
	const lines = command.split("\n");
	const heredoc = previewHeredoc(lines);
	if (heredoc?.text) {
		return { language: heredoc.language, text: descriptor(heredoc.text) };
	}

	let best: PreviewCandidate | undefined;
	let index = 0;
	for (const rawLine of lines) {
		for (const rawPart of splitCommandChain(rawLine)) {
			const commandLine = stripBashPrefix(rawPart.trim());
			if (!commandLine || isSkippableBashLine(commandLine)) {
				continue;
			}
			const candidate = {
				language: "bash" as const,
				text: simplifyBashCommandLine(commandLine),
				score: bashLineScore(commandLine, index),
				index,
			};
			if (!best || candidate.score > best.score) {
				best = candidate;
			}
			index += 1;
		}
	}
	return { language: "bash", text: best ? descriptor(best.text) : "" };
}

function isSkippableJsLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		!trimmed ||
		JS_COMMENT_LINE_PATTERN.test(trimmed) ||
		JS_IMPORT_PATTERN.test(trimmed) ||
		JS_BLOCK_CLOSE_PATTERN.test(trimmed)
	);
}

function jsIndent(line: string): number {
	const match = line.match(/^\s*/);
	return match?.[0].length ?? 0;
}

function stripStatementEnd(text: string): string {
	return text.trim().replace(/;$/, "");
}

function consoleLogInnerCall(line: string): string | undefined {
	const logMatch = stripStatementEnd(line).match(/^console\.(?:log|info|debug|error|warn)\((.*)\)$/);
	const inner = stripStatementEnd(logMatch?.[1] ?? "");
	return inner && JS_CALL_PATTERN.test(inner) ? inner : undefined;
}

function jsPathVars(lines: readonly string[]): Map<string, string> {
	const vars = new Map<string, string>();
	for (const line of lines) {
		const pathMatch = line.match(JS_PATH_ASSIGN_PATTERN) ?? line.match(JS_STRING_ASSIGN_PATTERN);
		if (pathMatch?.[1] && pathMatch[2]?.includes("/")) {
			vars.set(pathMatch[1], pathMatch[2]);
		}
	}
	return vars;
}

function jsLocalNames(lines: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const line of lines) {
		for (const match of line.matchAll(JS_DECLARATION_PATTERN)) {
			for (const identifier of (match[1] ?? match[2] ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) {
				names.add(identifier);
			}
		}
	}
	return names;
}

function resolvePathArgument(argument: string, paths: ReadonlyMap<string, string>): string | undefined {
	const trimmed = argument.trim();
	const literal = trimmed.match(/^["'`]([^"'`]+)["'`]$/);
	if (literal?.[1]) return literal[1];
	const identifier = trimmed.match(/^[A-Za-z_$][\w$]*$/);
	return identifier ? paths.get(trimmed) : undefined;
}

const FS_ACTIONS: Record<string, string> = {
	readFile: "read",
	readFileSync: "read",
	writeFile: "write",
	writeFileSync: "write",
	appendFile: "append",
	appendFileSync: "append",
	mkdir: "mkdir",
	mkdirSync: "mkdir",
	unlink: "delete",
	unlinkSync: "delete",
	rm: "delete",
	rmSync: "delete",
	rmdir: "delete",
	rmdirSync: "delete",
	rename: "rename",
	renameSync: "rename",
	copyFile: "copy",
	copyFileSync: "copy",
	stat: "stat",
	statSync: "stat",
};

const BUN_FILE_READS: Record<string, string> = {
	text: "read",
	json: "read",
	bytes: "read",
	arrayBuffer: "read",
	stream: "read",
	exists: "check",
};

function jsFileOperation(line: string, paths: ReadonlyMap<string, string>): string | undefined {
	const trimmed = stripStatementEnd(line);

	// Bun.file(path).text() / .json() / .bytes()
	const bunFile = trimmed.match(/Bun\.file\(\s*([^,)]+?)\s*[,)][\s\S]*?\.(\w+)\s*\(/);
	if (bunFile?.[1] && bunFile[2]) {
		const path = resolvePathArgument(bunFile[1], paths);
		const action = BUN_FILE_READS[bunFile[2]];
		if (path && action) return `${action} ${pathTail(path)}`;
	}

	// Bun.write(path, ...)
	const bunWrite = trimmed.match(/Bun\.write\(\s*([^,)]+)/);
	if (bunWrite?.[1]) {
		const path = resolvePathArgument(bunWrite[1].replace(/^Bun\.file\(\s*/, "").replace(/\)$/, ""), paths);
		if (path) return `write ${pathTail(path)}`;
	}

	// fs.readFileSync(path) / writeFile(path, ...) / mkdir(path) / ...
	const fsCall = trimmed.match(/(?:^|[\s=(])(?:[A-Za-z_$][\w$.]*\.)?(\w+)\(\s*([^,)]+)/);
	if (fsCall?.[1] && fsCall[2]) {
		const action = FS_ACTIONS[fsCall[1]];
		const path = resolvePathArgument(fsCall[2], paths);
		if (action && path) return `${action} ${pathTail(path)}`;
	}

	// read(path) / write(path, content) repl globals
	// Lookbehind, not a word boundary: `obj.read(x)` is somebody else's method, and
	// the branch runs after the fs helpers so `writeFileSync(dst, read(src))` stays a write.
	const replFileCall = trimmed.match(/(?<![\w$.])(read|write)\s*\(\s*([^,)]+)/);
	if (replFileCall?.[1] && replFileCall[2]) {
		const path = resolvePathArgument(replFileCall[2], paths);
		if (path) return `${replFileCall[1]} ${pathTail(path)}`;
	}

	// await import(path)
	const dynamicImport = trimmed.match(/\bimport\(\s*([^)]+)\)/);
	if (dynamicImport?.[1]) {
		const path = resolvePathArgument(dynamicImport[1], paths);
		if (path) return `import ${pathTail(path)}`;
	}

	// path-var method call: file.text(), handle.write(...)
	const methodCall = trimmed.match(/^(?:await\s+)?([A-Za-z_$][\w$]*)\.(\w+)\s*\(/);
	if (methodCall?.[1] && methodCall[2]) {
		const path = paths.get(methodCall[1]);
		const action = BUN_FILE_READS[methodCall[2]] ?? (methodCall[2] === "write" ? "write" : undefined);
		if (path && action) return `${action} ${pathTail(path)}`;
	}
	return undefined;
}

function jsSubprocessCommand(line: string): string | undefined {
	const trimmed = stripStatementEnd(line);

	// Bun.$`cmd` or $`cmd`
	const shellTemplate = trimmed.match(/(?:^|[\s=(])(?:Bun\.)?\$`([^`]+)`/);
	if (shellTemplate?.[1]) return simplifyBashCommandLine(shellTemplate[1].replace(/\$\{[^}]*\}/g, "…").trim());

	// Bun.spawn([...]) / spawnSync([...]) / execFile("cmd", [...]) / spawn("cmd", [...])
	const listMatch = trimmed.match(
		/(?:Bun\.)?(?:spawn|spawnSync|execFile|execFileSync|execa)\(\s*(?:\{\s*cmd\s*:\s*)?\[([^\]]+)\]/,
	);
	if (listMatch?.[1]) {
		const words = [...listMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1] ?? "");
		if (words.length > 0) return simplifyBashCommandLine(words.join(" "));
	}

	// execSync("cmd") / exec("cmd") / spawn("cmd", [args])
	const stringMatch = trimmed.match(
		/(?:^|[\s=(])(?:child_process\.)?(?:execSync|exec|spawn|spawnSync)\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*\[([^\]]*)\])?/,
	);
	if (stringMatch?.[1]) {
		const args = [...(stringMatch[2] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1] ?? "");
		return simplifyBashCommandLine([stringMatch[1], ...args].join(" ").trim());
	}
	return undefined;
}

function jsCapabilityCall(line: string, locals: ReadonlySet<string>): string | undefined {
	const call = stripStatementEnd(line).replace(JS_ASSIGNMENT_PREFIX_PATTERN, "").match(JS_CAPABILITY_CALL_PATTERN);
	const receiver = call?.[1];
	const method = call?.[2];
	if (!receiver || !method) return undefined;
	// A receiver declared in this cell is the user's own object, whatever it is named.
	if (locals.has(receiver) || JS_HOST_RECEIVER_PATTERN.test(receiver) || JS_PROTOTYPE_METHOD_PATTERN.test(method)) {
		return undefined;
	}
	const label = `${receiver}.${method}`;
	const argument = (call[3] ?? "").match(JS_CAPABILITY_ARGUMENT_PATTERN)?.[2]?.replace(/\$\{[^}]*\}/g, "…");
	if (!argument) return label;
	// Quote only when the value would otherwise read as two arguments; descriptor()
	// trims the tail, so the label itself always survives a long one.
	return `${label} ${/\s/.test(argument) ? `"${argument}"` : argument}`;
}

function simplifyJsPreviewLine(line: string, paths: ReadonlyMap<string, string>, locals: ReadonlySet<string>): string {
	return (
		jsSubprocessCommand(line) ??
		jsFileOperation(line, paths) ??
		jsCapabilityCall(line, locals) ??
		consoleLogInnerCall(line) ??
		stripStatementEnd(line)
	);
}

function firstJsChildLine(lines: readonly string[], parentIndex: number): number | undefined {
	const parentIndent = jsIndent(lines[parentIndex] ?? "");
	for (let i = parentIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isSkippableJsLine(line) || JS_DECORATOR_PATTERN.test(line.trim())) {
			continue;
		}
		if (jsIndent(line) <= parentIndent) {
			return undefined;
		}
		return i;
	}
	return undefined;
}

function jsPreviewLine(
	lines: readonly string[],
	index: number,
	paths: ReadonlyMap<string, string>,
	locals: ReadonlySet<string>,
): string {
	const line = lines[index] ?? "";
	if (index > 0 && JS_DEFINITION_PATTERN.test(line)) {
		const previous = lines[index - 1] ?? "";
		if (JS_DECORATOR_PATTERN.test(previous.trim())) {
			return `${previous.trim()} ${line.trim()}`;
		}
	}
	if (JS_CONTROL_PATTERN.test(line)) {
		const childIndex = firstJsChildLine(lines, index);
		if (childIndex !== undefined) {
			return `${line.trim()} ${simplifyJsPreviewLine(lines[childIndex] ?? "", paths, locals)}`;
		}
	}
	return simplifyJsPreviewLine(line, paths, locals);
}

function jsLineScore(
	lines: readonly string[],
	index: number,
	paths: ReadonlyMap<string, string>,
	locals: ReadonlySet<string>,
): number {
	const line = lines[index] ?? "";
	const trimmed = line.trim();
	if (isSkippableJsLine(line) || JS_DECORATOR_PATTERN.test(trimmed)) {
		return -1;
	}
	const fileOperation = jsFileOperation(line, paths);
	if (fileOperation) {
		// Mutations outrank reads: a write is the more interesting half of a
		// read-modify-write cell.
		return /^(?:read|check|stat|import) /.test(fileOperation) ? 85 : 95;
	}
	if (jsSubprocessCommand(line)) {
		return 90;
	}
	// Between a file read and a subprocess: calling a capability is the point of such a
	// cell, but a cell that also writes a file is best labelled by the write.
	if (jsCapabilityCall(line, locals)) {
		return 88;
	}
	if (JS_MAIN_PATTERN.test(line)) {
		return 70;
	}
	if (JS_EFFECT_CALL_PATTERN.test(line)) {
		return 80;
	}
	if (JS_DEFINITION_PATTERN.test(line)) {
		return 50;
	}
	if (JS_CONTROL_PATTERN.test(line)) {
		const childIndex = firstJsChildLine(lines, index);
		return childIndex === undefined ? 20 : Math.max(20, jsLineScore(lines, childIndex, paths, locals) - 5);
	}
	if (JS_LOW_SIGNAL_ASSIGNMENT_CALL_PATTERN.test(line)) {
		return 25;
	}
	if (JS_LITERAL_ASSIGN_PATTERN.test(trimmed)) {
		return 20;
	}
	const logInnerCall = consoleLogInnerCall(line);
	if (logInnerCall && !JS_LOW_SIGNAL_CALL_PATTERN.test(logInnerCall)) {
		return 55;
	}
	if (JS_ASSIGNMENT_CALL_PATTERN.test(line)) {
		return 60;
	}
	if (JS_CALL_PATTERN.test(line) && !JS_LOW_SIGNAL_CALL_PATTERN.test(line)) {
		return 65;
	}
	if (JS_CALL_PATTERN.test(line)) {
		return 15;
	}
	return 30;
}

function jsPreviewIndex(lines: readonly string[], index: number): number {
	const line = lines[index] ?? "";
	if (!JS_CONTROL_PATTERN.test(line)) {
		return index;
	}
	const childIndex = firstJsChildLine(lines, index);
	return childIndex === undefined ? index : jsPreviewIndex(lines, childIndex);
}

export function previewJsCode(code: string): CodePreview {
	const lines = code.split("\n");
	const paths = jsPathVars(lines);
	const locals = jsLocalNames(lines);
	let bestIndex: number | undefined;
	let bestScore = -1;

	for (let i = 0; i < lines.length; i++) {
		const score = jsLineScore(lines, i, paths, locals);
		if (score > bestScore) {
			bestIndex = i;
			bestScore = score;
		}
	}

	if (bestIndex !== undefined && bestScore >= 0) {
		const previewIndex = jsPreviewIndex(lines, bestIndex);
		return {
			language: "js",
			text: descriptor(jsPreviewLine(lines, previewIndex, paths, locals)),
		};
	}
	return { language: "js", text: "" };
}

export function previewReplCode(code: string): CodePreview {
	const trimmedCode = code.trimEnd();
	const bashCell = parseReplBashCell(trimmedCode);
	if (bashCell) {
		return previewBashCommand(bashCell.body);
	}
	return previewJsCode(trimmedCode);
}
