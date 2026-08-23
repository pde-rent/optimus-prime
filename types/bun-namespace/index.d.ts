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

	/**
	 * Only the surface the tests use: a port-0 listener with a fetch handler, and a stop.
	 * `port` is readable because callers build a URL from it.
	 */
	interface Server {
		readonly port: number;
		readonly hostname: string;
		readonly url: URL;
		stop(closeActiveConnections?: boolean): void;
	}

	interface ServeOptions {
		port?: number;
		hostname?: string;
		fetch(request: Request): Response | Promise<Response>;
	}

	function serve(options: ServeOptions): Server;

	/** Absolute path of an executable on PATH, or null. Synchronous, unlike probing via spawn. */
	function which(command: string, options?: { PATH?: string; cwd?: string }): string | null;

	// --- TCP/TLS sockets and subprocesses (net stack: src/core/net/) ---

	/** Minimal surface of a Bun outbound/inbound TCP socket. */
	interface TCPSocket {
		write(data: Uint8Array | string): number;
		end(): void;
		flush(): void;
	}

	interface SocketHandlers {
		open?(socket: TCPSocket): void;
		data?(socket: TCPSocket, data: Uint8Array): void;
		close?(socket: TCPSocket): void;
		error?(socket: TCPSocket, error: Error): void;
		drain?(socket: TCPSocket): void;
	}

	interface ConnectOptions {
		hostname: string;
		port: number;
		tls?: { rejectUnauthorized?: boolean; servername?: string };
		socket: SocketHandlers;
	}

	interface ListenOptions extends SocketHandlers {
		hostname: string;
		port?: number;
		reuseAddress?: boolean;
	}

	/**
	 * Raw TCP/TLS listener (Bun.listen). Same handle shape as serve(): readable
	 * port plus stop(); no fetch handler involved.
	 */
	function listen(options: ListenOptions): Server;

	function connect(options: ConnectOptions): Promise<TCPSocket>;

	interface SpawnOptions {
		stdin?: "ignore" | "pipe";
		stdout?: "ignore" | "pipe";
		stderr?: "ignore" | "pipe";
		cwd?: string;
		env?: Record<string, string>;
	}

	/** Minimal piped-subprocess surface used by the coding agent. */
	interface Subprocess {
		exited: Promise<number>;
		kill(signal?: number): void;
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
	}

	function spawn(argv: string[], options?: SpawnOptions): Subprocess;

	interface SpawnSyncOptions {
		stdin?: "ignore" | "pipe";
		stdout?: "pipe" | "ignore";
		stderr?: "pipe" | "ignore";
	}

	interface SyncSubprocess {
		exitCode: number;
		stdout: Uint8Array;
		stderr: Uint8Array;
	}

	function spawnSync(command: string[], options?: SpawnSyncOptions): SyncSubprocess;
}

/** `import type { Server } from "bun"` resolves to the same declarations as the global namespace. */
declare module "bun" {
	export type Server = Bun.Server;
	export type ServeOptions = Bun.ServeOptions;
}
