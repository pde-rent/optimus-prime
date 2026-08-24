import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { clampInt, formatTable, runBinary, sleep } from "./sysutil.js";

/** Linux kernels tick at CLK_TCK=100 in practice; /proc exposes no userspace way to query it. */
const LINUX_HZ = 100;

/** Memory page size, probed from the process report when available (default 4096). */
const PAGE_SIZE: number = (() => {
	const header = (process as { report?: { getReport?: () => { header?: { pageSize?: number } } } }).report;
	const size = typeof header?.getReport === "function" ? header.getReport().header?.pageSize : undefined;
	return typeof size === "number" && size > 0 ? size : 4096;
})();

const processesSchema = Type.Object(
	{
		op: Type.Union([Type.Literal("list"), Type.Literal("sample"), Type.Literal("kill")], {
			description:
				"list = one ps-style snapshot; sample = two-snapshot top-style CPU deltas over intervalMs; kill = signal one pid.",
		}),
		sortBy: Type.Optional(
			Type.Union([Type.Literal("cpu"), Type.Literal("mem")], {
				description: "list only: order rows by CPU percent (default) or resident memory, descending.",
			}),
		),
		limit: Type.Optional(
			Type.Number({ description: "list/sample only: maximum rows shown (default 25, hard cap 500)." }),
		),
		intervalMs: Type.Optional(
			Type.Number({
				description: "sample only: wall time between the two snapshots (default 500ms, clamped 50-5000).",
			}),
		),
		pid: Type.Optional(Type.Number({ description: "kill only: process id to signal." })),
		signal: Type.Optional(
			Type.String({
				description:
					"kill only: POSIX signal name such as SIGTERM (default), SIGINT, SIGKILL. SIGKILL requires force.",
			}),
		),
		force: Type.Optional(
			Type.Boolean({
				description: "kill only: must be set true together with signal SIGKILL as the destructive-force guard.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ProcessesToolInput = Static<typeof processesSchema>;

export interface ProcessesToolDetails {
	op: "list" | "sample" | "kill";
	/** Rows listed/sampled, or 1 for a delivered kill. */
	count: number;
	/** Whether the table was cut by the line/byte caps (list/sample). */
	truncated: boolean;
}

interface ProcRow {
	pid: number;
	ppid: number | null;
	user: string;
	state: string;
	cpuPercent: number;
	memRssBytes: number;
	command: string;
}

function humanRss(bytes: number): string {
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.round(kb)}K`;
	return `${(kb / 1024).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Linux: pure-TS /proc readers
// ---------------------------------------------------------------------------

interface LinuxStat {
	state: string;
	ppid: number;
	cpuSeconds: number;
	startTimeTicks: number;
	rssBytes: number;
	comm: string;
}

/**
 * Parse /proc/[pid]/stat body after "pid (comm)": rest[0]=state rest[1]=ppid
 * rest[11]=utime rest[12]=stime rest[19]=starttime rest[21]=rss(pages).
 */
export function parseLinuxStat(statText: string): LinuxStat | null {
	const closeParen = statText.lastIndexOf(")");
	if (closeParen === -1) return null;
	const openParen = statText.indexOf("(");
	if (openParen === -1) return null;
	const comm = statText.slice(openParen + 1, closeParen);
	const fields = statText
		.slice(closeParen + 2)
		.trim()
		.split(/\s+/);
	const ppid = Number(fields[1]);
	return {
		state: fields[0] ?? "?",
		ppid: Number.isFinite(ppid) ? ppid : 0,
		cpuSeconds: ((Number(fields[11]) || 0) + (Number(fields[12]) || 0)) / LINUX_HZ,
		startTimeTicks: Number(fields[19]) || 0,
		rssBytes: (Number(fields[21]) || 0) * PAGE_SIZE,
		comm,
	};
}

function readLinuxUserMap(): Map<string, string> {
	const map = new Map<string, string>();
	try {
		for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
			const parts = line.split(":");
			if (parts.length >= 3) map.set(parts[2], parts[0]);
		}
	} catch {
		// No /etc/passwd (rare); fall back to numeric uids.
	}
	return map;
}

async function listProcessesLinux(sortBy: "cpu" | "mem"): Promise<ProcRow[]> {
	let uptimeSec: number;
	try {
		uptimeSec = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
	} catch {
		uptimeSec = os.uptime();
	}
	const users = readLinuxUserMap();
	const rows: ProcRow[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: LinuxStat | null;
		try {
			stat = parseLinuxStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
		} catch {
			continue; // Process vanished between readdir and read.
		}
		if (!stat) continue;
		let user = "";
		try {
			const status = readFileSync(`/proc/${entry}/status`, "utf8");
			const uidLine = status.split("\n").find((line) => line.startsWith("Uid:"));
			if (uidLine) {
				const uid = uidLine.split(/\s+/)[1];
				user = users.get(uid) ?? uid;
			}
		} catch {
			user = "";
		}
		let command = "";
		try {
			command = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ").trim();
		} catch {
			command = "";
		}
		if (!command) command = `[${stat.comm}]`;
		const elapsedSec = Math.max(uptimeSec - stat.startTimeTicks / LINUX_HZ, 0.01);
		rows.push({
			pid: Number(entry),
			ppid: stat.ppid,
			user: user || "-",
			state: stat.state,
			cpuPercent: (stat.cpuSeconds / elapsedSec) * 100,
			memRssBytes: stat.rssBytes,
			command,
		});
	}
	rows.sort((a, b) => (sortBy === "mem" ? b.memRssBytes - a.memRssBytes : b.cpuPercent - a.cpuPercent));
	return rows;
}

interface CpuDelta {
	pid: number;
	cpuDeltaPercent: number;
}

/** Two cumulative-CPU-time snapshots intervalMs apart become top-style per-pid percent deltas. */
async function sampleFromCumulativeSnapshots(
	takeSnapshot: () => Promise<Map<number, number>>,
	intervalMs: number,
	signal?: AbortSignal,
): Promise<CpuDelta[]> {
	const beforeWall = Date.now();
	const before = await takeSnapshot();
	await sleep(intervalMs);
	throwIfAborted(signal);
	const deltaWallSec = Math.max((Date.now() - beforeWall) / 1000, 0.001);
	const after = await takeSnapshot();
	const deltas: CpuDelta[] = [];
	for (const [pid, cpuBefore] of before) {
		const cpuAfter = after.get(pid);
		if (cpuAfter === undefined) continue;
		deltas.push({ pid, cpuDeltaPercent: ((cpuAfter - cpuBefore) / deltaWallSec) * 100 });
	}
	deltas.sort((a, b) => b.cpuDeltaPercent - a.cpuDeltaPercent);
	return deltas.slice(0, 200);
}

async function sampleProcessesLinux(intervalMs: number, signal?: AbortSignal): Promise<CpuDelta[]> {
	const snap = (): Map<number, number> => {
		const map = new Map<number, number>();
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const stat = parseLinuxStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
				if (stat) map.set(Number(entry), stat.cpuSeconds);
			} catch {
				// Vanished mid-sample: skip.
			}
		}
		return map;
	};
	return sampleFromCumulativeSnapshots(async () => snap(), intervalMs, signal);
}

// ---------------------------------------------------------------------------
// darwin: one ps spawn per snapshot
// ---------------------------------------------------------------------------

/** Parse one ps line shaped like: pid ppid user %cpu rss state command... */
export function parseDarwinPsLine(line: string): ProcRow | null {
	const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s?(.*)$/);
	if (!match) return null;
	return {
		pid: Number(match[1]),
		ppid: Number(match[2]),
		user: match[3],
		state: match[6],
		cpuPercent: Number(match[4]),
		memRssBytes: Number(match[5]) * 1024,
		command: match[7],
	};
}

async function listProcessesDarwin(sortBy: "cpu" | "mem"): Promise<ProcRow[]> {
	const result = await runBinary("ps", ["-axo", "pid=,ppid=,user=,%cpu=,rss=,state=,command="]);
	const rows = result.stdout
		.split("\n")
		.map(parseDarwinPsLine)
		.filter((row): row is ProcRow => row !== null);
	rows.sort((a, b) => (sortBy === "mem" ? b.memRssBytes - a.memRssBytes : b.cpuPercent - a.cpuPercent));
	return rows;
}

/** Parse a ps TIME value like "SS.cc", "MM:SS.cc" or "[DD-]HH:MM:SS.cc" into seconds. */
export function parseCpuTimeToSeconds(time: string): number {
	let rest = time;
	let days = 0;
	const dashIndex = rest.indexOf("-");
	if (dashIndex !== -1) {
		days = Number(rest.slice(0, dashIndex)) || 0;
		rest = rest.slice(dashIndex + 1);
	}
	const parts = rest.split(":");
	const seconds = Number(parts.pop() ?? 0) || 0;
	const minutes = Number(parts.pop() ?? 0) || 0;
	const hours = Number(parts.pop() ?? 0) || 0;
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

async function snapshotDarwinCpuTimes(): Promise<Map<number, number>> {
	const result = await runBinary("ps", ["-axo", "pid=,time="]);
	const map = new Map<number, number>();
	for (const line of result.stdout.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+([\d.-]+:[\d:.]+|[\d.]+)$/);
		if (match) map.set(Number(match[1]), parseCpuTimeToSeconds(match[2]));
	}
	return map;
}

async function sampleProcessesDarwin(intervalMs: number, signal?: AbortSignal): Promise<CpuDelta[]> {
	return sampleFromCumulativeSnapshots(snapshotDarwinCpuTimes, intervalMs, signal);
}

// ---------------------------------------------------------------------------
// win32: tasklist CSV + PowerShell CIM for ppid / cumulative times
// ---------------------------------------------------------------------------

/** Minimal CSV splitter handling quoted cells with commas (tasklist output shape). */
function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			quoted = !quoted;
		} else if (char === "," && !quoted) {
			cells.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	cells.push(current);
	return cells;
}

/** Parse tasklist /fo csv /nh output into image/pid/memKB rows. */
export function parseTasklistCsv(text: string): Array<{ name: string; pid: number; memRssBytes: number }> {
	const rows: Array<{ name: string; pid: number; memRssBytes: number }> = [];
	for (const line of text.split("\n")) {
		const cells = parseCsvLine(line);
		if (cells.length < 5) continue;
		const pid = Number(cells[1]);
		if (!Number.isFinite(pid)) continue;
		const memKb = Number(
			cells[4]
				.replaceAll(",", "")
				.replace(/[Kk]\s*$/, "")
				.trim(),
		);
		rows.push({
			name: cells[0].replace(/^"|"$/g, ""),
			pid,
			memRssBytes: (Number.isFinite(memKb) ? memKb : 0) * 1024,
		});
	}
	return rows;
}

async function powershellProcessCsv(properties: string[]): Promise<Array<Record<string, string>>> {
	const result = await runBinary("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`Get-CimInstance Win32_Process | Select-Object ${properties.join(",")} | ConvertTo-Csv -NoTypeInformation`,
	]);
	const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length < 2) return [];
	const header = parseCsvLine(lines[0]).map((cell) => cell.replace(/^"|"$/g, ""));
	return lines.slice(1).map((line) => {
		const cells = parseCsvLine(line);
		const record: Record<string, string> = {};
		header.forEach((name, i) => {
			record[name] = cells[i]?.replace(/^"|"$/g, "") ?? "";
		});
		return record;
	});
}

async function listProcessesWin32(sortBy: "cpu" | "mem"): Promise<ProcRow[]> {
	const result = await runBinary("tasklist.exe", ["/fo", "csv", "/nh"]);
	const base = parseTasklistCsv(result.stdout);
	let ppidByPid = new Map<number, number>();
	try {
		const records = await powershellProcessCsv(["ProcessId", "ParentProcessId"]);
		ppidByPid = new Map(records.map((record) => [Number(record.ProcessId), Number(record.ParentProcessId)]));
	} catch {
		// PowerShell unavailable or blocked: degrade to ppid=null instead of failing the listing.
	}
	const rows: ProcRow[] = base.map((row) => ({
		pid: row.pid,
		ppid: ppidByPid.get(row.pid) ?? null,
		user: "-",
		state: "-",
		cpuPercent: 0,
		memRssBytes: row.memRssBytes,
		command: row.name,
	}));
	rows.sort((a, b) => (sortBy === "mem" ? b.memRssBytes - a.memRssBytes : b.cpuPercent - a.cpuPercent));
	return rows;
}

async function sampleProcessesWin32(intervalMs: number, signal?: AbortSignal): Promise<CpuDelta[]> {
	const snap = async () => {
		const records = await powershellProcessCsv(["ProcessId", "UserModeTime", "KernelModeTime"]);
		const map = new Map<number, number>();
		for (const record of records) {
			map.set(Number(record.ProcessId), (Number(record.UserModeTime) + Number(record.KernelModeTime)) / 1e7);
		}
		return map;
	};
	return sampleFromCumulativeSnapshots(snap, intervalMs, signal);
}

// ---------------------------------------------------------------------------
// kill support: parent maps for ancestry checks
// ---------------------------------------------------------------------------

async function parentMapForPlatform(): Promise<Map<number, number>> {
	if (process.platform === "linux") {
		const map = new Map<number, number>();
		try {
			for (const entry of readdirSync("/proc")) {
				if (!/^\d+$/.test(entry)) continue;
				try {
					const stat = parseLinuxStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
					if (stat) map.set(Number(entry), stat.ppid);
				} catch {
					// Raced exit: ignore.
				}
			}
		} catch {
			// No readable /proc: empty map, only the self check applies.
		}
		return map;
	}
	if (process.platform === "win32") {
		const map = new Map<number, number>();
		try {
			for (const record of await powershellProcessCsv(["ProcessId", "ParentProcessId"])) {
				map.set(Number(record.ProcessId), Number(record.ParentProcessId));
			}
		} catch {
			// Degrade: no ancestry data means only the self check applies.
		}
		return map;
	}
	const result = await runBinary("ps", ["-axo", "pid=,ppid="]);
	const map = new Map<number, number>();
	for (const line of result.stdout.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
		if (match) map.set(Number(match[1]), Number(match[2]));
	}
	return map;
}

const SIGNAL_PATTERN = /^SIG[A-Z0-9]+$/;

/**
 * Deliver a signal with the house guards: explicit force for SIGKILL and an
 * ancestry/self check so this agent can never signal its own tree.
 */
export async function killProcessGuarded(pid: number, signalName: string, force: boolean): Promise<string> {
	const signal = signalName.toUpperCase();
	if (!SIGNAL_PATTERN.test(signal)) {
		throw new Error(`Invalid kill signal: ${signalName}. Use a POSIX name like SIGTERM.`);
	}
	if (signal === "SIGKILL" && !force) {
		throw new Error(`Signal SIGKILL requires force: true. Re-run with force to kill pid ${pid} unconditionally.`);
	}
	if (pid === process.pid) {
		throw new Error(`Refusing to kill pid ${pid}: it is this agent's own process.`);
	}
	const parents = await parentMapForPlatform();
	const seen = new Set<number>();
	let cursor: number | undefined = pid;
	while (cursor !== undefined && cursor > 0 && !seen.has(cursor)) {
		seen.add(cursor);
		if (cursor === process.pid) {
			throw new Error(`Refusing to kill pid ${pid}: it is an ancestor of this agent's own process.`);
		}
		cursor = parents.get(cursor);
	}
	try {
		process.kill(pid, signal as NodeJS.Signals);
	} catch (error: unknown) {
		const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
		if (code === "ESRCH") throw new Error(`No such process: ${pid}.`);
		if (code === "EPERM") throw new Error(`Permission denied signalling pid ${pid}: EPERM.`);
		throw new Error(`Could not signal pid ${pid} with ${signal}: ${code}.`);
	}
	return signal;
}

async function buildLinuxCommandMap(): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	try {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ").trim();
				if (cmdline) {
					map.set(Number(entry), cmdline);
					continue;
				}
				const stat = parseLinuxStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
				map.set(Number(entry), `[${stat?.comm ?? entry}]`);
			} catch {
				// Vanished: fine.
			}
		}
	} catch {
		// No readable /proc: leave commands blank.
	}
	return map;
}

/**
 * Inspect and manage OS processes cross-platform: ps-style listing, top-style
 * CPU sampling and guarded kills.
 *
 * Use it to answer "which process eats CPU/RAM right now?" or to stop a
 * runaway pid. Do not use it for host totals (memory pressure, load, disks -
 * sysinfo covers those) nor for sockets (netdiag). The kill op refuses this
 * agent's own pid and any ancestor of it, and SIGKILL requires force: true.
 */
export function createProcessesToolDefinition(
	cwd: string,
): ToolDefinition<typeof processesSchema, ProcessesToolDetails> {
	void cwd;
	const definition: ToolDefinition<typeof processesSchema, ProcessesToolDetails> = {
		name: "processes",
		label: "processes",
		description:
			"List, sample and kill OS processes: ps-style table, top-style CPU deltas, guarded kill - the default and fastest way to answer what is using CPU or memory; runs in-process on Windows/macOS/Linux; replaces parsing bash ps/top/kill. Refuses its own process tree; SIGKILL needs force:true. Host totals - use sysinfo.",
		promptSnippet: "Per-process CPU/RAM table, sampled CPU deltas, guarded kill; replaces ps/top/kill parsing",
		parameters: processesSchema,
		executionMode: "parallel",
		kind: "process",
		read_only: false,
		async execute(
			_toolCallId,
			input: ProcessesToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: ProcessesToolDetails }> {
			throwIfAborted(signal);

			if (input.op === "kill") {
				if (input.pid === undefined || !Number.isInteger(input.pid) || input.pid <= 0) {
					throw new Error('op "kill" requires a positive integer pid.');
				}
				const sent = await killProcessGuarded(input.pid, input.signal ?? "SIGTERM", input.force ?? false);
				return {
					content: [{ type: "text", text: `Sent ${sent} to pid ${input.pid}.` }],
					details: { op: "kill", count: 1, truncated: false },
				};
			}

			if (input.op === "sample") {
				const intervalMs = clampInt(input.intervalMs, 500, 50, 5000);
				const limit = clampInt(input.limit, 25, 1, 500);
				const deltas =
					process.platform === "win32"
						? await sampleProcessesWin32(intervalMs, signal)
						: process.platform === "darwin"
							? await sampleProcessesDarwin(intervalMs, signal)
							: await sampleProcessesLinux(intervalMs, signal);
				const commands = process.platform === "linux" ? await buildLinuxCommandMap() : new Map<number, string>();
				const rows = deltas
					.slice(0, limit)
					.map((delta) => [String(delta.pid), delta.cpuDeltaPercent.toFixed(1), commands.get(delta.pid) ?? "-"]);
				const truncation = truncateHead(formatTable(rows, ["PID", "CPU%", "COMMAND"]));
				return {
					content: [{ type: "text", text: truncation.content || "No processes observed during sample window." }],
					details: { op: "sample", count: rows.length, truncated: truncation.truncated },
				};
			}

			// op === "list"
			const sortBy = input.sortBy ?? "cpu";
			const limit = clampInt(input.limit, 25, 1, 500);
			const rows =
				process.platform === "win32"
					? await listProcessesWin32(sortBy)
					: process.platform === "darwin"
						? await listProcessesDarwin(sortBy)
						: await listProcessesLinux(sortBy);
			const tableRows = rows
				.slice(0, limit)
				.map((row) => [
					String(row.pid),
					row.ppid === null ? "-" : String(row.ppid),
					row.user,
					row.state,
					row.cpuPercent.toFixed(1),
					humanRss(row.memRssBytes),
					row.command,
				]);
			const truncation = truncateHead(
				formatTable(tableRows, ["PID", "PPID", "USER", "S", "CPU%", "RSS", "COMMAND"]),
				{ maxLines: limit + 2 },
			);
			return {
				content: [{ type: "text", text: truncation.content || "No processes found." }],
				details: { op: "list", count: tableRows.length, truncated: truncation.truncated },
			};
		},
	};
	return definition;
}

export function createProcessesTool(cwd: string) {
	return wrapToolDefinition(createProcessesToolDefinition(cwd));
}
