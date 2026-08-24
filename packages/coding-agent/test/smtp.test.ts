import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCredentialCommandCache, NetAuthError, NetProtocolError } from "../src/core/net/core.js";
import {
	assembleMessage,
	dotStuff,
	encodeHeaderValue,
	parseAddress,
	quotedPrintable,
	SmtpClient,
	type SmtpMessage,
} from "../src/core/net/smtp.js";

// ---------------------------------------------------------------------------
// Fake SMTP servers
// ---------------------------------------------------------------------------

interface FakeSmtpServer {
	port: number;
	transcript: string[];
	stop(): void;
}

interface FakeSmtpOptions {
	capabilities?: string[];
	authAccepted?: boolean;
	rejectRecipient?: string;
	dataReply?: string;
	tls?: { key: Buffer; cert: Buffer };
}

function startFakeSmtp(opts: FakeSmtpOptions = {}): FakeSmtpServer {
	const transcript: string[] = [];
	// STARTTLS deliberately absent from the defaults: the plain-text fake cannot
	// honour it. Real mid-stream upgrades are covered by startStarttlsSmtp below.
	const caps = opts.capabilities ?? ["8BITMIME", "AUTH PLAIN LOGIN", "SMTPUTF8"];
	let _ehloCount = 0;
	let loginStep = 0;
	let _secure = opts.tls !== undefined; // Implicit TLS: the channel is already private.
	const listenOpts = {
		hostname: "127.0.0.1",
		port: 0,
		tls: opts.tls ? { key: opts.tls.key, cert: opts.tls.cert } : undefined,
		socket: {
			open(socket: Bun.TCPSocket) {
				socket.write("220 fake ESMTP ready\r\n");
			},
			data(socket: Bun.TCPSocket, data: Uint8Array) {
				for (const raw of new TextDecoder().decode(data).split("\r\n")) {
					if (!raw) continue;
					transcript.push(raw);
					if (raw.startsWith("EHLO")) {
						_ehloCount++;
						const lines = caps.map((cap, i) => (i === caps.length - 1 ? `250 ${cap}` : `250-${cap}`));
						socket.write(`${lines.join("\r\n")}\r\n`);
					} else if (raw === "STARTTLS") {
						_secure = true;
						socket.write("220 2.0.0 Ready to start TLS\r\n");
					} else if (raw === "AUTH LOGIN") {
						socket.write(opts.authAccepted === false ? "535 5.7.8 Bad credentials\r\n" : "334 VXNlcm5hbWU6\r\n");
						loginStep = 1;
					} else if (loginStep >= 1 && loginStep <= 2 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
						loginStep++;
						if (loginStep > 2 || opts.authAccepted === false) {
							socket.write(
								opts.authAccepted === false ? "535 5.7.8 Bad credentials\r\n" : "235 2.7.0 Accepted\r\n",
							);
							loginStep = 0;
						} else {
							socket.write("334 UGFzc3dvcmQ6\r\n");
						}
					} else if (raw.startsWith("AUTH ")) {
						if (opts.authAccepted === false) socket.write("535 5.7.8 Bad credentials\r\n");
						else socket.write("235 2.7.0 Accepted\r\n");
					} else if (raw.startsWith("MAIL FROM")) {
						socket.write("250 2.1.0 Originator ok\r\n");
					} else if (raw.startsWith("RCPT TO")) {
						if (opts.rejectRecipient && raw.includes(opts.rejectRecipient)) {
							socket.write("550 5.1.1 No such user here\r\n");
						} else {
							socket.write("250 2.1.5 Recipient ok\r\n");
						}
					} else if (raw === "DATA") {
						socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
					} else if (raw === ".") {
						socket.write(opts.dataReply ?? "250 2.0.0 Queued as ABC123\r\n");
					} else if (raw === "NOOP") {
						socket.write("250 2.0.0 OK\r\n");
					} else if (raw === "QUIT") {
						socket.write("221 2.0.0 Bye\r\n");
						socket.end();
					}
				}
			},
		},
	} as unknown as Parameters<typeof Bun.listen>[0];
	const listener = Bun.listen(listenOpts);
	return { port: listener.port, transcript, stop: () => listener.stop(true) };
}

/**
 * STARTTLS peer with a REAL TLS terminator: a Node.js subprocess whose
 * net server wraps the live socket in a server-side TLSSocket after
 * STARTTLS. Bun's own TLSSocket(isServer) does not complete handshakes,
 * so the wire truth comes from the platform reference implementation.
 */
const NODE_STARTTLS_SERVER_SCRIPT = `
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const tlsDir = process.argv[2] ?? process.argv[1];
const ctx = tls.createSecureContext({
	key: fs.readFileSync(tlsDir + "/key.pem"),
	cert: fs.readFileSync(tlsDir + "/cert.pem"),
});
let ehloCount = 0;
const server = net.createServer((plain) => {
	plain.write("220 nodestls ESMTP ready\\r\\n");
	plain.on("data", function handle(chunk) {
		for (const line of chunk.toString().split("\\r\\n")) {
			if (!line) continue;
			if (line.startsWith("EHLO")) {
				ehloCount++;
				plain.write(
					ehloCount > 1
						? "250-node-x\\r\\n250-AUTH PLAIN\\r\\n250 8BITMIME\\r\\n"
						: "250-node-x\\r\\n250-STARTTLS\\r\\n250 8BITMIME\\r\\n",
				);
			} else if (line === "STARTTLS") {
				plain.write("220 2.0.0 Ready to start TLS\\r\\n");
				plain.removeListener("data", handle);
				const secure = new tls.TLSSocket(plain, { isServer: true, secureContext: ctx });
				secure.on("data", (chunk2) => {
					for (const line2 of chunk2.toString().split("\\r\\n")) {
						if (!line2) continue;
						if (line2.startsWith("EHLO")) secure.write("250-secure-x\\r\\n250-AUTH PLAIN\\r\\n250 8BITMIME\\r\\n");
						else if (line2 === "QUIT") {
							secure.write("221 2.0.0 Bye\\r\\n");
							secure.end();
						}
					}
				});
			}
		}
	});
});
server.listen(0, "127.0.0.1", () => {
	console.log("PORT " + server.address().port);
});
`;

async function startStarttlsSmtp(tlsDir: string): Promise<{ port: number; stop(): void }> {
	const proc = Bun.spawn(["node", "-e", NODE_STARTTLS_SERVER_SCRIPT, tlsDir], {
		stdout: "pipe",
		stderr: "pipe",
	});
	// The child keeps stdout open while serving; read incrementally until it
	// prints its chosen port.
	const streamReader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let match: RegExpMatchArray | null = null;
	while (!match) {
		const { done, value } = await streamReader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// Require the trailing newline so a chunk-split port number cannot
		// match partially.
		match = buffer.match(/PORT (\d+)\r?\n/);
	}
	if (!match) {
		const exitCode = await proc.exited;
		throw new Error(
			`node STARTTLS fixture exited (${exitCode}) without a port; stdout: ${JSON.stringify(buffer.slice(0, 200))}`,
		);
	}
	return { port: Number(match[1]), stop: () => proc.kill() };
}

function makeSelfSignedCert(dir: string): void {
	const openssl = Bun.which("openssl") ?? "/usr/bin/openssl";
	const proc = Bun.spawnSync(
		[
			openssl,
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
			"-days",
			"2",
			"-nodes",
			"-subj",
			"/CN=localhost",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	if (proc.exitCode !== 0) throw new Error(`could not generate test certificate (exit ${proc.exitCode})`);
}

describe("SMTP helpers", () => {
	it("parseAddress extracts addr-spec and rejects injection", () => {
		expect(parseAddress("plain@host.io")).toBe("plain@host.io");
		expect(parseAddress("Display Name <fancy@host.io>")).toBe("fancy@host.io");
		expect(() => parseAddress("evil@host.io\r\nBcc: x@y.z")).toThrow(NetProtocolError);
		expect(() => parseAddress("not-an-address")).toThrow(/valid email/);
	});

	it("encodeHeaderValue passes ASCII through and wraps non-ASCII", () => {
		expect(encodeHeaderValue("hello world")).toBe("hello world");
		const encoded = encodeHeaderValue("héllo wörld");
		expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf-8")).toBe("héllo wörld");
	});

	it("dotStuff escapes only leading dots", () => {
		expect(dotStuff(".lead\r\nmiddle\r\n..double\r\nnot. this")).toBe("..lead\r\nmiddle\r\n...double\r\nnot. this");
	});

	it("quotedPrintable encodes non-ASCII bytes, = signs and trailing WSP", () => {
		expect(quotedPrintable("Café = ok\r\ntrailing \r\nnext")).toBe("Caf=C3=A9 =3D ok\r\ntrailing=20\r\nnext");
	});

	it("assembleMessage emits Bcc envelope-only and honours 8BITMIME negotiation", () => {
		const message: SmtpMessage = {
			from: "From One <a@b.c>",
			to: ["d@e.f"],
			cc: ["g@h.i"],
			bcc: ["secret@j.k"],
			subject: "s",
			body: "café",
		};
		const qp = assembleMessage(message, { eightBitMime: false });
		expect(qp.wire).toContain("Content-Transfer-Encoding: quoted-printable");
		expect(qp.wire).toContain("caf=C3=A9");
		const eight = assembleMessage(message, { eightBitMime: true });
		expect(eight.wire).toContain("Content-Transfer-Encoding: 8bit");
		for (const assembled of [qp, eight]) {
			expect(assembled.wire).not.toContain("secret@j.k");
			expect(assembled.wire).toMatch(/\r\n\r\n/);
		}
	});

	it("assembleMessage refuses attachments until v2", () => {
		const message: SmtpMessage = { from: "a@b.c", to: ["d@e.f"], attachPaths: ["/tmp/x"] };
		expect(() => assembleMessage(message, { eightBitMime: true })).toThrow(/[Rr]eserved for v2/);
	});
});

describe("SMTP client", () => {
	let servers: FakeSmtpServer[] = [];
	let tlsDirs: string[] = [];

	beforeEach(() => clearCredentialCommandCache());
	afterEach(() => {
		for (const server of servers) server.stop();
		servers = [];
		for (const dir of tlsDirs) rmSync(dir, { recursive: true, force: true });
		tlsDirs = [];
		delete process.env.SMTP_TEST_PASSWORD;
	});

	function track(server: FakeSmtpServer): FakeSmtpServer {
		servers.push(server);
		return server;
	}

	function makeTlsDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "smtp-tls-"));
		tlsDirs.push(dir);
		return dir;
	}

	const baseMessage: SmtpMessage = {
		from: "Sender Name <sender@example.com>",
		to: ["first@example.net", "Second Fan <second@example.net>"],
		cc: ["copy@example.org"],
		bcc: ["blind@example.org"],
		subject: "héllo there",
		body: "line one\r\n.leading dot\r\ntail",
	};

	it("runs EHLO -> AUTH PLAIN -> MAIL -> RCPT* -> DATA -> QUIT with dot-stuffing", async () => {
		process.env.SMTP_TEST_PASSWORD = "pw123";
		const server = track(startFakeSmtp({ authAccepted: true }));
		const client = await SmtpClient.connect({ host: "127.0.0.1", port: server.port, requireTls: false });
		await client.authenticate({ user: "sender@example.com", secret: "SMTP_TEST_PASSWORD" });
		const result = await client.sendMessage(baseMessage);
		await client.quit();

		expect(result.acceptedRecipients).toBe(4);
		expect(result.serverReply).toBe("250 2.0.0 Queued as ABC123");
		expect(result.messageId).toMatch(/^<.+@example\.com>$/);

		const text = server.transcript.join("\n");
		expect(text).toContain("EHLO localhost");
		const authLine = server.transcript.find((l) => l.startsWith("AUTH PLAIN "));
		expect(authLine).toBeDefined();
		expect(Buffer.from(authLine!.slice("AUTH PLAIN ".length), "base64").toString()).toBe(
			"\0sender@example.com\0pw123",
		);
		const rcpts = server.transcript
			.filter((l) => l.startsWith("RCPT TO:<"))
			.map((l) => l.slice("RCPT TO:<".length, -1));
		expect(rcpts).toEqual(["first@example.net", "second@example.net", "copy@example.org", "blind@example.org"]);
		const dataIndex = server.transcript.indexOf("DATA");
		const messageLines = server.transcript.slice(dataIndex + 1, server.transcript.indexOf("."));
		const joined = messageLines.join("\n");
		expect(joined).toContain("Subject: =?UTF-8?B?");
		expect(joined).not.toContain("Bcc:");
		expect(messageLines).toContain("..leading dot"); // dot-stuffed on the wire
	});

	it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
		const server = track(startFakeSmtp({ capabilities: ["AUTH LOGIN", "8BITMIME"], authAccepted: true }));
		const client = await SmtpClient.connect({ host: "127.0.0.1", port: server.port, requireTls: false });
		await client.authenticate({ user: "user@x", secret: "literal-pw" });
		expect(client.isAuthenticated).toBe(true);
		await client.quit();
		const text = server.transcript.join("\n");
		expect(text).toContain("AUTH LOGIN");
		const b64User = server.transcript[server.transcript.indexOf("AUTH LOGIN") + 1];
		expect(Buffer.from(b64User, "base64").toString()).toBe("user@x");
	});

	it("surfaces authentication rejection as NetAuthError without echoing secrets", async () => {
		const server = track(startFakeSmtp({ authAccepted: false }));
		const client = await SmtpClient.connect({ host: "127.0.0.1", port: server.port, requireTls: false });
		await expect(client.authenticate({ user: "user@x", secret: "wrong-guess-xyz" })).rejects.toThrow(NetAuthError);
		expect(server.transcript.join("\n")).not.toContain("wrong-guess-xyz");
		client.abort();
	});

	it("refuses a rejected recipient verbatim and skips queueing", async () => {
		const server = track(startFakeSmtp({ rejectRecipient: "ghost@example.net" }));
		const client = await SmtpClient.connect({ host: "127.0.0.1", port: server.port, requireTls: false });
		const error: unknown = await client.sendMessage({ ...baseMessage, to: ["ghost@example.net"] }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(NetProtocolError);
		expect((error as NetProtocolError).reply).toContain("550 5.1.1 No such user here");
		client.abort();
		expect(server.transcript).not.toContain(".");
	});

	it("performs a real STARTTLS upgrade before authenticating", async () => {
		const dir = makeTlsDir();
		makeSelfSignedCert(dir);
		const fake = await startStarttlsSmtp(dir);
		const client = await SmtpClient.connect({
			host: "127.0.0.1",
			port: fake.port,
			tls: "starttls",
			tlsOptions: { rejectUnauthorized: false },
			connectTimeoutMs: 8000,
			timeoutMs: 8000,
		});
		try {
			expect(client.connection.secure).toBe(true); // upgraded mid-stream
			expect(client.capabilitiesSnapshot.has("STARTTLS")).toBe(false); // post-TLS EHLO re-ran
			expect(client.capabilitiesSnapshot.has("AUTH")).toBe(true);
		} finally {
			await client.quit();
			fake.stop();
		}
	});

	it("speaks implicit TLS end-to-end (port-465 shape)", async () => {
		const dir = makeTlsDir();
		makeSelfSignedCert(dir);
		const server = track(
			startFakeSmtp({ tls: { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) } }),
		);
		const client = await SmtpClient.connect({
			host: "127.0.0.1",
			port: server.port,
			tls: "implicit",
			tlsOptions: { rejectUnauthorized: false },
		});
		expect(client.connection.secure).toBe(true);
		const result = await client.sendMessage({ ...baseMessage, subject: "implicit", body: "over tls" });
		expect(result.acceptedRecipients).toBe(4);
		await client.quit();
	});

	it("fails closed when STARTTLS is required but not advertised", async () => {
		const server = track(startFakeSmtp({ capabilities: ["8BITMIME", "AUTH PLAIN"] }));
		await expect(SmtpClient.connect({ host: "127.0.0.1", port: server.port })).rejects.toThrow(/STARTTLS required/);
	});

	it("uses BODY=8BITMIME only when negotiated", async () => {
		const server = track(startFakeSmtp({ capabilities: ["8BITMIME"] }));
		const client = await SmtpClient.connect({ host: "127.0.0.1", port: server.port, requireTls: false });
		await client.sendMessage({ ...baseMessage, subject: "eight", body: "plain ascii body" });
		await client.quit();
		expect(server.transcript.some((l) => l === "MAIL FROM:<sender@example.com> BODY=8BITMIME")).toBe(true);
	});
});
