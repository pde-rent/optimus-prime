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

	interface ImageMetadata {
		width: number;
		height: number;
		format?: string;
	}

	/**
	 * Native image decode/transform/encode. Operations chain onto an instance and are applied
	 * when an encoder is awaited, so a fresh instance is needed per independent encode.
	 */
	class Image {
		constructor(data: ArrayBufferLike | Uint8Array | Blob | string);
		metadata(): Promise<ImageMetadata>;
		resize(width: number, height?: number, options?: { fit?: string }): Image;
		rotate(degrees: number): Image;
		flip(): Image;
		flop(): Image;
		png(options?: { quality?: number }): Image;
		jpeg(options?: { quality?: number }): Image;
		webp(options?: { quality?: number }): Image;
		avif(options?: { quality?: number }): Image;
		bytes(): Promise<Uint8Array>;
		buffer(): Promise<Buffer>;
		blob(): Promise<Blob>;
		dataurl(): Promise<string>;
		toBase64(): Promise<string>;
		width: number;
		height: number;
	}

	interface BunFile extends Blob {
		text(): Promise<string>;
		json(): Promise<unknown>;
		bytes(): Promise<Uint8Array>;
		arrayBuffer(): Promise<ArrayBuffer>;
		exists(): Promise<boolean>;
		readonly name?: string;
		readonly size: number;
	}

	function file(path: string | URL, options?: { type?: string }): BunFile;

	const YAML: {
		parse(input: string): unknown;
		stringify(value: unknown, replacer?: unknown, space?: string | number): string;
	};
}
