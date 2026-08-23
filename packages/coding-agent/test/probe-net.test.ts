import { describe, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("dial real fixture", () => {
	it("greeting", async () => {
		const src = await Bun.file("test/smtp.test.ts").text();
		const re = /NODE_STARTTLS_SERVER_SCRIPT = `([\s\S]*?)`;/;
		const script = eval("`" + src.match(re)![1] + "`");
		console.error("SCRIPT conn-log:", script.includes("[fixture] connection from"));
		const dir = mkdtempSync(join(tmpdir(), "smtp-tls-"));
		const openssl = Bun.which("openssl") ?? "/usr/bin/openssl";
		Bun.spawnSync(
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
		const proc = Bun.spawn(["node", "-e", script, dir], { stdout: "pipe", stderr: "pipe" });
		const reader = proc.stdout.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let match: RegExpMatchArray | null = null;
		while (!match) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			match = buf.match(/PORT (\d+)\r?\n/);
		}
		console.error("PORT MATCH:", match?.[1], "raw:", JSON.stringify(buf));
		if (!match) {
			console.error("NO PORT");
			process.exit(1);
		}
		const { tcpConnect, LineProtocol } = await import("../src/core/net/core.js");
		const conn = await tcpConnect({ host: "127.0.0.1", port: Number(match[1]) });
		const lp = new LineProtocol(conn);
		console.error("GREET:", await lp.readLine({ timeoutMs: 4000 }));
		conn.destroy();
		proc.kill();
	});
});
