/**
 * Shared network primitives for the net stack (docs/net-stack-spec.md §2).
 *
 * Every TCP protocol module (FTP, SMTP, IMAP) is built from the pieces in this
 * file; nothing else in the net stack opens a socket. Zero npm dependencies:
 * implicit TLS uses Bun.connect; plaintext sockets that upgrade mid-stream
 * (STARTTLS / AUTH TLS) use node:net + node:tls - the only place those appear.
 */

import { connect as netConnect, type Socket as RawSocket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

// ---------------------------------------------------------------------------
// Errors (§2.5)
// ---------------------------------------------------------------------------

export type NetErrorCode = "NET_CONNECT" | "NET_AUTH" | "NET_PROTOCOL" | "NET_TIMEOUT" | "NET_ABORTED";

export class NetError extends Error {
	readonly code: NetErrorCode;
	constructor(code: NetErrorCode, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

/** TCP/TLS connection could not be established. */
export class NetConnectError extends NetError {
	constructor(message: string) {
		super("NET_CONNECT", message);
	}
}

/** Credentials rejected by the server. Never echoes the secret. */
export class NetAuthError extends NetError {
	constructor(message: string) {
		super("NET_AUTH", message);
	}
}

/** Unexpected server reply. Always carries the verbatim reply line(s). */
export class NetProtocolError extends NetError {
	/** Verbatim server reply line(s), exactly as received. */
	readonly reply: string;
	constructor(message: string, reply: string) {
		super("NET_PROTOCOL", `${message} Server replied: ${reply}`);
		this.reply = reply;
	}
}

/** A read deadline expired. The socket has been destroyed. */
export class NetTimeoutError extends NetError {
	constructor(message: string) {
		super("NET_TIMEOUT", message);
	}
}

/** The caller's AbortSignal fired. The socket has been destroyed. */
export class NetAbortedError extends NetError {
	constructor(message = "Operation aborted") {
		super("NET_ABORTED", message);
	}
}

// ---------------------------------------------------------------------------
// tcpConnect (§2.1)
// ---------------------------------------------------------------------------

export interface TlsOptions {
	/** Default true. An explicit opt-out is surfaced via insecureByRequest, never silent. */
	rejectUnauthorized?: boolean;
}

export interface TcpConnectOptions {
	host: string;
	port: number;
	/** Implicit TLS from the first byte (SMTPS 465, IMAPS 993, FTPS 990). */
	tls?: boolean | TlsOptions;
	/** Default 10_000 ms. */
	connectTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface ReadOptions {
	/** Deadline in ms; on expiry the socket is destroyed and NetTimeoutError thrown. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Wait until at least this many bytes are buffered (default 1). */
	atLeast?: number;
}

export interface WriteOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface NetConnection {
	readonly host: string;
	readonly port: number;
	/** True once the byte stream is TLS-encrypted (implicit or after upgradeTls). */
	readonly secure: boolean;
	/** True when the caller explicitly disabled certificate verification. */
	readonly insecureByRequest: boolean;
	/**
	 * Read from the socket into buf. Resolves with the number of bytes written
	 * into buf (0 = clean EOF). Waits for atLeast bytes unless EOF arrives first.
	 */
	read(buf: Uint8Array, opts?: ReadOptions): Promise<number>;
	write(data: Uint8Array | string, opts?: WriteOptions): Promise<void>;
	/** Graceful close (FIN). */
	close(): Promise<void>;
	/** Hard close; unblocks pending readers with EOF. */
	destroy(): void;
	/** STARTTLS: wrap the plaintext socket with TLS mid-stream. */
	upgradeTls(options?: TlsOptions): Promise<void>;
}

/** Single-reader byte queue fed by socket data events. */
class ByteQueue {
	private chunks: Buffer[] = [];
	private queued = 0;
	private eofSeen = false;
	private waiter?: { wake: () => void };

	get size(): number {
		return this.queued;
	}

	get eof(): boolean {
		return this.eofSeen;
	}

	push(data: Uint8Array): void {
		if (data.length === 0) return;
		this.chunks.push(Buffer.from(data));
		this.queued += data.length;
		this.wake();
	}

	end(): void {
		this.eofSeen = true;
		this.wake();
	}

	/** Take up to max bytes; null when fewer than atLeast bytes are buffered. */
	take(max: number, atLeast: number): Buffer | null {
		if (this.queued < atLeast && !this.eofSeen) return null;
		const want = Math.min(max, this.queued);
		if (want === 0) return Buffer.alloc(0);
		const parts: Buffer[] = [];
		let got = 0;
		while (got < want) {
			const chunk = this.chunks[0];
			const need = want - got;
			if (chunk.length <= need) {
				parts.push(chunk);
				got += chunk.length;
				this.chunks.shift();
			} else {
				parts.push(Buffer.from(chunk.subarray(0, need)));
				this.chunks[0] = chunk.subarray(need);
				got = want;
			}
		}
		this.queued -= got;
		return Buffer.concat(parts);
	}

	/** Resolves on the next push() or end(); immediate when data is already queued. */
	waitFor(need: number): Promise<void> {
		if (this.queued >= need || this.eofSeen) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.waiter = { wake: resolve };
		});
	}

	private wake(): void {
		const waiter = this.waiter;
		if (!waiter) return;
		this.waiter = undefined;
		waiter.wake();
	}
}

abstract class BaseConnection implements NetConnection {
	readonly host: string;
	readonly port: number;
	secure: boolean;
	abstract readonly insecureByRequest: boolean;
	protected readonly queue = new ByteQueue();

	constructor(host: string, port: number, secure: boolean) {
		this.host = host;
		this.port = port;
		this.secure = secure;
	}

	/** Internal - wired up by tcpConnect(); pushes peer bytes into the read queue. */
	handleData = (data: Uint8Array): void => {
		this.queue.push(data);
	};

	/** Internal - wired up by tcpConnect(); signals EOF to pending readers. */
	handleEnd = (): void => {
		this.queue.end();
	};

	async read(buf: Uint8Array, opts?: ReadOptions): Promise<number> {
		const atLeast = Math.max(1, Math.min(opts?.atLeast ?? 1, buf.length));
		for (;;) {
			throwIfAborted(opts?.signal, this);
			const taken = this.queue.take(buf.length, atLeast);
			if (taken !== null) {
				buf.set(taken);
				return taken.length;
			}
			await this.awaitData(atLeast, opts);
		}
	}

	async write(data: Uint8Array | string, opts?: WriteOptions): Promise<void> {
		throwIfAborted(opts?.signal, this);
		this.rawWrite(data);
	}

	async close(): Promise<void> {
		this.rawEnd();
	}

	destroy(): void {
		this.rawDestroy();
		this.queue.end();
	}

	async upgradeTls(_options?: TlsOptions): Promise<void> {
		throw new NetProtocolError("This connection cannot be upgraded to TLS.", "");
	}

	protected abstract rawWrite(data: Uint8Array | string): void;
	protected abstract rawEnd(): void;
	protected abstract rawDestroy(): void;

	private async awaitData(need: number, opts?: ReadOptions): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				const signal = opts?.signal;
				if (opts?.timeoutMs !== undefined) {
					timer = setTimeout(
						() =>
							reject(
								new NetTimeoutError(
									`Timed out after ${opts.timeoutMs}ms waiting for ${this.host}:${this.port}.`,
								),
							),
						opts.timeoutMs,
					);
				}
				if (signal) {
					onAbort = () => reject(new NetAbortedError());
					signal.addEventListener("abort", onAbort, { once: true });
				}
				this.queue.waitFor(need).then(resolve, resolve);
			});
		} catch (error: unknown) {
			this.destroy();
			throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort && opts?.signal) opts.signal.removeEventListener("abort", onAbort);
		}
	}
}

/** Bun native socket path (implicit TLS). Cannot STARTTLS. */
class BunSocketConnection extends BaseConnection {
	readonly insecureByRequest: boolean;
	private readonly socket: Bun.TCPSocket;

	constructor(host: string, port: number, socket: Bun.TCPSocket, insecureByRequest: boolean) {
		super(host, port, true);
		this.socket = socket;
		this.insecureByRequest = insecureByRequest;
	}

	protected rawWrite(data: Uint8Array | string): void {
		this.socket.write(data);
		this.socket.flush();
	}

	protected rawEnd(): void {
		this.socket.end();
	}

	protected rawDestroy(): void {
		try {
			this.socket.end();
		} catch {
			// Already gone.
		}
	}
}

/** node:net path; supports mid-stream STARTTLS via upgradeTls(). */
class NodeSocketConnection extends BaseConnection {
	readonly insecureByRequest = false;
	private stream: RawSocket | TLSSocket;

	constructor(host: string, port: number, socket: RawSocket) {
		super(host, port, false);
		this.stream = socket;
	}

	protected rawWrite(data: Uint8Array | string): void {
		this.stream.write(data);
	}

	protected rawEnd(): void {
		this.stream.end();
	}

	protected rawDestroy(): void {
		this.stream.destroy();
	}

	override async upgradeTls(options?: TlsOptions): Promise<void> {
		if (this.secure) throw new NetProtocolError("Connection is already TLS.", "");
		const plain = this.stream as RawSocket;
		plain.removeAllListeners("data");
		plain.removeAllListeners("end");
		plain.removeAllListeners("close");
		const upgraded: TLSSocket = await new Promise<TLSSocket>((resolve, reject) => {
			const options_ = {
				socket: plain,
				servername: isIpAddress(this.host) ? undefined : this.host,
				rejectUnauthorized: options?.rejectUnauthorized ?? true,
				handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
			};
			const socket = (tlsConnect as unknown as (opts: typeof options_, cb: () => void) => TLSSocket)(options_, () =>
				resolve(socket),
			);
			socket.once("error", reject);
		});
		upgraded.once("error", () => this.handleEnd());
		upgraded.on("data", this.handleData);
		upgraded.on("end", this.handleEnd);
		upgraded.on("close", this.handleEnd);
		this.stream = upgraded;
		this.secure = true;
	}
}

/**
 * Open a TCP (optionally TLS) connection. Implicit TLS goes through
 * Bun.connect in one call; plaintext that will upgrade later goes through
 * node:net so startTLS can wrap the raw socket.
 */
export async function tcpConnect(options: TcpConnectOptions): Promise<NetConnection> {
	const tlsOpt = options.tls;
	const wantTls = tlsOpt === true || (typeof tlsOpt === "object" && tlsOpt !== null);
	const rejectUnauthorized = wantTls && typeof tlsOpt === "object" ? (tlsOpt.rejectUnauthorized ?? true) : true;
	if (options.signal?.aborted) throw new NetAbortedError();

	const bunHolder: { conn?: BunSocketConnection } = {};
	const attempt: Promise<Bun.TCPSocket | RawSocket> = wantTls
		? Bun.connect({
				hostname: options.host,
				port: options.port,
				tls: { rejectUnauthorized, servername: options.host },
				socket: {
					data: (_socket, data) => bunHolder.conn?.handleData(data),
					close: () => bunHolder.conn?.handleEnd(),
					error: () => bunHolder.conn?.handleEnd(),
				},
			})
		: new Promise<RawSocket>((resolve, reject) => {
				const socket = netConnect({ host: options.host, port: options.port }, () => resolve(socket));
				socket.once("error", reject);
			});

	try {
		const socket = await raceDeadline(attempt, options.connectTimeoutMs ?? 10_000, options.host, options.port);
		if (wantTls) {
			bunHolder.conn = new BunSocketConnection(
				options.host,
				options.port,
				socket as Bun.TCPSocket,
				!rejectUnauthorized,
			);
			return bunHolder.conn;
		}
		const raw = socket as RawSocket;
		const conn = new NodeSocketConnection(options.host, options.port, raw);
		raw.on("data", (data: Buffer) => conn.handleData(data));
		raw.on("end", () => conn.handleEnd());
		raw.on("close", () => conn.handleEnd());
		return conn;
	} catch (error: unknown) {
		if (error instanceof NetError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new NetConnectError(`Could not connect to ${options.host}:${options.port}. ${message}`);
	}
}

async function raceDeadline<T>(promise: Promise<T>, timeoutMs: number, host: string, port: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new NetConnectError(`Could not connect to ${host}:${port} within ${timeoutMs}ms.`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function throwIfAborted(signal: AbortSignal | undefined, conn?: BaseConnection): void {
	if (signal?.aborted) {
		conn?.destroy();
		throw new NetAbortedError();
	}
}

// ---------------------------------------------------------------------------
// LineProtocol (§2.2)
// ---------------------------------------------------------------------------

const SCRATCH_BYTES = 8192;

export class LineProtocol {
	private readonly conn: NetConnection;
	private pending: Buffer = Buffer.alloc(0);

	constructor(conn: NetConnection) {
		this.conn = conn;
	}

	get connection(): NetConnection {
		return this.conn;
	}

	/** Read one CRLF- (or bare-LF-) terminated line, terminator stripped. */
	async readLine(opts?: ReadOptions): Promise<string> {
		const scratch = Buffer.alloc(SCRATCH_BYTES);
		for (;;) {
			const idx = findLf(this.pending);
			if (idx !== -1) {
				return this.takeLine(idx);
			}
			const got = await this.conn.read(scratch, opts);
			if (got === 0) {
				if (this.pending.length > 0) {
					const rest = this.pending.toString("utf-8");
					this.pending = Buffer.alloc(0);
					return stripCr(rest);
				}
				throw new NetProtocolError("Connection closed by peer while awaiting a line.", "EOF");
			}
			this.pending = Buffer.concat([this.pending, scratch.subarray(0, got)]);
		}
	}

	/** Append CRLF and flush - the wire form of every line protocol here. */
	async writeLine(line: string, opts?: WriteOptions): Promise<void> {
		await this.conn.write(`${line}\r\n`, opts);
	}

	async write(data: Uint8Array | string, opts?: WriteOptions): Promise<void> {
		await this.conn.write(data, opts);
	}

	/**
	 * Read exactly n bytes. Never re-splits lines the parser asked for as bytes
	 * (IMAP literals, FTP data streams).
	 */
	async readBytes(n: number, opts?: ReadOptions): Promise<Buffer> {
		const out = Buffer.allocUnsafe(n);
		let filled = 0;
		if (this.pending.length > 0) {
			filled = Math.min(n, this.pending.length);
			this.pending.copy(out, 0, 0, filled);
			this.pending = this.pending.subarray(filled);
		}
		while (filled < n) {
			const got = await this.conn.read(out.subarray(filled), { ...opts, atLeast: n - filled });
			if (got === 0) {
				throw new NetProtocolError(`Connection closed after ${filled} of ${n} bytes.`, "EOF");
			}
			filled += got;
		}
		return out;
	}

	/** Drain the peer's stream to EOF (FTP passive data connections). */
	async readToEnd(opts?: ReadOptions & { maxBytes?: number }): Promise<Buffer> {
		const parts: Buffer[] = [];
		let total = 0;
		for (;;) {
			const scratch = Buffer.alloc(SCRATCH_BYTES);
			const got = await this.conn.read(scratch, opts);
			if (got === 0) return Buffer.concat(parts);
			parts.push(Buffer.from(scratch.subarray(0, got)));
			total += got;
			if (opts?.maxBytes !== undefined && total > opts.maxBytes) {
				this.conn.destroy();
				throw new NetProtocolError(`Data stream exceeded ${opts.maxBytes} bytes.`, "TOO_LARGE");
			}
		}
	}

	close(): Promise<void> {
		return this.conn.close();
	}

	destroy(): void {
		this.conn.destroy();
	}

	private takeLine(lfIndex: number): string {
		const hasCr = lfIndex > 0 && this.pending[lfIndex - 1] === 0x0d;
		const line = this.pending.subarray(0, hasCr ? lfIndex - 1 : lfIndex).toString("utf-8");
		this.pending = this.pending.subarray(lfIndex + 1);
		return line;
	}
}

/** SNI must never carry an IP literal - node:tls refuses it outright. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

function isIpAddress(host: string): boolean {
	return /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(host) || host.includes(":");
}

function findLf(buf: Buffer): number {
	return buf.indexOf(0x0a);
}

function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// ---------------------------------------------------------------------------
// Response parsers (§2.4)
// ---------------------------------------------------------------------------

/** First whitespace-delimited token of a status line ("250", "A003"). */
export function firstToken(line: string): string {
	const idx = line.indexOf(" ");
	return idx === -1 ? line : line.slice(0, idx);
}

/**
 * FTP/SMTP multi-line replies: a line whose 4th character is "-" continues;
 * anything else terminates. One predicate drives both protocols.
 */
export function isFinalReplyLine(line: string): boolean {
	return line.length <= 3 || line[3] !== "-";
}

/** True while reply lines still carry "-" after the status code. */
export function isContinuedReplyLine(line: string): boolean {
	return line.length > 3 && line[3] === "-";
}

/**
 * Shared multi-line continuation collector: read lines until the terminal-line
 * predicate fires; return every line including the terminal one.
 */
export async function collectLines(
	readLine: () => Promise<string>,
	isTerminal: (line: string) => boolean,
): Promise<string[]> {
	const lines: string[] = [];
	for (;;) {
		const line = await readLine();
		lines.push(line);
		if (isTerminal(line)) return lines;
	}
}

// ---------------------------------------------------------------------------
// CredResolver (§2.3)
// ---------------------------------------------------------------------------

const secretCommandCache = new Map<string, string>();

export interface CredentialSpec {
	/** Env-var name or literal value. */
	user?: string;
	/** Env-var name, literal value, or "!"-prefixed shell command. */
	secret?: string;
	/** Explicit shell command producing the secret (takes precedence over secret). */
	secretCommand?: string;
}

/**
 * Resolve one credential field with resolveEnvOrLiteral semantics (mirrors
 * src/core/resolve-config-value.ts): a set, non-empty env var named by the
 * input wins; otherwise the input is the literal value. Set-but-empty means
 * missing credential - never silently the var name. A "!" prefix runs the rest
 * as a cached shell command, same contract as resolveConfigValue.
 */
export function resolveCredField(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (raw.startsWith("!")) return runSecretCommand(raw);
	const envValue = process.env[raw];
	if (envValue !== undefined) {
		return envValue || undefined; // Set-but-empty: missing credential.
	}
	return raw;
}

/**
 * Resolve user + secret for a protocol session. Throws NetAuthError when a
 * required field is absent or resolves to nothing. Secrets are never echoed
 * into errors, details, or logs.
 */
export function resolveCredentials(
	spec: CredentialSpec,
	opts?: { requireUser?: boolean },
): { user?: string; secret: string } {
	const user = resolveCredField(spec.user);
	if ((opts?.requireUser ?? true) && !user) {
		throw new NetAuthError("Missing credential: no username (pass an env-var name or literal for user).");
	}
	const secret = resolveCredField(spec.secretCommand ?? spec.secret);
	if (!secret) {
		throw new NetAuthError("Missing credential: no password (pass an env-var name or a !-prefixed secretCommand).");
	}
	return { user, secret };
}

function runSecretCommand(config: string): string {
	const cached = secretCommandCache.get(config);
	if (cached !== undefined) return cached;
	const command = config.slice(1);
	let value: string | undefined;
	try {
		const proc = Bun.spawnSync(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		value = proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() || undefined : undefined;
	} catch {
		value = undefined;
	}
	if (value === undefined) {
		throw new NetAuthError("Failed to resolve credential from shell command.");
	}
	secretCommandCache.set(config, value);
	return value;
}

/** Clear the secret-command cache. Exported for testing. */
export function clearCredentialCommandCache(): void {
	secretCommandCache.clear();
}
