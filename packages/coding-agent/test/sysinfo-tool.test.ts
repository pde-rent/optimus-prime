import { describe, expect, it } from "bun:test";
import os from "node:os";
import { parseDfK, parseMemInfo, parseVmStat, parseWmicDisks } from "../src/core/tools/native/sysinfo.js";

describe("sysinfo parsers", () => {
	it("parses /proc/meminfo totals with and without MemAvailable", () => {
		const modern = [
			"MemTotal:       16384000 kB",
			"MemFree:         1024000 kB",
			"MemAvailable:    8192000 kB",
			"Buffers:           65536 kB",
		].join("\n");
		expect(parseMemInfo(modern)).toEqual({ totalKb: 16384000, freeKb: 1024000, availableKb: 8192000 });

		const legacy = "MemTotal:  100 kB\nMemFree:   40 kB\nSwapTotal: 1 kB";
		expect(parseMemInfo(legacy)).toEqual({ totalKb: 100, freeKb: 40, availableKb: null });
	});

	it("parses vm_stat output into page-size-normalised availability", () => {
		const fixture = [
			"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
			"Pages free:                              39206.",
			"Pages active:                           780431.",
			"Pages inactive:                         355892.",
			"Pages speculative:                       61204.",
			"Pages purgeable:                        123456.",
		].join("\n");
		const parsed = parseVmStat(fixture);
		expect(parsed?.pageSize).toBe(16384);
		expect(parsed?.freePages).toBe(39206);
		expect(parsed?.availablePages).toBe(39206 + 355892 + 61204 + 123456);

		expect(parseVmStat("not vm_stat output")).toBeNull();
	});

	it("parses df -kP rows, skipping the header and two-word pseudo mounts", () => {
		const fixture = [
			"Filesystem 1024-blocks      Used Available Capacity  Mounted on",
			"/dev/disk3s1  482349856 315494400 166605056    66%    /",
			"map auto_home         0         0         0   100%    /System/Volumes/Data/home",
		].join("\n");
		const rows = parseDfK(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			filesystem: "/dev/disk3s1",
			totalKb: 482349856,
			usedKb: 315494400,
			mount: "/",
		});
	});

	it("parses wmic logicaldisk csv output", () => {
		const fixture = ["Node,Caption,FreeSpace,Size", "DESKPY,C:,53561368576,254721724416", "DESKPY,D:,0,"].join("\n");
		const rows = parseWmicDisks(fixture);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ caption: "C:", sizeBytes: 254721724416, freeBytes: 53561368576 });
		expect(rows[1].sizeBytes).toBe(0);
	});
});

describe("sysinfo tool live smoke", () => {
	it("returns host facts including hostname, pressure ratio and filesystems", async () => {
		const { createSysinfoTool } = await import("../src/core/tools/native/sysinfo.js");
		const tool = createSysinfoTool(process.cwd());
		const result = await tool.execute("call-sysinfo", {});
		expect(result.details.hostname).toBe(os.hostname());
		expect(result.details.platform).toBe(process.platform);
		expect(result.details.cpuCount).toBe(os.cpus().length);
		expect(result.details.pressureRatio).toBeGreaterThanOrEqual(0);
		expect(result.details.pressureRatio).toBeLessThanOrEqual(1);
		expect(result.details.filesystemCount).toBeGreaterThan(0);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("host: hostname=");
		expect(text).toContain("memory: total=");
		expect(text).toContain("MOUNT");
	}, 30000);
});
