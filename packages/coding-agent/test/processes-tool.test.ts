import { describe, expect, it } from "bun:test";
import { platform } from "process";
import {
	killProcessGuarded,
	parseCpuTimeToSeconds,
	parseDarwinPsLine,
	parseLinuxStat,
	parseTasklistCsv,
} from "../src/core/tools/native/processes.js";

describe("processes parsers", () => {
	it("parses /proc/[pid]/stat fields after the comm parenthesis", () => {
		const stat =
			"1234 (some proc) S 1200 1200 1200 34816 1200 4194304 34000 0 0 0 150 60 0 0 20 5 1 0 987654 1234567890 5432 18446744073709551615";
		const parsed = parseLinuxStat(stat);
		expect(parsed).not.toBeNull();
		expect(parsed?.state).toBe("S");
		expect(parsed?.ppid).toBe(1200);
		// utime=150 stime=60 ticks at CLK_TCK=100 -> 2.1 CPU seconds
		expect(parsed?.cpuSeconds).toBeCloseTo(2.1, 5);
		expect(parsed?.startTimeTicks).toBe(987654);
	});

	it("handles comm containing closing parentheses", () => {
		const stat = "99 (weird)name) R 1 0 0 0 0 0 0 0 0 0 10 0 0 0 0 0 0 0 5 100 20";
		const parsed = parseLinuxStat(stat);
		expect(parsed?.comm).toBe("weird)name");
		expect(parsed?.state).toBe("R");
	});

	it("parses darwin ps lines with command containing spaces", () => {
		const row = parseDarwinPsLine(" 4711   342 root 12.50 262144 S /usr/sbin/sshd -i");
		expect(row).toEqual({
			pid: 4711,
			ppid: 342,
			user: "root",
			state: "S",
			cpuPercent: 12.5,
			memRssBytes: 268435456,
			command: "/usr/sbin/sshd -i",
		});
		expect(parseDarwinPsLine("garbage")).toBeNull();
	});

	it("parses tasklist csv /nh rows including quoted mem with commas", () => {
		const csv = [
			'"Chrome.exe","4242","Console","1","123,456 K"',
			'"System Idle Process","0","Services","0","8 K"',
		].join("\n");
		const rows = parseTasklistCsv(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: "Chrome.exe", pid: 4242, memRssBytes: 123456 * 1024 });
		expect(rows[1].pid).toBe(0);
	});

	it("parses ps TIME values across shapes", () => {
		expect(parseCpuTimeToSeconds("30.05")).toBeCloseTo(30.05, 3);
		expect(parseCpuTimeToSeconds("04:12.10")).toBeCloseTo(252.1, 3);
		expect(parseCpuTimeToSeconds("01:02:03.00")).toBeCloseTo(3723, 3);
		expect(parseCpuTimeToSeconds("1-02:03:04.00")).toBeCloseTo(93784, 3);
	});
});

describe("processes kill guard", () => {
	it("requires force for SIGKILL", async () => {
		await expect(killProcessGuarded(process.pid, "SIGKILL", false)).rejects.toThrow(
			/Signal SIGKILL requires force: true\./,
		);
	});

	it("rejects invalid signal names", async () => {
		await expect(killProcessGuarded(process.pid, "not-a-signal", true)).rejects.toThrow(/Invalid kill signal:/);
	});

	it("refuses to signal its own pid even with force", async () => {
		await expect(killProcessGuarded(process.pid, "SIGKILL", true)).rejects.toThrow(
			/it is this agent's own process\./,
		);
	});

	it("reports ESRCH as No such process for an impossible pid", async () => {
		if (platform === "win32") return; // ESRCH mapping differs behind win32 signals.
		await expect(killProcessGuarded(2147483000, "SIGTERM", false)).rejects.toThrow(/^No such process: 2147483000\.$/);
	});
});

describe("processes tool live smoke", () => {
	it("lists real processes sorted by cpu with capped rows", async () => {
		const { createProcessesTool } = await import("../src/core/tools/native/processes.js");
		const tool = createProcessesTool(process.cwd());
		const result = await tool.execute("call-list", { op: "list", limit: 3 });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.split("\n")[0]).toContain("PID");
		expect(result.details.op).toBe("list");
		expect(result.details.count).toBeLessThanOrEqual(3);
		expect(result.details.truncated).toBe(false);
	}, 20000);

	it("samples cpu deltas over a tiny interval", async () => {
		const { createProcessesTool } = await import("../src/core/tools/native/processes.js");
		const tool = createProcessesTool(process.cwd());
		const result = await tool.execute("call-sample", { op: "sample", intervalMs: 50, limit: 5 });
		expect(result.details.op).toBe("sample");
		expect(result.details.count).toBeLessThanOrEqual(5);
	}, 20000);
});
