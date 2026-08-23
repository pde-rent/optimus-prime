import { describe, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("probe2", () => {
	it("openssl via spawnSync", () => {
		const dir = mkdtempSync(join(tmpdir(), "probe-"));
		const which = Bun.which("openssl");
		const proc = Bun.spawnSync(
			[
				which ?? "/usr/bin/openssl",
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
			{ stderr: "ignore" },
		);
		console.error("EXIT:", proc.exitCode);
		console.error("FILES:", require("fs").readdirSync(dir));
	});
});
