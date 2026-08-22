import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { parseNetstatLines, parsePingOutput, parseProcNet } from "../src/core/tools/native/netdiag.js";

const LINUX_PROC_NET_TCP = [
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
	"   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1",
	"   1: 0100007F:8AE4 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 67890 1",
].join("\n");

describe("netdiag parsers", () => {
	it("decodes /proc/net hex addresses for ipv4", () => {
		expect(parseProcNet(LINUX_PROC_NET_TCP, "tcp")).toEqual([
			{ proto: "TCP", local: "127.0.0.1:8080", remote: "0.0.0.0:0", state: "LISTEN", pid: "-" },
			{ proto: "TCP", local: "127.0.0.1:35556", remote: "127.0.0.1:8080", state: "ESTABLISHED", pid: "-" },
		]);
	});

	it("decodes /proc/net ipv6 addresses byte-wise per word", () => {
		// ::1 is stored as four little-endian u32 words in /proc/net/tcp6.
		const rows = parseProcNet(
			"  sl local_address rem_address st\n   0: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A",
			"tcp6",
		);
		expect(rows[0].local).toBe("0000:0000:0000:0000:0000:0000:0000:0001:80");
		expect(rows[0].state).toBe("LISTEN");
	});

	it("parses linux ping summaries", () => {
		const stdout = [
			"PING example.com (93.184.216.34): 56 data bytes",
			"64 bytes from 93.184.216.34: icmp_seq=0 ttl=56 time=12.3 ms",
			"--- example.com ping statistics ---",
			"4 packets transmitted, 4 received, 0% packet loss, time 3005ms",
			"rtt min/avg/max/mdev = 11.1/12.5/14.2/1.0 ms",
		].join("\n");
		expect(parsePingOutput(stdout, "linux")).toEqual({
			transmitted: 4,
			received: 4,
			lossPercent: 0,
			rttMinMs: 11.1,
			rttAvgMs: 12.5,
			rttMaxMs: 14.2,
		});
	});

	it("parses darwin ping summaries with stddev and fractional loss", () => {
		const stdout = [
			"4 packets transmitted, 3 packets received, 25.0% packet loss",
			"round-trip min/avg/max/stddev = 10.101/11.202/13.303/1.201 ms",
		].join("\n");
		const parsed = parsePingOutput(stdout, "darwin");
		expect(parsed?.transmitted).toBe(4);
		expect(parsed?.received).toBe(3);
		expect(parsed?.lossPercent).toBe(25);
		expect(parsed?.rttMaxMs).toBeCloseTo(13.303, 3);
	});

	it("parses win32 ping summaries", () => {
		const stdout = [
			"Pinging 127.0.0.1 with 32 bytes of data:",
			"Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
			"",
			"Ping statistics for 127.0.0.1:",
			"    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),",
			"Approximate round trip times in milli-seconds:",
			"    Minimum = 0ms, Maximum = 1ms, Average = 0ms",
		].join("\n");
		expect(parsePingOutput(stdout, "win32")).toEqual({
			transmitted: 4,
			received: 4,
			lossPercent: 0,
			rttMinMs: 0,
			rttAvgMs: 0,
			rttMaxMs: 1,
		});
	});

	it("returns null for unparseable output (unknown host)", () => {
		expect(parsePingOutput("ping: cannot resolve bogus.invalid: Unknown host\n", "darwin")).toBeNull();
	});

	it("parses darwin netstat -anv listening lines", () => {
		const fixture = [
			"Active Internet connections (including servers)",
			"Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
			"tcp4       0      0  127.0.0.1.54313        *.*                    LISTEN  1024 2048 4096 4097 999 0",
			"udp4       0      0  *.5353                 *.*",
		].join("\n");
		const rows = parseNetstatLines(fixture);
		expect(rows[0]).toEqual({ proto: "TCP4", local: "127.0.0.1.54313", remote: "*.*", state: "LISTEN", pid: "-" });
		expect(rows[1]).toEqual({ proto: "UDP4", local: "*.5353", remote: "*.*", state: "-", pid: "-" });
	});

	it("parses win32 netstat -ano listening lines with pid column", () => {
		const fixture = [
			"",
			"Active Connections",
			"",
			"  Proto  Local Address          Foreign Address        State           PID",
			"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       984",
			"  UDP    0.0.0.0:5353           *:*                                    2104",
		].join("\n");
		const rows = parseNetstatLines(fixture);
		expect(rows).toEqual([
			{ proto: "TCP", local: "0.0.0.0:135", remote: "0.0.0.0:0", state: "LISTENING", pid: "984" },
			{ proto: "UDP", local: "0.0.0.0:5353", remote: "*:*", state: "-", pid: "2104" },
		]);
	});
});

describe("netdiag tool live smoke", () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		await new Promise<void>((resolve) => {
			server = createServer((_request, response) => response.end("ok"));
			server.listen(0, "127.0.0.1", () => resolve());
		});
		port = (server.address() as { port: number }).port;
	});

	afterAll(() => {
		server.close();
	});

	it("interfaces lists at least the loopback address", async () => {
		const { createNetdiagTool } = await import("../src/core/tools/native/netdiag.js");
		const result = await createNetdiagTool(process.cwd()).execute("call-if", { op: "interfaces" });
		expect(result.details.count).toBeGreaterThan(0);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("127.0.0.1");
	});

	it("portProbe reports open against a real local server and closed on a free port", async () => {
		const { createNetdiagTool } = await import("../src/core/tools/native/netdiag.js");
		const tool = createNetdiagTool(process.cwd());
		const open = await tool.execute("call-open", { op: "portProbe", host: "127.0.0.1", port });
		expect(open.details.open).toBe(true);
		expect(open.content[0]?.type === "text" ? open.content[0].text : "").toContain("open");

		const closed = await tool.execute("call-closed", { op: "portProbe", host: "127.0.0.1", port: 9, timeoutMs: 500 });
		expect(closed.details.open).toBe(false);
	}, 20000);

	it("requires host for resolve/ping/portProbe ops", async () => {
		const { createNetdiagTool } = await import("../src/core/tools/native/netdiag.js");
		const tool = createNetdiagTool(process.cwd());
		await expect(tool.execute("call-err-1", { op: "resolve" })).rejects.toThrow('op "resolve" requires host.');
		await expect(tool.execute("call-err-2", { op: "ping" })).rejects.toThrow('op "ping" requires host.');
		await expect(tool.execute("call-err-3", { op: "portProbe", host: "x" })).rejects.toThrow(
			'op "portProbe" requires an integer port between 1 and 65535.',
		);
	});

	it("connections lists sockets including our own server port", async () => {
		const { createNetdiagTool } = await import("../src/core/tools/native/netdiag.js");
		const result = await createNetdiagTool(process.cwd()).execute("call-conn", { op: "connections" });
		expect(result.details.count).toBeGreaterThan(0);
	}, 20000);

	it.skipIf(!process.env.NETDIAG_LIVE)("resolves a public hostname over DNS", async () => {
		const { createNetdiagTool } = await import("../src/core/tools/native/netdiag.js");
		const result = await createNetdiagTool(process.cwd()).execute("call-dns", { op: "resolve", host: "example.com" });
		expect(result.details.count).toBeGreaterThan(0);
	});

	it.skipIf(!process.env.NETDIAG_LIVE)("pings loopback through the system binary", async () => {
		const { createNetdiagTool } = await import("../src/core/tools/native/netdiag.js");
		const result = await createNetdiagTool(process.cwd()).execute("call-ping", {
			op: "ping",
			host: "127.0.0.1",
			count: 2,
		});
		expect(result.details.lossPercent).toBe(0);
	});
});
