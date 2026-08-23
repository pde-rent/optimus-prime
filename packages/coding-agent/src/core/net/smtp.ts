/**
 * SMTP submission client (docs/net-stack-spec.md §5).
 *
 * Aimed at submission ports 587 (STARTTLS) and 465 (implicit TLS), plus plain
 * relays when the caller explicitly opts out of TLS. Session shape:
 *
 *   greeting 220 -> EHLO -> [STARTTLS -> EHLO] -> AUTH PLAIN|LOGIN ->
 *   MAIL FROM -> RCPT TO* -> DATA (dot-stuffed) -> QUIT
 *
 * Message assembly is deliberately minimal RFC 5322: flat text part, RFC 2047
 * encoded Subject when needed, no attachments (reserved for v2).
 */

import {
	collectLines,
	firstToken,
	isFinalReplyLine,
	LineProtocol,
	NetAuthError,
	type NetConnection,
	NetProtocolError,
	resolveCredentials,
	type TlsOptions,
	tcpConnect,
} from "./core.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SmtpConnectOptions {
	host: string;
	/** Default 587. */
	port?: number;
	/**
	 * implicit = TLS from the first byte (port 465);
	 * starttls = plaintext then STARTTLS when advertised;
	 * plain    = never encrypt (explicit relay opt-out).
	 * Default: implicit for port 465, starttls otherwise.
	 */
	tls?: "implicit" | "starttls" | "plain";
	/** Refuse to continue without TLS. Default true unless tls is "plain". */
	requireTls?: boolean;
	/** Certificate policy for TLS; default rejectUnauthorized: true. */
	tlsOptions?: TlsOptions;
	/** Name used after EHLO; defaults to the local hostname. */
	localHostname?: string;
	connectTimeoutMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface SmtpAuthSpec {
	/** Env-var name or literal username. */
	user: string;
	/** Env-var name, literal, or "!"-prefixed command producing the password. */
	secret?: string;
	/** Shell command producing the password (takes precedence over secret). */
	secretCommand?: string;
	/** Force one mechanism; default picks PLAIN, then LOGIN. */
	method?: "plain" | "login";
}

export interface SmtpMessage {
	from: string;
	to: string[];
	cc?: string[];
	/** Consumed for envelope recipients but never echoed into message headers. */
	bcc?: string[];
	subject?: string;
	body?: string;
	/** Reserved for v2 multipart support; rejected until then. */
	attachPaths?: string[];
}

export interface SmtpSendResult {
	acceptedRecipients: number;
	/** Verbatim final DATA reply, enhanced status codes included ("250 2.0.0 OK"). */
	serverReply: string;
	messageId: string;
}

interface SmtpReply {
	code: number;
	lines: string[];
	/** Full reply text joined with CRLF, verbatim. */
	text: string;
}

// ---------------------------------------------------------------------------
// Reply plumbing
// ---------------------------------------------------------------------------

async function readReply(lp: LineProtocol, timeoutMs: number, signal?: AbortSignal): Promise<SmtpReply> {
	const lines = await collectLines(() => lp.readLine({ timeoutMs, signal }), isFinalReplyLine);
	const code = Number.parseInt(firstToken(lines[0]), 10);
	if (Number.isNaN(code)) {
		throw new NetProtocolError("Malformed SMTP status line.", lines[0]);
	}
	return { code, lines, text: lines.join("\r\n") };
}

function expect(reply: SmtpReply, min: number, max: number, what: string): void {
	if (reply.code < min || reply.code > max) {
		throw new NetProtocolError(what + " failed.", reply.text);
	}
}

// ---------------------------------------------------------------------------
// Address + header helpers
// ---------------------------------------------------------------------------

const CRLF_PATTERN = /[\r\n]/;

/**
 * Extract the addr-spec from "user@host" or "Display Name <user@host>".
 * Rejects addresses carrying CR/LF (header injection).
 */
export function parseAddress(address: string): string {
	if (CRLF_PATTERN.test(address)) {
		throw new NetProtocolError("Address contains line breaks - refused.", "");
	}
	const angled = address.match(/<([^>]*)>/);
	const addr = angled ? angled[1].trim() : address.trim();
	if (!addr || !addr.includes("@")) {
		throw new NetProtocolError("Not a valid email address: " + address.slice(0, 64), "");
	}
	return addr;
}

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7e || text.charCodeAt(i) < 0x20) return false;
	}
	return true;
}

/** RFC 2047 encoded-word for UTF-8 text, B transfer encoding, words <= 75 chars. */
export function encodeRfc2047Word(text: string): string {
	const encoded = Buffer.from(text, "utf-8").toString("base64");
	const chunks: string[] = [];
	// "=UTF-8?B?" + "?" overhead is 11 chars per encoded word.
	const dataLimit = 75 - 11;
	for (let i = 0; i < encoded.length; i += dataLimit) {
		chunks.push(encoded.slice(i, i + dataLimit));
	}
	return chunks.map((chunk) => "=?UTF-8?B?" + chunk + "?=").join(" ");
}

/** Encode a header value when (and only when) it needs RFC 2047 protection. */
export function encodeHeaderValue(value: string): string {
	const single = value.replace(/[\r\n]+/g, " ").trim();
	if (isAscii(single)) return single;
	return encodeRfc2047Word(single);
}

/** Dot-stuffing: escape leading "." so the receiver cannot see an early terminator. */
export function dotStuff(text: string): string {
	return text.replace(/(^|[\r\n])\./g, "$1..");
}

/** Quoted-printable encode a UTF-8 body (used when 8BITMIME was not advertised). */
export function quotedPrintable(text: string): string {
	const bytes = Buffer.from(text, "utf-8");
	let out = "";
	let lineLength = 0;
	for (const byte of bytes) {
		if (byte === 0x0d) continue;
		if (byte === 0x0a) {
			out += "\r\n";
			lineLength = 0;
			continue;
		}
		const literal = (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9;
		const token = literal ? String.fromCharCode(byte) : "=" + byte.toString(16).toUpperCase().padStart(2, "0");
		if (lineLength + token.length > 75) {
			out += "=\r\n";
			lineLength = 0;
		}
		out += token;
		lineLength += token.length;
	}
	// Trailing WSP must be encoded so transport cannot strip it (RFC 2045 §6.7).
	return out.replace(/[ \t](?=\r\n|$)/g, (m) => (m === " " ? "=20" : "=09"));
}

function rfc5322Date(date = new Date()): string {
	return date.toUTCString().replace("GMT", "+0000");
}

function messageIdFor(fromAddr: string): string {
	const domain = fromAddr.split("@")[1] ?? "localhost";
	return "<" + crypto.randomUUID() + "@" + domain + ">";
}

interface AssembledMessage {
	wire: string;
	eightBit: boolean;
	hasNonAscii: boolean;
}

/** Build the RFC 5322 message. Bcc is consumed by the envelope, never emitted. */
export function assembleMessage(message: SmtpMessage, opts: { eightBitMime: boolean }): AssembledMessage {
	if (message.attachPaths?.length) {
		throw new NetProtocolError("Attachments are reserved for v2 and not supported yet.", "");
	}
	const clean = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();
	const headers: string[] = [];
	headers.push("From: " + clean(message.from));
	headers.push("To: " + message.to.map(clean).join(", "));
	if (message.cc?.length) headers.push("Cc: " + message.cc.map(clean).join(", "));
	// Deliberately no Bcc header: envelope-only distribution.
	if (message.subject) headers.push("Subject: " + encodeHeaderValue(message.subject));
	headers.push("Date: " + rfc5322Date());
	headers.push("Message-ID: " + messageIdFor(parseAddress(message.from)));
	headers.push("MIME-Version: 1.0");

	const body = message.body ?? "";
	const hasNonAscii = !isAscii(body);
	const eightBit = opts.eightBitMime;
	headers.push("Content-Type: text/plain; charset=utf-8");
	headers.push("Content-Transfer-Encoding: " + (eightBit ? "8bit" : "quoted-printable"));

	const wireBody = eightBit ? body : quotedPrintable(body);
	return { wire: headers.join("\r\n") + "\r\n\r\n" + wireBody, eightBit, hasNonAscii };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SmtpClient {
	private readonly lp: LineProtocol;
	private readonly timeoutMs: number;
	private readonly signal: AbortSignal | undefined;
	private readonly capabilities = new Map<string, string[]>();
	private authenticated = false;

	private constructor(
		lp: LineProtocol,
		readonly host: string,
		readonly port: number,
		opts: { timeoutMs?: number; signal?: AbortSignal },
	) {
		this.lp = lp;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.signal = opts.signal;
	}

	get connection(): NetConnection {
		return this.lp.connection;
	}

	get capabilitiesSnapshot(): Map<string, string[]> {
		return new Map(this.capabilities);
	}

	/** Connect, read the greeting, EHLO, STARTTLS when available and required. */
	static async connect(options: SmtpConnectOptions): Promise<SmtpClient> {
		const port = options.port ?? 587;
		const mode = options.tls ?? (port === 465 ? "implicit" : "starttls");
		const requireTls = options.requireTls ?? mode !== "plain";
		const raw = await tcpConnect({
			host: options.host,
			port,
			tls: mode === "implicit" ? (options.tlsOptions ?? true) : false,
			connectTimeoutMs: options.connectTimeoutMs,
			signal: options.signal,
		});
		const client = new SmtpClient(new LineProtocol(raw), options.host, port, options);
		try {
			expect(await readReply(client.lp, client.timeoutMs, options.signal), 220, 220, "Greeting");
			await client.ehlo(options.localHostname);
			if (!raw.secure && mode !== "plain") {
				if (!client.capabilities.has("STARTTLS")) {
					if (requireTls) {
						throw new NetProtocolError("STARTTLS required but the server does not advertise it.", "");
					}
				} else {
					expect(await readReply(client.lp, client.timeoutMs, options.signal), 220, 220, "STARTTLS");
					await raw.upgradeTls(options.tlsOptions);
					await client.ehlo(options.localHostname);
				}
			}
			return client;
		} catch (error: unknown) {
			client.lp.destroy();
			throw error;
		}
	}

	/** EHLO (falling back to HELO on rejection); refreshes the capability map. */
	async ehlo(localHostname?: string): Promise<void> {
		const name = localHostname ?? hostnameForEhlo();
		await this.lp.writeLine("EHLO " + name, { signal: this.signal });
		let reply = await readReply(this.lp, this.timeoutMs, this.signal);
		if (reply.code !== 250) {
			await this.lp.writeLine("HELO " + name, { signal: this.signal });
			reply = await readReply(this.lp, this.timeoutMs, this.signal);
			expect(reply, 250, 250, "HELO");
			this.capabilities.clear();
			return;
		}
		this.capabilities.clear();
		for (const line of reply.lines) {
			// Every EHLO line advertises one capability:
			// "250-PIPELINING" ... "250 8BITMIME" (single-line replies included).
			const parts = line.replace(/^\d{3}[ -]/, "").split(/\s+/);
			this.capabilities.set(parts[0].toUpperCase(), parts.slice(1));
		}
	}

	authMechanisms(): string[] {
		return (this.capabilities.get("AUTH") ?? []).map((mech) => mech.toUpperCase());
	}

	/** AUTH PLAIN or AUTH LOGIN with CredResolver-resolved credentials. */
	async authenticate(spec: SmtpAuthSpec): Promise<void> {
		const { user, secret } = resolveCredentials(spec);
		if (!user || !secret) throw new NetAuthError("Missing credential.");
		const advertised = this.authMechanisms();
		const method = spec.method ?? (advertised.includes("PLAIN") || advertised.length === 0 ? "plain" : "login");

		if (method === "plain") {
			const blob = Buffer.from("\0" + user + "\0" + secret, "utf-8").toString("base64");
			await this.lp.writeLine("AUTH PLAIN " + blob, { signal: this.signal });
		} else {
			await this.lp.writeLine("AUTH LOGIN", { signal: this.signal });
			expect(await readReply(this.lp, this.timeoutMs, this.signal), 300, 399, "AUTH LOGIN prompt");
			await this.lp.writeLine(Buffer.from(user, "utf-8").toString("base64"), { signal: this.signal });
			expect(await readReply(this.lp, this.timeoutMs, this.signal), 300, 399, "AUTH LOGIN username");
			await this.lp.writeLine(Buffer.from(secret, "utf-8").toString("base64"), { signal: this.signal });
		}
		const reply = await readReply(this.lp, this.timeoutMs, this.signal);
		if (reply.code < 230 || reply.code > 235) {
			throw new NetAuthError(`Server rejected credentials (${reply.text}).`);
		}
		this.authenticated = true;
	}

	get isAuthenticated(): boolean {
		return this.authenticated;
	}

	/** MAIL FROM + RCPT TO* + DATA with dot-stuffing. Returns the verbatim final reply. */
	async sendMessage(message: SmtpMessage): Promise<SmtpSendResult> {
		const assembled = assembleMessage(message, { eightBitMime: this.capabilities.has("8BITMIME") });
		const fromAddr = parseAddress(message.from);

		const mailParams: string[] = [];
		if (assembled.eightBit) mailParams.push("BODY=8BITMIME");
		if (this.capabilities.has("SMTPUTF8") && assembled.hasNonAscii) mailParams.push("SMTPUTF8");
		const paramText = mailParams.length ? " " + mailParams.join(" ") : "";
		await this.lp.writeLine("MAIL FROM:<" + fromAddr + ">" + paramText, { signal: this.signal });
		expect(await readReply(this.lp, this.timeoutMs, this.signal), 200, 299, "MAIL FROM");

		const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
		let accepted = 0;
		for (const recipient of recipients) {
			await this.lp.writeLine("RCPT TO:<" + parseAddress(recipient) + ">", { signal: this.signal });
			const reply = await readReply(this.lp, this.timeoutMs, this.signal);
			if (reply.code >= 200 && reply.code <= 299) accepted++;
			else throw new NetProtocolError("Recipient refused: " + recipient.slice(0, 64), reply.text);
		}

		await this.lp.writeLine("DATA", { signal: this.signal });
		expect(await readReply(this.lp, this.timeoutMs, this.signal), 300, 399, "DATA");
		// Byte-exact body write with dot-stuffing; never re-split by the line reader.
		await this.lp.write(dotStuff(assembled.wire) + "\r\n.\r\n", { signal: this.signal });
		const final = await readReply(this.lp, this.timeoutMs, this.signal);
		expect(final, 200, 299, "DATA acceptance");
		return { acceptedRecipients: accepted, serverReply: final.text, messageId: messageIdFor(fromAddr) };
	}

	async noop(): Promise<void> {
		await this.lp.writeLine("NOOP", { signal: this.signal });
		expect(await readReply(this.lp, this.timeoutMs, this.signal), 200, 299, "NOOP");
	}

	/** Hard-close the socket after a failure. */
	abort(): void {
		this.lp.destroy();
	}

	/** QUIT and graceful close; safe to call even after failures. */
	async quit(): Promise<void> {
		try {
			await this.lp.writeLine("QUIT", { signal: this.signal });
			await readReply(this.lp, Math.min(this.timeoutMs, 5000), this.signal).catch(() => undefined);
		} finally {
			await this.lp.close();
		}
	}
}

function hostnameForEhlo(): string {
	return process.env.HOSTNAME || "localhost";
}

// ---------------------------------------------------------------------------
// One-shot helper
// ---------------------------------------------------------------------------

export interface SendMailOptions extends SmtpConnectOptions {
	auth?: SmtpAuthSpec;
	message: SmtpMessage;
}

/** Connect (+auth) and send one message in a single session. */
export async function sendMail(options: SendMailOptions): Promise<SmtpSendResult> {
	const client = await SmtpClient.connect(options);
	try {
		if (options.auth) await client.authenticate(options.auth);
		return await client.sendMessage(options.message);
	} catch (error: unknown) {
		client.abort();
		throw error;
	} finally {
		await client.quit();
	}
}
