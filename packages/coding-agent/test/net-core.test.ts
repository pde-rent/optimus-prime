import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearCredentialCommandCache,
	collectLines,
	firstToken,
	isFinalReplyLine,
	LineProtocol,
	type NetConnection,
	NetProtocolError,
	NetTimeoutError,
	resolveCredentials,
	tcpConnect,
} from "../src/core/net/core.js";

interface FakeServer {
	port: number;
	written: string[];
	stop(): void;
}

/** Raw TCP fake that replies from a script: one entry per client write. */
function startScriptedServer(
	script: string[] | ((chunk: string) => void),
	opts?: { closeAfterWrites?: number },
): FakeServer {
	const written: string[] = [];
	let step = 0;
	let writes = 0;
	const listenOpts = {
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket: Bun.TCPSocket) {
				socket.write("220 fake ready\r\n");
			},
			data(socket: Bun.TCPSocket, data: Uint8Array) {
				const chunk = new TextDecoder().decode(data);
				written.push(chunk);
				if (typeof script === "function") {
					script(chunk);
					return;
				}
				const reply = script[step++];
				if (reply !== undefined) {
					socket.write(reply);
					if (opts?.closeAfterWrites === ++writes) socket.end();
				}
			},
		},
	} as unknown as Parameters<typeof Bun.listen>[0];
	const server = Bun.listen(listenOpts);
	return { port: server.port, written, stop: () => server.stop(true) };
}

async function connect(serverPort: number): Promise<NetConnection> {
	return tcpConnect({ host: "127.0.0.1", port: serverPort });
}

describe("net core primitives", () => {
	let servers: FakeServer[] = [];
	beforeEach(() => {
		servers = [];
	});
	afterEach(() => {
		for (const server of servers) server.stop();
	});

	function track(server: FakeServer): FakeServer {
		servers.push(server);
		return server;
	}

	describe("LineProtocol", () => {
		it("reads CRLF lines and strips the terminator", async () => {
			const server = track(startScriptedServer(["250-fake\r\n250 OK\r\n"]));
			const lp = new LineProtocol(await connect(server.port));
			expect(await lp.readLine()).toBe("220 fake ready");
			await lp.writeLine("EHLO test");
			expect(await lp.readLine()).toBe("250-fake");
			expect(await lp.readLine()).toBe("250 OK");
			expect(server.written[0]).toBe("EHLO test\r\n");
			lp.destroy();
		});

		it("handles bare-LF lines and a final line without terminator", async () => {
			const server = track(startScriptedServer(["alpha\nbeta\ngamma"], { closeAfterWrites: 1 }));
			const lp = new LineProtocol(await connect(server.port));
			expect(await lp.readLine()).toBe("220 fake ready");
			await lp.writeLine("x");
			expect(await lp.readLine()).toBe("alpha");
			expect(await lp.readLine()).toBe("beta");
			expect(await lp.readLine()).toBe("gamma");
			lp.destroy();
		});

		it("readBytes is byte-exact across line boundaries", async () => {
			const server = track(startScriptedServer(["{5}\r\nhello rest\r\n"]));
			const lp = new LineProtocol(await connect(server.port));
			expect(await lp.readLine()).toBe("220 fake ready");
			await lp.writeLine("go");
			const five = await lp.readBytes(5);
			expect(five.toString()).toBe("{5}\r\n");
			expect(await lp.readLine()).toBe("hello rest");
			lp.destroy();
		});

		it("times out a silent read with NetTimeoutError and destroys the socket", async () => {
			const server = track(startScriptedServer([]));
			const lp = new LineProtocol(await connect(server.port));
			expect(await lp.readLine()).toBe("220 fake ready");
			await expect(lp.readLine({ timeoutMs: 100 })).rejects.toThrow(NetTimeoutError);
			lp.destroy();
		});

		it("rejects an aborted read with NetAbortedError", async () => {
			const server = track(startScriptedServer([]));
			const lp = new LineProtocol(await connect(server.port));
			expect(await lp.readLine()).toBe("220 fake ready");
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);
			await expect(lp.readLine({ signal: controller.signal })).rejects.toThrow("Operation aborted");
			lp.destroy();
		});

		it("readToEnd drains until EOF", async () => {
			const server = track(startScriptedServer(["chunk-one\r\nchunk-two\r\n"], { closeAfterWrites: 1 }));
			const conn = await connect(server.port);
			const lp = new LineProtocol(conn);
			expect(await lp.readLine()).toBe("220 fake ready");
			await lp.writeLine("get");
			const data = await lp.readToEnd({ timeoutMs: 2000 });
			expect(data.toString()).toBe("chunk-one\r\nchunk-two\r\n");
			lp.destroy();
		});
	});

	describe("reply parsers", () => {
		it("firstToken returns the leading status word", () => {
			expect(firstToken("250 2.0.0 OK")).toBe("250");
			expect(firstToken("A003 OK")).toBe("A003");
			expect(firstToken("no-space")).toBe("no-space");
		});

		it("isFinalReplyLine accepts continuation dashes only after the code", () => {
			expect(isFinalReplyLine("250-continue")).toBe(false);
			expect(isFinalReplyLine("250 done")).toBe(true);
			expect(isFinalReplyLine("550 error")).toBe(true);
		});

		it("collectLines gathers multi-line replies including the terminal line", async () => {
			const lines = ["250-first", "250-second", "250 last"];
			let index = 0;
			const collected = await collectLines(() => Promise.resolve(lines[index++]), isFinalReplyLine);
			expect(collected).toEqual(lines);
		});
	});

	describe("CredResolver", () => {
		afterEach(() => {
			delete process.env.NET_CORE_TEST_SECRET;
			clearCredentialCommandCache();
		});

		it("prefers a set env var over the literal", () => {
			process.env.NET_CORE_TEST_SECRET = "from-env";
			expect(resolveCredentials({ user: "u", secret: "NET_CORE_TEST_SECRET" })).toEqual({
				user: "u",
				secret: "from-env",
			});
		});

		it("falls back to the literal when the env var is unset", () => {
			expect(resolveCredentials({ user: "u", secret: "literal-secret" }).secret).toBe("literal-secret");
		});

		it("treats set-but-empty as missing credential", () => {
			process.env.NET_CORE_TEST_SECRET = "";
			expect(() => resolveCredentials({ user: "u", secret: "NET_CORE_TEST_SECRET" })).toThrow(/missing/i);
		});

		it("requires a user and a secret", () => {
			expect(() => resolveCredentials({})).toThrow(/username/);
			expect(() => resolveCredentials({ user: "u" })).toThrow(/password/);
		});

		it("resolves !-prefixed secretCommand output and caches it", () => {
			const first = resolveCredentials({ user: "u", secretCommand: "!printf cached-output" });
			const second = resolveCredentials({ user: "u", secretCommand: "!printf cached-output" });
			expect(first.secret).toBe("cached-output");
			expect(second.secret).toBe("cached-output");
		});

		it("fails closed on a failing secretCommand", () => {
			expect(() => resolveCredentials({ user: "u", secretCommand: "!exit 3" })).toThrow(/shell command/);
		});
	});

	describe("tcpConnect", () => {
		it("wraps connection failures in NetConnectError naming the target", async () => {
			// Port 1 on localhost is reserved/refused almost everywhere.
			await expect(tcpConnect({ host: "127.0.0.1", port: 1, connectTimeoutMs: 1500 })).rejects.toThrow(
				/127.0.0.1:1/,
			);
		});

		it("refuses pre-aborted signals before dialing", async () => {
			const controller = new AbortController();
			controller.abort();
			await expect(tcpConnect({ host: "127.0.0.1", port: 1, signal: controller.signal })).rejects.toThrow(
				"Operation aborted",
			);
		});
	});

	describe("NetProtocolError", () => {
		it("carries the verbatim reply", () => {
			const direct = new NetProtocolError("X failed.", "599 weird refusal\r\n");
			expect(direct.reply).toContain("599 weird refusal");
			expect(direct.message).toContain("599 weird refusal");
			expect(direct.code).toBe("NET_PROTOCOL");
		});
	});
});
