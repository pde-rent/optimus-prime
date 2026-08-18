/**
 * Ambient types for the `Bun` global namespace.
 *
 * Same reasoning as `bun-test.d.ts`: adding `"bun"` to the `types` field would also replace the
 * global `fetch`, `ReadableStream` and `bun:test` declarations repo-wide, which conflicts with
 * @types/node and with the Vitest-compat helpers the preload installs. This declares exactly
 * the surface the source uses; extend it as more of the API is adopted.
 */
declare namespace Bun {
	interface GlobScanOptions {
		cwd?: string;
		absolute?: boolean;
		dot?: boolean;
		onlyFiles?: boolean;
		followSymlinks?: boolean;
	}

	class Glob {
		constructor(pattern: string);
		match(path: string): boolean;
		scan(options?: GlobScanOptions | string): AsyncIterableIterator<string>;
		scanSync(options?: GlobScanOptions | string): IterableIterator<string>;
	}

	class Transpiler {
		constructor(options?: { loader?: string });
		transformSync(code: string): string;
	}

	const YAML: {
		parse(input: string): unknown;
		stringify(value: unknown, replacer?: unknown, space?: string | number): string;
	};
}
