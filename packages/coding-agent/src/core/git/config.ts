import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Minimal git-config INI: [section], [section "subsection"], key = value,
 * # and ; comments, quoted values, implicit-true bare keys.
 * Spec: Documentation/git-config.txt (FORMATS section).
 */

interface ConfigEntry {
	section: string;
	subsection: string | null;
	key: string;
	/** "" for a bare key (git reads this as boolean true). */
	value: string;
}

function stripComment(line: string): string {
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"' && line[i - 1] !== "\\") inQuotes = !inQuotes;
		else if (!inQuotes && (ch === "#" || ch === ";")) return line.slice(0, i);
	}
	return line;
}

function unquoteValue(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('"')) return trimmed;
	let out = "";
	let inQuotes = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && i + 1 < trimmed.length) {
			const next = trimmed[++i];
			out += next === "n" ? "\n" : next === "t" ? "\t" : next;
		} else if (ch === '"') {
			inQuotes = !inQuotes;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Parse config text into ordered entries. Section and key names are lowercased; subsections are not. */
export function parseConfigText(text: string): ConfigEntry[] {
	const entries: ConfigEntry[] = [];
	let section = "";
	let subsection: string | null = null;
	for (const rawLine of text.split("\n")) {
		const line = stripComment(rawLine).trim();
		if (!line) continue;
		if (line.startsWith("[")) {
			const header = /^(?:\[([^\]^"]+)\]|\[([^\s^"]+)\s+"((?:[^"\\]|\\.)*)"\])$/.exec(line);
			if (!header) throw new Error(`malformed config section header: ${line}`);
			section = (header[1] ?? header[2]).toLowerCase();
			subsection = header[1] ? null : header[3];
			continue;
		}
		const eq = line.indexOf("=");
		const key = (eq === -1 ? line : line.slice(0, eq)).trim().toLowerCase();
		if (!key) throw new Error(`malformed config line: ${rawLine}`);
		const value = eq === -1 ? "" : unquoteValue(line.slice(eq + 1));
		entries.push({ section, subsection, key, value });
	}
	return entries;
}

export function serializeConfigText(entries: ConfigEntry[]): string {
	const lines: string[] = [];
	let current: { section: string; subsection: string | null } | null = null;
	for (const entry of entries) {
		if (!current || current.section !== entry.section || current.subsection !== entry.subsection) {
			current = { section: entry.section, subsection: entry.subsection };
			lines.push(entry.subsection === null ? `[${entry.section}]` : `[${entry.section} "${entry.subsection}"]`);
		}
		lines.push(entry.value === "" ? entry.key : `${entry.key} = ${entry.value}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Dotted lookup path, e.g. "user.name" or "remote.origin.url". */
interface ConfigPath {
	section: string;
	subsection: string | null;
	key: string;
}

function parseConfigPath(path: string): ConfigPath {
	const parts = path.split(".");
	if (parts.length < 2) throw new Error(`config path needs a section: ${path}`);
	return {
		section: parts[0].toLowerCase(),
		subsection: parts.length > 2 ? parts.slice(1, -1).join(".") : null,
		key: parts[parts.length - 1].toLowerCase(),
	};
}

function matches(entry: ConfigEntry, target: ConfigPath): boolean {
	return entry.section === target.section && entry.subsection === target.subsection && entry.key === target.key;
}

function configGetAll(entries: ConfigEntry[], path: string): string[] {
	const target = parseConfigPath(path);
	return entries.filter((entry) => matches(entry, target)).map((entry) => entry.value);
}

function configGet(entries: ConfigEntry[], path: string): string | undefined {
	const all = configGetAll(entries, path);
	return all[all.length - 1];
}

/**
 * One writable config file, optionally layered over entries from other files
 * (e.g. system/global config) that are read-only from this object's perspective.
 */
export class GitConfig {
	constructor(
		private readonly filePath: string,
		private readonly baseEntries: ConfigEntry[] = [],
		private entries: ConfigEntry[] = existsSync(filePath) ? parseConfigText(readFileSync(filePath, "utf8")) : [],
	) {}

	static loadStack(writablePath: string, readOnlyPaths: string[]): GitConfig {
		const base: ConfigEntry[] = [];
		for (const path of readOnlyPaths) {
			if (!existsSync(path)) continue;
			base.push(...parseConfigText(readFileSync(path, "utf8")));
		}
		return new GitConfig(writablePath, base);
	}

	get(path: string): string | undefined {
		return configGet([...this.baseEntries, ...this.entries], path);
	}

	getAll(path: string): string[] {
		return configGetAll([...this.baseEntries, ...this.entries], path);
	}

	/** Replace every value for the path with one value ("" writes a bare key). */
	set(path: string, value: string): void {
		const target = parseConfigPath(path);
		this.entries = this.entries.filter((entry) => !matches(entry, target));
		this.entries.push({ ...target, value });
	}

	removeSection(section: string, subsection: string | null): void {
		this.entries = this.entries.filter((entry) => entry.section !== section || entry.subsection !== subsection);
	}

	save(): void {
		writeFileSync(this.filePath, serializeConfigText(this.entries));
	}
}
