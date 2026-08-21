/**
 * Native extension module loader, replacing jiti.
 *
 * Bun's dynamic import already transpiles TypeScript, erases `import type`
 * without resolving the specifier, and caches by URL. The one thing jiti added
 * that Bun does not do is remap bare package specifiers (`@earendil-works/*`,
 * `typebox`, `@sinclair/*`) inside extension files to the host's own module
 * instances. This module closes that gap with a small source rewrite instead of
 * a second module loader:
 *
 * 1. Every virtual specifier is mapped to a generated shim file that re-exports
 *    the corresponding namespace from a `globalThis` registry.
 * 2. The extension's static import graph is walked, each file's bare virtual
 *    specifiers are rewritten to the shim path, and the rewritten tree is
 *    mirrored into a fresh temp directory so relative imports keep resolving.
 * 3. The rewritten entry is imported from that directory. A fresh temp dir per
 *    load, plus the URL nonce, gives the same re-read-from-disk behaviour jiti's
 *    `moduleCache: false` provided.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";

export interface VirtualModuleMap {
	[specifier: string]: unknown;
}

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"] as const;
const INDEX_BASENAMES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"] as const;

// Matches a static import, a re-export, or a dynamic import() specifier string.
// group1 = keyword (from/import), group2 = quote, group3 = specifier.
const SPECIFIER_RE = /(from\s*|import\s*(?:\(\s*|\s+))(["'"])([^"'"]*)\2/g;

let reloadNonce = 0;
let cachedShims: Map<string, string> | null = null;
let cachedVirtualModules: VirtualModuleMap | null = null;

function rewriteSource(source: string, specifierToShim: Map<string, string>): string {
	return source.replace(SPECIFIER_RE, (match, keyword, quote, specifier) => {
		const shim = specifierToShim.get(specifier);
		if (!shim) return match;
		return keyword + quote + shim + quote;
	});
}

function isDirectory(p: string): boolean {
	try {
		readFileSync(p);
		return false;
	} catch {
		return true;
	}
}

function resolveRelativeSpecifier(fromFile: string, specifier: string): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [base];
	const baseExt = extname(base);
	if (baseExt === "") {
		for (const ext of JS_EXTENSIONS) candidates.push(base + ext);
		for (const name of INDEX_BASENAMES) candidates.push(join(base, name));
	} else if (baseExt === ".js") {
		// Source is written with .js specifiers (Node16 style) but lives as .ts.
		candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
	}
	for (const candidate of candidates) {
		if (existsSync(candidate) && !isDirectory(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Make non-virtual bare specifiers (e.g. a dependency the extension ships in
 * its own node_modules) resolve from the mirrored tree exactly as they did from
 * the real tree. For every ancestor of the file, if a node_modules directory
 * exists there, symlink it into the mirrored equivalent.
 */
function mirrorNodeModules(file: string, entryDir: string, outDir: string): void {
	let dir = dirname(file);
	const stopAt = dirname(entryDir);
	while (dir !== stopAt) {
		const nm = join(dir, "node_modules");
		if (existsSync(nm)) {
			const rel = relative(entryDir, nm);
			const outLink = join(outDir, rel);
			if (!existsSync(outLink)) {
				mkdirSync(dirname(outLink), { recursive: true });
				symlinkSync(nm, outLink, "dir");
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}

interface RewriteResult {
	entryPath: string;
	unresolved: string[];
}

function rewriteGraph(entryPath: string, outDir: string, specifierToShim: Map<string, string>): RewriteResult {
	const queue = [entryPath];
	const seen = new Set<string>();
	const unresolved: string[] = [];

	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (seen.has(file)) continue;
		seen.add(file);

		const rel = relative(dirname(entryPath), file);
		const outPath = join(outDir, rel);
		mkdirSync(dirname(outPath), { recursive: true });

		const source = readFileSync(file, "utf8");
		const rewritten = rewriteSource(source, specifierToShim);
		writeFileSync(outPath, rewritten);
		mirrorNodeModules(file, dirname(entryPath), outDir);

		for (const m of source.matchAll(SPECIFIER_RE)) {
			const specifier = m[3];
			if (!specifier.startsWith(".")) continue;
			const resolved = resolveRelativeSpecifier(file, specifier);
			if (resolved && !seen.has(resolved)) queue.push(resolved);
			else if (!resolved) unresolved.push(`${file}:${specifier}`);
		}
	}

	return { entryPath: join(outDir, relative(dirname(entryPath), entryPath)), unresolved };
}

function ensureVirtualShims(virtualModules: VirtualModuleMap): Map<string, string> {
	if (cachedShims && cachedVirtualModules === virtualModules) return cachedShims;

	const shimDir = mkdtempSync(join(tmpdir(), "pi-virtual-modules-"));
	const specifierToShim = new Map<string, string>();

	for (const [specifier, namespace] of Object.entries(virtualModules)) {
		if ((typeof namespace !== "object" || namespace === null) && typeof namespace !== "function") continue;
		const keys = Object.keys(namespace as object);
		const nameLines = keys
			.filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key !== "default")
			.map((key) => `export const ${key} = __ns.${key};`);
		const shim = [
			`// @generated — virtual module shim for ${specifier}`,
			`const __ns = (globalThis as any).__piVirtualModules[${JSON.stringify(specifier)}];`,
			"export default __ns;",
			...nameLines,
		].join("\n");

		const shimPath = join(shimDir, `${specifier.replace(/[^a-zA-Z0-9]/g, "_")}.ts`);
		writeFileSync(shimPath, shim);
		specifierToShim.set(specifier, shimPath);
	}

	cachedShims = specifierToShim;
	cachedVirtualModules = virtualModules;
	return specifierToShim;
}

const REGISTRY_KEY = "__piVirtualModules";

export async function importExtensionModule(extensionPath: string, virtualModules: VirtualModuleMap): Promise<unknown> {
	// Publish the namespaces for the generated shims to read, then rewrite and
	// import from a fresh temp tree so every call re-reads from disk.
	(globalThis as Record<string, unknown>)[REGISTRY_KEY] = virtualModules;
	const outDir = mkdtempSync(join(tmpdir(), "pi-ext-"));
	const specifierToShim = ensureVirtualShims(virtualModules);
	const { entryPath, unresolved } = rewriteGraph(extensionPath, outDir, specifierToShim);

	if (unresolved.length > 0) {
		throw new Error(`Cannot resolve extension import ${unresolved[0]}`);
	}

	const url = `${entryPath}?reload=${++reloadNonce}`;
	return import(url);
}
