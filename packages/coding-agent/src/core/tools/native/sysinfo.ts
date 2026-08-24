import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { clampInt, formatTable, runBinary } from "./sysutil.js";

const sysinfoSchema = Type.Object(
	{
		diskLimit: Type.Optional(
			Type.Number({ description: "Maximum number of mounted filesystems to report (default 16, hard cap 64)." }),
		),
	},
	{ additionalProperties: false },
);

export type SysinfoToolInput = Static<typeof sysinfoSchema>;

export interface SysinfoToolDetails {
	hostname: string;
	platform: string;
	arch: string;
	uptimeSec: number;
	cpuModel: string;
	cpuCount: number;
	memTotalBytes: number;
	memAvailableBytes: number;
	/** used/total as 0..1; the memory pressure signal. */
	pressureRatio: number;
	filesystemCount: number;
}

export interface DiskUsage {
	mount: string;
	filesystem: string;
	totalBytes: number;
	usedBytes: number;
	inodesTotal: number | null;
	inodesFree: number | null;
}

/** Parse MemTotal/MemFree/MemAvailable (kB) out of /proc/meminfo. */
export function parseMemInfo(text: string): { totalKb: number; freeKb: number; availableKb: number | null } {
	let totalKb = 0;
	let freeKb = 0;
	let availableKb: number | null = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("MemTotal:")) totalKb = Number(line.split(/\s+/)[1]);
		else if (line.startsWith("MemFree:")) freeKb = Number(line.split(/\s+/)[1]);
		else if (line.startsWith("MemAvailable:")) availableKb = Number(line.split(/\s+/)[1]);
	}
	return { totalKb, freeKb, availableKb };
}

/**
 * Parse vm_stat output (darwin). Approximate "available" as free + inactive +
 * speculative + purgeable pages - closer to reality than os.freemem, which on
 * macOS reports only truly-free pages.
 */
export function parseVmStat(text: string): { pageSize: number; freePages: number; availablePages: number } | null {
	const pageSizeMatch = text.match(/page size of (\d+) bytes/);
	if (!pageSizeMatch) return null;
	const pagesOf = (label: string): number => {
		const match = text.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
		return match ? Number(match[1]) : 0;
	};
	return {
		pageSize: Number(pageSizeMatch[1]),
		freePages: pagesOf("Pages free"),
		availablePages:
			pagesOf("Pages free") + pagesOf("Pages inactive") + pagesOf("Pages speculative") + pagesOf("Pages purgeable"),
	};
}

const DF_LINE = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/;

/** Parse df -kP output (skipping the header row) into filesystem rows. */
export function parseDfK(text: string): Array<{ filesystem: string; totalKb: number; usedKb: number; mount: string }> {
	const rows: Array<{ filesystem: string; totalKb: number; usedKb: number; mount: string }> = [];
	for (const line of text.split("\n").slice(1)) {
		const match = line.match(DF_LINE);
		if (!match) continue;
		rows.push({ filesystem: match[1], totalKb: Number(match[2]), usedKb: Number(match[3]), mount: match[6] });
	}
	return rows;
}

/** Parse wmic logicaldisk ... /format:csv into drive rows. */
export function parseWmicDisks(text: string): Array<{ caption: string; sizeBytes: number; freeBytes: number }> {
	const rows: Array<{ caption: string; sizeBytes: number; freeBytes: number }> = [];
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length < 2) return rows;
	const header = lines[0].split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
	const idxCaption = header.indexOf("Caption");
	const idxSize = header.indexOf("Size");
	const idxFree = header.indexOf("FreeSpace");
	if (idxCaption === -1 || idxSize === -1 || idxFree === -1) return rows;
	for (const line of lines.slice(1)) {
		const cells = line.split(",");
		const caption = cells[idxCaption]?.trim() ?? "";
		if (!caption) continue;
		rows.push({
			caption,
			sizeBytes: Number(cells[idxSize]) || 0,
			freeBytes: Number(cells[idxFree]) || 0,
		});
	}
	return rows;
}

function statfsDisk(mount: string): DiskUsage | null {
	try {
		const stats = statfsSync(mount);
		return {
			mount,
			filesystem: "",
			totalBytes: stats.blocks * stats.bsize,
			usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
			inodesTotal: stats.files,
			inodesFree: stats.ffree,
		};
	} catch {
		return null; // EPERM or raced unmount: skip quietly.
	}
}

async function collectDisks(limit: number): Promise<DiskUsage[]> {
	const hasStatfs = typeof statfsSync === "function";
	const disks: DiskUsage[] = [];

	if (process.platform === "win32") {
		let drives: Array<{ caption: string; sizeBytes: number; freeBytes: number }> = [];
		if (hasStatfs) {
			for (let code = 65; code <= 90; code++) {
				const caption = `${String.fromCharCode(code)}:\\`;
				if (!existsSync(caption)) continue;
				try {
					const stats = statfsSync(caption);
					drives.push({
						caption,
						sizeBytes: stats.blocks * stats.bsize,
						freeBytes: stats.bfree * stats.bsize,
					});
				} catch {}
			}
		}
		if (drives.length === 0) {
			const result = await runBinary("wmic.exe", ["logicaldisk", "get", "Caption,FreeSpace,Size", "/format:csv"]);
			drives = parseWmicDisks(result.stdout);
		}
		for (const drive of drives.slice(0, limit)) {
			disks.push({
				mount: drive.caption,
				filesystem: "-",
				totalBytes: drive.sizeBytes,
				usedBytes: Math.max(drive.sizeBytes - drive.freeBytes, 0),
				inodesTotal: null,
				inodesFree: null,
			});
		}
		return disks;
	}

	if (process.platform === "darwin") {
		const result = await runBinary("df", ["-kP"]);
		for (const row of parseDfK(result.stdout)) {
			if (/^devfs$|^fdesc$/.test(row.filesystem)) continue;
			const disk: DiskUsage = {
				mount: row.mount,
				filesystem: row.filesystem,
				totalBytes: row.totalKb * 1024,
				usedBytes: row.usedKb * 1024,
				inodesTotal: null,
				inodesFree: null,
			};
			if (hasStatfs) {
				const enriched = statfsDisk(row.mount);
				if (enriched) {
					disk.totalBytes = enriched.totalBytes > 0 ? enriched.totalBytes : disk.totalBytes;
					disk.usedBytes = enriched.usedBytes > 0 ? enriched.usedBytes : disk.usedBytes;
					disk.inodesTotal = enriched.inodesTotal;
					disk.inodesFree = enriched.inodesFree;
				}
			}
			disks.push(disk);
		}
		return disks.slice(0, limit);
	}

	// linux: enumerate real mounts from /proc/mounts and statfs each.
	const pseudo = new Set([
		"proc",
		"sysfs",
		"devtmpfs",
		"devpts",
		"securityfs",
		"pstore",
		"debugfs",
		"tracefs",
		"configfs",
		"fusectl",
		"autofs",
		"mqueue",
		"hugetlbfs",
		"efivarfs",
		"bpf",
		"binfmt_misc",
		"cgroup",
		"cgroup2",
		"ramfs",
		"rpc_pipefs",
		"overlay",
		"squashfs",
	]);
	const mounts: Array<{ device: string; mount: string; fstype: string }> = [];
	const seen = new Set<string>();
	try {
		for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
			const parts = line.split(" ");
			if (parts.length < 3) continue;
			const [device, mountPoint, fstype] = parts;
			if (pseudo.has(fstype)) continue;
			const key = `${device}:${mountPoint}`;
			if (seen.has(key)) continue;
			seen.add(key);
			mounts.push({ device, mount: mountPoint.replaceAll("\\040", " "), fstype });
		}
	} catch {
		// No readable /proc/mounts: df fallback below.
	}
	for (const entry of mounts) {
		if (disks.length >= limit) break;
		if (!hasStatfs) break;
		const disk = statfsDisk(entry.mount);
		if (!disk) continue;
		disk.filesystem = entry.fstype;
		disks.push(disk);
	}
	if (disks.length === 0) {
		const result = await runBinary("df", ["-kP"]);
		for (const row of parseDfK(result.stdout).slice(0, limit)) {
			disks.push({
				mount: row.mount,
				filesystem: row.filesystem,
				totalBytes: row.totalKb * 1024,
				usedBytes: row.usedKb * 1024,
				inodesTotal: null,
				inodesFree: null,
			});
		}
	}
	return disks;
}

function humanBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/**
 * One-shot host overview cross-platform: identity, load, CPU model and
 * per-core times, memory with a pressure ratio, per-mount disk usage.
 *
 * Use it for machine-level health questions. Do not use it for per-process
 * detail (use processes), network state or connectivity checks (use netdiag),
 * or continuous monitoring - it is a single snapshot, not top.
 */
export function createSysinfoToolDefinition(cwd: string): ToolDefinition<typeof sysinfoSchema, SysinfoToolDetails> {
	void cwd;
	const definition: ToolDefinition<typeof sysinfoSchema, SysinfoToolDetails> = {
		name: "sysinfo",
		label: "sysinfo",
		description:
			"One host-health snapshot: hostname/platform/uptime/load, CPU model, cores and per-core times, memory pressure, disk usage per mount - the default and fastest way to answer machine-level questions; runs in-process on Windows/macOS/Linux; replaces parsing bash uptime/uname/free/df. Per-process detail - use processes; network - use netdiag.",
		promptSnippet: "One-shot host overview: CPU/load/memory/disk; replaces uptime/uname/free/df parsing",
		parameters: sysinfoSchema,
		executionMode: "parallel",
		kind: "system",
		read_only: true,
		async execute(
			_toolCallId,
			input: SysinfoToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: SysinfoToolDetails }> {
			throwIfAborted(signal);
			const cpus = os.cpus();
			let memTotalBytes = os.totalmem();
			let memFreeBytes = os.freemem();
			let memAvailableBytes = memFreeBytes;

			if (process.platform === "linux") {
				try {
					const info = parseMemInfo(readFileSync("/proc/meminfo", "utf8"));
					if (info.totalKb > 0) {
						memTotalBytes = info.totalKb * 1024;
						memFreeBytes = info.freeKb * 1024;
						memAvailableBytes = (info.availableKb ?? info.freeKb) * 1024;
					}
				} catch {
					// Keep os fallbacks when /proc/meminfo is unreadable.
				}
			} else if (process.platform === "darwin") {
				try {
					const vmstat = await runBinary("vm_stat", []);
					const parsed = parseVmStat(vmstat.stdout);
					if (parsed) {
						memAvailableBytes = parsed.availablePages * parsed.pageSize;
						memFreeBytes = parsed.freePages * parsed.pageSize;
					}
				} catch {
					// vm_stat missing or failed: keep os.freemem.
				}
			}
			const memUsedBytes = Math.max(memTotalBytes - memAvailableBytes, 0);
			const pressureRatio = memTotalBytes > 0 ? memUsedBytes / memTotalBytes : 0;

			const diskLimit = clampInt(input.diskLimit, 16, 1, 64);
			const disks = await collectDisks(diskLimit);

			const lines: string[] = [
				"host: hostname=" +
					os.hostname() +
					" platform=" +
					process.platform +
					" arch=" +
					process.arch +
					" uptime=" +
					Math.round(os.uptime()) +
					"s loadavg=" +
					os
						.loadavg()
						.map((v) => v.toFixed(2))
						.join(" "),
				"cpu: model=" +
					(cpus[0]?.model?.trim() || "-") +
					" cores=" +
					cpus.length +
					" speed=" +
					(cpus[0]?.speed ?? "-") +
					"MHz",
			];
			const coreRows = cpus.map((cpu, index) => [
				String(index),
				String(cpu.times.user),
				String(cpu.times.nice),
				String(cpu.times.sys),
				String(cpu.times.idle),
				String(cpu.times.irq),
			]);
			lines.push(formatTable(coreRows, ["CORE", "USER_MS", "NICE_MS", "SYS_MS", "IDLE_MS", "IRQ_MS"]));
			lines.push(
				"memory: total=" +
					humanBytes(memTotalBytes) +
					" available=" +
					humanBytes(memAvailableBytes) +
					" free=" +
					humanBytes(memFreeBytes) +
					" used=" +
					humanBytes(memUsedBytes) +
					" pressure=" +
					(pressureRatio * 100).toFixed(1) +
					"%",
			);
			const diskRows = disks.map((disk) => [
				disk.mount,
				disk.filesystem || "-",
				humanBytes(disk.usedBytes),
				humanBytes(disk.totalBytes),
				disk.totalBytes > 0 ? `${((disk.usedBytes / disk.totalBytes) * 100).toFixed(0)}%` : "-",
				disk.inodesTotal === null ? "-" : String(disk.inodesFree),
			]);
			lines.push(formatTable(diskRows, ["MOUNT", "FS", "USED", "TOTAL", "USE%", "INODES_FREE"]));

			const truncation = truncateHead(lines.join("\n"));
			return {
				content: [{ type: "text", text: truncation.content }],
				details: {
					hostname: os.hostname(),
					platform: process.platform,
					arch: process.arch,
					uptimeSec: Math.round(os.uptime()),
					cpuModel: cpus[0]?.model?.trim() ?? "",
					cpuCount: cpus.length,
					memTotalBytes,
					memAvailableBytes,
					pressureRatio,
					filesystemCount: disks.length,
				},
			};
		},
	};
	return definition;
}

export function createSysinfoTool(cwd: string) {
	return wrapToolDefinition(createSysinfoToolDefinition(cwd));
}
