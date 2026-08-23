/**
 * Syntax highlighting over `@speed-highlight/core`'s language definitions.
 *
 * The package's own `highlightText` is async — it imports each language on demand — and emits a
 * fixed ANSI palette. Both are wrong for this call site: `highlightCode` runs inside a
 * synchronous render pass, and colours have to come from the active theme. The language
 * definitions are plain data (regex rules), so they are imported statically here and walked by
 * the small synchronous tokenizer below, which is a port of the package's matching loop.
 *
 * This replaced cli-highlight, which pulled all of highlight.js for a ~350ms import.
 */

import asm from "@speed-highlight/core/languages/asm.js";
import bash from "@speed-highlight/core/languages/bash.js";
import c from "@speed-highlight/core/languages/c.js";
import css from "@speed-highlight/core/languages/css.js";
import csv from "@speed-highlight/core/languages/csv.js";
import diff from "@speed-highlight/core/languages/diff.js";
import docker from "@speed-highlight/core/languages/docker.js";
import git from "@speed-highlight/core/languages/git.js";
import go from "@speed-highlight/core/languages/go.js";
import html from "@speed-highlight/core/languages/html.js";
import http from "@speed-highlight/core/languages/http.js";
import ini from "@speed-highlight/core/languages/ini.js";
import java from "@speed-highlight/core/languages/java.js";
import js from "@speed-highlight/core/languages/js.js";
import jsTemplateLiterals, {
	type as jsTemplateLiteralsType,
} from "@speed-highlight/core/languages/js_template_literals.js";
import jsdoc, { type as jsdocType } from "@speed-highlight/core/languages/jsdoc.js";
import json from "@speed-highlight/core/languages/json.js";
import log from "@speed-highlight/core/languages/log.js";
import lua from "@speed-highlight/core/languages/lua.js";
import make from "@speed-highlight/core/languages/make.js";
import md from "@speed-highlight/core/languages/md.js";
import pl from "@speed-highlight/core/languages/pl.js";
import plain from "@speed-highlight/core/languages/plain.js";
import py from "@speed-highlight/core/languages/py.js";
import regex, { type as regexType } from "@speed-highlight/core/languages/regex.js";
import rs from "@speed-highlight/core/languages/rs.js";
import sql from "@speed-highlight/core/languages/sql.js";
import todo, { type as todoType } from "@speed-highlight/core/languages/todo.js";
import toml from "@speed-highlight/core/languages/toml.js";
import ts from "@speed-highlight/core/languages/ts.js";
import uri from "@speed-highlight/core/languages/uri.js";
import xml from "@speed-highlight/core/languages/xml.js";
import yaml from "@speed-highlight/core/languages/yaml.js";
import { cpp, csharp, kotlin, php, ruby, scala, solidity, swift, zig } from "./extra-languages.js";

/** A rule's payload: a regex to match plus optional nested rules for the matched text. */
interface Rule {
	type?: string;
	match?: RegExp | { exec(input: string): RegExpExecArray | null; lastIndex: number };
	sub?: string | Rule[] | ((match: string) => Rule | string);
	expand?: string;
}

interface Language {
	rules: Rule[];
	/**
	 * Token type applied to text this language does not otherwise match.
	 *
	 * Some languages exist only to decorate a region another language delegated to them — the
	 * `todo` rules run inside a comment, so everything they leave unmatched is still comment
	 * text. The package ships that as a separate named export, and dropping it left comments
	 * uncoloured.
	 */
	type?: string;
}

const lang = (rules: unknown, type?: string): Language => ({ rules: rules as Rule[], type });

const LANGUAGES: Record<string, Language> = {
	asm: lang(asm),
	bash: lang(bash),
	c: lang(c),
	css: lang(css),
	csv: lang(csv),
	diff: lang(diff),
	docker: lang(docker),
	git: lang(git),
	go: lang(go),
	html: lang(html),
	http: lang(http),
	ini: lang(ini),
	java: lang(java),
	js: lang(js),
	js_template_literals: lang(jsTemplateLiterals, jsTemplateLiteralsType),
	jsdoc: lang(jsdoc, jsdocType),
	json: lang(json),
	log: lang(log),
	lua: lang(lua),
	make: lang(make),
	md: lang(md),
	pl: lang(pl),
	plain: lang(plain),
	py: lang(py),
	regex: lang(regex, regexType),
	rs: lang(rs),
	sql: lang(sql),
	todo: lang(todo, todoType),
	toml: lang(toml),
	ts: lang(ts),
	uri: lang(uri),
	xml: lang(xml),
	yaml: lang(yaml),
	// Languages the package does not ship; see extra-languages.ts.
	cpp: lang(cpp),
	cs: lang(csharp),
	kt: lang(kotlin),
	php: lang(php),
	rb: lang(ruby),
	scala: lang(scala),
	sol: lang(solidity),
	swift: lang(swift),
	zig: lang(zig),
};

/** Shorthands the rules reference by name instead of repeating the pattern. */
const EXPANSIONS: Record<string, Rule> = {
	num: { type: "num", match: /(\.e?|\b)\d(e-|[\d.oxa-fA-F_])*(\.|\b)/g },
	str: { type: "str", match: /(["'])(\\[\s\S]|(?!\1)[^\r\n\\])*\1?/g },
	strDouble: { type: "str", match: /"((?!")[^\r\n\\]|\\[\s\S])*"?/g },
};

/** Aliases for names this codebase and markdown fences use that the package spells differently. */
const ALIASES: Record<string, string> = {
	javascript: "js",
	typescript: "ts",
	jsx: "js",
	tsx: "ts",
	python: "py",
	rust: "rs",
	shell: "bash",
	sh: "bash",
	zsh: "bash",
	markdown: "md",
	dockerfile: "docker",
	perl: "pl",
	golang: "go",
	yml: "yaml",
	text: "plain",
	txt: "plain",
	"c++": "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	csharp: "cs",
	kotlin: "kt",
	kts: "kt",
	ruby: "rb",
	solidity: "sol",
	sc: "scala",
};

function resolveLanguage(name: string): string | undefined {
	const key = name.toLowerCase();
	const resolved = ALIASES[key] ?? key;
	return resolved in LANGUAGES ? resolved : undefined;
}

export function supportsLanguage(name: string): boolean {
	return resolveLanguage(name) !== undefined;
}

/** Colour a token by its type; unknown types are emitted uncoloured. */
export type TokenPainter = (text: string, type: string | undefined) => string;

/**
 * Walk `src` against a language's rules, calling `emit` for every token.
 *
 * A synchronous port of the package's matcher: at each position every rule is advanced to its
 * next match, the earliest one wins, and a rule carrying `sub` recurses into the matched text.
 * Rules whose regex no longer matches are dropped so they are not retried for the rest of the
 * input.
 */
function tokenize(src: string, language: Language, emit: (text: string, type?: string) => void): void {
	const rules = [...language.rules];
	const parentType = language.type;
	const cache: Array<{ match: RegExpExecArray; lastIndex: number } | undefined> = [];
	let position = 0;

	while (position < src.length) {
		let best: { rule: Rule; index: number; text: string; end: number } | undefined;
		for (let i = rules.length - 1; i >= 0; i--) {
			const rule = rules[i].expand ? EXPANSIONS[rules[i].expand as string] : rules[i];
			const matcher = rule?.match;
			if (!matcher) {
				rules.splice(i, 1);
				cache.splice(i, 1);
				continue;
			}
			const cached = cache[i];
			if (cached === undefined || cached.match.index < position) {
				matcher.lastIndex = position;
				const found = matcher.exec(src);
				if (found === null) {
					rules.splice(i, 1);
					cache.splice(i, 1);
					continue;
				}
				cache[i] = { match: found, lastIndex: matcher.lastIndex };
			}
			const entry = cache[i];
			if (!entry?.match[0]) continue;
			if (best === undefined || entry.match.index <= best.index) {
				best = { rule, index: entry.match.index, text: entry.match[0], end: entry.lastIndex };
			}
		}
		if (!best) break;

		emit(src.slice(position, best.index), parentType);
		position = best.end;

		const sub = best.rule.sub;
		if (sub) {
			const resolved = typeof sub === "function" ? sub(best.text) : sub;
			const nested =
				typeof resolved === "string"
					? LANGUAGES[resolved]
					: Array.isArray(resolved)
						? lang(resolved)
						: resolved && typeof resolved === "object"
							? lang((resolved as Rule).sub ?? [], (resolved as Rule).type)
							: undefined;
			if (nested) {
				tokenize(best.text, nested, emit);
				continue;
			}
		}
		emit(best.text, best.rule.type);
	}
	emit(src.slice(position), parentType);
}

/**
 * Highlight `code` as `language`, painting each token with `paint`.
 *
 * Returns the input unchanged when the language is unknown, so callers can pass a fence
 * language straight through without pre-validating it.
 */
export function highlight(code: string, language: string, paint: TokenPainter): string {
	const resolved = resolveLanguage(language);
	if (!resolved) return code;
	let out = "";
	try {
		tokenize(code, LANGUAGES[resolved], (text, type) => {
			if (text) out += paint(text, type);
		});
	} catch {
		// A malformed rule or pathological input must not take the render down.
		return code;
	}
	return out;
}
