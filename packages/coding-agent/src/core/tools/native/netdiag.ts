import { Resolver } from "node:dns";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../extensions/types.js";
import { throwIfAborted } from "../abortable.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { truncateHead } from "../truncate.js";
import { clampInt, formatTable, runBinary } from "./sysutil.js";

const RESOLVE_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as const;

const netdiagSchema = Type.Object(
	{
		op: Type.Union(
			[
				Type.Literal("interfaces"),
				Type.Literal("resolve"),
				Type.Literal("ping"),
				Type.Literal("portProbe"),
				Type.Literal("connections"),
			],
			{
				description:
					"interfaces = enriched os.networkInterfaces; resolve = DNS lookup; ping = system ping parsed to structured RTT/loss; portProbe = one TCP connect; connections = listening socket table.",
			},
		),
		host: Type.Optional(Type.String({ description: "resolve/ping/portProbe only: hostname or IP to target." })),
		type: Type.Optional(
			Type.Union(
				RESOLVE_TYPES.map((t) => Type.Literal(t)),
				{
					description: "resolve only: record type (default A).",
				},
			),
		),
		port: Type.Optional(Type.Number({ description: "portProbe only: TCP port 1-65535." })),
		count: Type.Optional(Type.Number({ description: "ping only: echo requests to send (default 4, clamp 1-20)." })),
		timeoutMs: Type.Optional(
			Type.Number({
				description:
					"Per-attempt timeout: resolve/portProbe default 3000ms, ping default 15000ms covers the whole run.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type NetdiagToolInput = Static<typeof netdiagSchema>;

export interface NetdiagToolDetails {
	op: "interfaces" | "resolve" | "ping" | "portProbe" | "connections";
	/** Row/record count where it applies (interfaces addresses, records, replies parsed, sockets). */
	count: number;
	truncated: boolean;
	/** portProbe outcome. */
	open?: boolean;
	/** ping loss percent when known. */
	lossPercent?: number;
}

// ---------------------------------------------------------------------------
// ping parsing
// ---------------------------------------------------------------------------

export interface PingSummary {
	transmitted: number | null;
	received: number | null;
	lossPercent: number | null;
	rttMinMs: number | null;
	rttAvgMs: number | null;
	rttMaxMs: number | null;
}

/**
 * Parse the summary tail of ping output from any of the three platforms into
 * structured numbers. Returns null when nothing recognisable was found (e.g.
 * "unknown host"). Never returns raw dump text.
 */
export function parsePingOutput(stdout: string, platform: string): PingSummary | null {
	const summary: PingSummary = {
		transmitted: null,
		received: null,
		lossPercent: null,
		rttMinMs: null,
		rttAvgMs: null,
		rttMaxMs: null,
	};
	if (platform === "win32") {
		const sent = stdout.match(/Sent\s*=\s*(\d+)/);
		const received = stdout.match(/Received\s*=\s*(\d+)/);
		const lost = stdout.match(/Lost\s*=\s*(\d+)\s*\((\d+)%\s+loss\)/);
		const rtt = stdout.match(/Minimum\s*=\s*(\d+)ms,\s*Maximum\s*=\s*(\d+)ms,\s*Average\s*=\s*(\d+)ms/i);
		if (!sent && !lost && !rtt) return null;
		if (sent) summary.transmitted = Number(sent[1]);
		if (received) summary.received = Number(received[1]);
		if (lost) summary.lossPercent = Number(lost[2]);
		if (rtt) {
			summary.rttMinMs = Number(rtt[1]);
			summary.rttMaxMs = Number(rtt[2]);
			summary.rttAvgMs = Number(rtt[3]);
		}
		return summary;
	}
	const txRx = stdout.match(/(\d+) packets transmitted,\s+(\d+)\s+(?:packets\s+)?received/);
	const loss = stdout.match(/([\d.]+)% packet loss/);
	const rtt = stdout.match(/(?:rtt|round-trip) min\/avg\/max(?:\/\w+)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
	if (!txRx && !loss && !rtt) return null;
	if (txRx) {
		summary.transmitted = Number(txRx[1]);
		summary.received = Number(txRx[2]);
	}
	if (loss) summary.lossPercent = Number(loss[1]);
	if (rtt) {
		summary.rttMinMs = Number(rtt[1]);
		summary.rttAvgMs = Number(rtt[2]);
		summary.rttMaxMs = Number(rtt[3]);
	}
	return summary;
}

async function runPingOp(
	host: string,
	count: number,
	timeoutMs: number,
): Promise<{ summary: PingSummary; lossy: boolean }> {
	const args = process.platform === "win32" ? ["-n", String(count), host] : ["-c", String(count), host];
	const result = await runBinary("ping", args, { timeoutMs });
	const summary = parsePingOutput(result.stdout, process.platform);
	if (!summary) {
		const detail = result.stderr.trim().split("\n")[0] || "no summary line in ping output";
		throw new Error(`Could not ping ${host}: ${detail}`);
	}
	return { summary, lossy: (summary.lossPercent ?? 0) > 0 || result.code !== 0 };
}

// ---------------------------------------------------------------------------
// port probe: Bun.connect when present, node:net otherwise
// ---------------------------------------------------------------------------

interface ProbeResult {
	open: boolean;
	latencyMs: number | null;
	error: string | null;
}

async function probeWithNodeNet(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
	return new Promise<ProbeResult>((resolve) => {
		const started = performance.now();
		const socket = net.connect({ host, port });
		let settled = false;
		const finish = (result: ProbeResult) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ open: false, latencyMs: null, error: "timeout" }), timeoutMs);
		socket.on("connect", () => {
			clearTimeout(timer);
			finish({ open: true, latencyMs: Math.round(performance.now() - started), error: null });
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			finish({
				open: false,
				latencyMs: Math.round(performance.now() - started),
				error: error.code ?? error.message,
			});
		});
	});
}

async function runPortProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
	const bunGlobal = (
		globalThis as {
			Bun?: {
				connect?: (options: {
					hostname: string;
					port: number;
					socket: Record<string, () => void>;
				}) => Promise<{ end: () => void }>;
			};
		}
	).Bun;
	if (typeof bunGlobal?.connect !== "function") {
		return probeWithNodeNet(host, port, timeoutMs);
	}
	const started = performance.now();
	try {
		const race = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
		const socket = await Promise.race([
			bunGlobal.connect({ hostname: host, port, socket: { data() {}, close() {}, error() {} } }),
			race,
		]);
		socket.end();
		return { open: true, latencyMs: Math.round(performance.now() - started), error: null };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { open: false, latencyMs: Math.round(performance.now() - started), error: message };
	}
}

// ---------------------------------------------------------------------------
// connections: /proc/net parsing (linux), netstat (darwin/win32)
// ---------------------------------------------------------------------------

const TCP_STATES = new Map([
	["01", "ESTABLISHED"],
	["02", "SYN_SENT"],
	["03", "SYN_RECV"],
	["04", "FIN_WAIT1"],
	["05", "FIN_WAIT2"],
	["06", "TIME_WAIT"],
	["07", "CLOSE"],
	["08", "CLOSE_WAIT"],
	["09", "LAST_ACK"],
	["0A", "LISTEN"],
	["0B", "CLOSING"],
]);

/** Decode a /proc/net hex address ("0100007F:1F90") into "ip:port". */
export function decodeProcNetAddress(hexAddress: string, ipv6: boolean): string {
	const separator = hexAddress.lastIndexOf(":");
	const ipHex = hexAddress.slice(0, separator);
	const port = Number.parseInt(hexAddress.slice(separator + 1), 16);
	let ip: string;
	if (ipv6) {
		const words: string[] = [];
		for (let i = 0; i < 32; i += 8) {
			const word = ipHex.slice(i, i + 8);
			const bytes = word.match(/.{2}/g)?.reverse() ?? [];
			words.push(bytes.join(""));
		}
		const full = words.join("");
		const pairs = full.match(/.{4}/g) ?? [];
		ip = pairs.join(":");
	} else {
		const bytes = ipHex.match(/.{2}/g)?.reverse() ?? [];
		ip = bytes.map((byte) => Number.parseInt(byte, 16)).join(".");
	}
	return `${ip}:${port}`;
}

/**
 * Parse one /proc/net/{tcp,tcp6,udp,udp6} file body into socket rows.
 */
export function parseProcNet(
	text: string,
	proto: "tcp" | "tcp6" | "udp" | "udp6",
): Array<{ proto: string; local: string; remote: string; state: string; pid: string }> {
	const rows: Array<{ proto: string; local: string; remote: string; state: string; pid: string }> = [];
	const ipv6 = proto.endsWith("6");
	for (const line of text.split("\n").slice(1)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 4) continue;
		const local = decodeProcNetAddress(columns[1], ipv6);
		const remote = decodeProcNetAddress(columns[2], ipv6);
		const stateHex = columns[3].toUpperCase();
		const state = proto.startsWith("tcp") ? (TCP_STATES.get(stateHex) ?? stateHex) : "-";
		rows.push({ proto: proto.toUpperCase(), local, remote, state, pid: "-" });
	}
	return rows;
}

function isListening(row: { proto: string; local: string; remote: string; state: string }): boolean {
	if (row.proto.startsWith("TCP")) return row.state === "LISTEN";
	return row.remote.endsWith(":*") || row.remote === "*.*" || row.remote === "0.0.0.0:0" || row.remote === ":::*";
}

/** Parse netstat -an style output (darwin/win32 shapes) into socket rows. */
export function parseNetstatLines(
	text: string,
): Array<{ proto: string; local: string; remote: string; state: string; pid: string }> {
	const rows: Array<{ proto: string; local: string; remote: string; state: string; pid: string }> = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const columns = line.split(/\s+/);
		const protoToken = columns[0].toLowerCase();
		if (protoToken === "proto") continue;
		if (/^(tcp4|tcp6)$/.test(protoToken)) {
			// darwin: Proto Local Foreign [State ...extras]
			const state = columns.find((cell) => cell.toUpperCase() === "LISTEN")
				? "LISTEN"
				: (columns.find((cell) => /^[A-Z_]+$/.test(cell) && cell.length > 3)?.toUpperCase() ?? "ESTABLISHED");
			rows.push({
				proto: protoToken.toUpperCase(),
				local: columns[3] ?? "-",
				remote: columns[4] ?? "-",
				state,
				pid: "-",
			});
		} else if (/^(udp4|udp6)$/.test(protoToken)) {
			rows.push({
				proto: protoToken.toUpperCase(),
				local: columns[3] ?? "-",
				remote: columns[4] ?? "-",
				state: "-",
				pid: "-",
			});
		} else if (protoToken === "tcp" && columns.length >= 5) {
			// win32: Proto Local Foreign State PID
			rows.push({
				proto: "TCP",
				local: columns[1],
				remote: columns[2],
				state: columns[3]?.toUpperCase() ?? "-",
				pid: columns[4] ?? "-",
			});
		} else if (protoToken === "udp" && columns.length >= 3) {
			// win32: Proto Local [Foreign] PID - pid is the trailing numeric column.
			const last = columns[columns.length - 1];
			rows.push({
				proto: "UDP",
				local: columns[1],
				remote: columns.length >= 4 ? columns[2] : "*:*",
				state: "-",
				pid: /^\d+$/.test(last) ? last : "-",
			});
		}
	}
	return rows;
}

async function listListeningSockets(): Promise<
	Array<{ proto: string; local: string; remote: string; state: string; pid: string }>
> {
	if (process.platform === "linux") {
		const rows: Array<{ proto: string; local: string; remote: string; state: string; pid: string }> = [];
		for (const file of ["tcp", "tcp6", "udp", "udp6"] as const) {
			try {
				rows.push(...parseProcNet(readFileSync(`/proc/net/${file}`, "utf8"), file));
			} catch {}
		}
		return rows.filter(isListening);
	}
	if (process.platform === "win32") {
		const result = await runBinary("netstat.exe", ["-ano"]);
		return parseNetstatLines(result.stdout).filter(isListening);
	}
	const result = await runBinary("netstat", ["-anv"]);
	return parseNetstatLines(result.stdout).filter(isListening);
}

// ---------------------------------------------------------------------------
// interfaces / resolve
// ---------------------------------------------------------------------------

interface InterfaceRow {
	name: string;
	family: string;
	address: string;
	mac: string;
	internal: boolean;
	cidr: string | null;
}

function collectInterfaces(): InterfaceRow[] {
	const rows: InterfaceRow[] = [];
	const interfaces = os.networkInterfaces() as Record<string, Array<os.NetworkInterfaceInfo>>;
	for (const [name, addresses] of Object.entries(interfaces)) {
		for (const address of addresses ?? []) {
			rows.push({
				name,
				family: String(address.family),
				address: address.address,
				mac: address.mac,
				internal: address.internal,
				cidr: address.cidr ?? null,
			});
		}
	}
	return rows;
}

async function runResolve(
	host: string,
	recordType: (typeof RESOLVE_TYPES)[number],
	timeoutMs: number,
): Promise<string[]> {
	const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
	try {
		const records = await new Promise<string[]>((resolve, reject) => {
			resolver.resolve(host, recordType, (error, results) => {
				if (error) reject(error);
				else resolve((results as string[]) ?? []);
			});
		});
		return records.map((record) => {
			if (recordType === "TXT") {
				return Array.isArray(record) ? record.join("") : String(record);
			}
			if (recordType === "MX") {
				return String(record);
			}
			return String(record);
		});
	} finally {
		(resolver as unknown as { close: () => void }).close();
	}
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Network diagnostics cross-platform: interface inventory, DNS resolution,
 * system-ping summaries, single TCP probes and listening-socket tables.
 *
 * Use it for connectivity and reachability questions. Do not use it to fetch
 * HTTP content (use fetch), for host health totals (use sysinfo), or for
 * per-process ownership of sockets beyond the pid column netstat exposes -
 * and never expect raw ping dumps: every op emits dense structured tables.
 */
export function createNetdiagToolDefinition(cwd: string): ToolDefinition<typeof netdiagSchema, NetdiagToolDetails> {
	void cwd;
	const definition: ToolDefinition<typeof netdiagSchema, NetdiagToolDetails> = {
		name: "netdiag",
		label: "netdiag",
		description:
			'Network diagnostics across linux/darwin/win32: enriched interface inventory (name/address/mac/internal/cidr), DNS lookups (A AAAA CNAME MX TXT NS via node:dns with a timeout), system-ping runs parsed into structured transmitted/received/loss%/rtt-min-avg-max JSON (never a raw dump), one-shot TCP port probes with open/closed + latencyMs, and listening-socket tables (linux reads /proc/net pure-TS, darwin spawns netstat -anv, win32 netstat -ano). Use it for connectivity questions; do not use it to download HTTP bodies (use fetch), for CPU/memory/disk health (use sysinfo), or per-process CPU detail (use processes). Missing binaries fail exactly "Could not spawn <binary>: binary not found on PATH."; unresolvable hosts fail with the resolver message prefixed "Could not resolve <host>: ".',
		promptSnippet:
			"Interfaces/DNS/ping/port-probe/listening-sockets as structured tables - use instead of shelling out to ifconfig/nslookup/ping/netstat",
		parameters: netdiagSchema,
		executionMode: "parallel",
		kind: "network",
		read_only: true,
		async execute(
			_toolCallId,
			input: NetdiagToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: NetdiagToolDetails }> {
			throwIfAborted(signal);

			if (input.op === "interfaces") {
				const rows = collectInterfaces();
				const tableRows = rows.map((row) => [
					row.name,
					row.family,
					row.address,
					row.mac,
					String(row.internal),
					row.cidr ?? "-",
				]);
				const truncation = truncateHead(
					formatTable(tableRows, ["IFACE", "FAMILY", "ADDRESS", "MAC", "INTERNAL", "CIDR"]),
				);
				return {
					content: [{ type: "text", text: truncation.content || "No network interfaces found." }],
					details: { op: "interfaces", count: rows.length, truncated: truncation.truncated },
				};
			}

			if (input.op === "resolve") {
				if (!input.host) throw new Error('op "resolve" requires host.');
				const timeoutMs = clampInt(input.timeoutMs, 3000, 100, 30000);
				const recordType = input.type ?? "A";
				let records: string[];
				try {
					records = await runResolve(input.host, recordType, timeoutMs);
				} catch (error: unknown) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new Error(`Could not resolve ${input.host}: ${reason}`);
				}
				if (records.length === 0) {
					return {
						content: [{ type: "text", text: `No ${recordType} records for ${input.host}.` }],
						details: { op: "resolve", count: 0, truncated: false },
					};
				}
				const truncation = truncateHead(records.map((record) => `${recordType}\t${record}`).join("\n"));
				return {
					content: [{ type: "text", text: truncation.content }],
					details: { op: "resolve", count: records.length, truncated: truncation.truncated },
				};
			}

			if (input.op === "ping") {
				if (!input.host) throw new Error('op "ping" requires host.');
				const count = clampInt(input.count, 4, 1, 20);
				const timeoutMs = clampInt(input.timeoutMs, 15000, 1000, 60000);
				const { summary } = await runPingOp(input.host, count, timeoutMs);
				const lines = [
					formatTable(
						[
							[
								input.host,
								String(summary.transmitted ?? "-"),
								String(summary.received ?? "-"),
								summary.lossPercent === null ? "-" : `${summary.lossPercent}%`,
								fmtNum(summary.rttMinMs),
								fmtNum(summary.rttAvgMs),
								fmtNum(summary.rttMaxMs),
							],
						],
						["HOST", "SENT", "RECV", "LOSS%", "RTT_MIN_MS", "RTT_AVG_MS", "RTT_MAX_MS"],
					),
				];
				const truncation = truncateHead(lines.join("\n"));
				return {
					content: [{ type: "text", text: truncation.content }],
					details: {
						op: "ping",
						count: summary.received ?? 0,
						truncated: truncation.truncated,
						lossPercent: summary.lossPercent ?? undefined,
					},
				};
			}

			if (input.op === "portProbe") {
				if (!input.host) throw new Error('op "portProbe" requires host.');
				const port = input.port;
				if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
					throw new Error('op "portProbe" requires an integer port between 1 and 65535.');
				}
				const timeoutMs = clampInt(input.timeoutMs, 3000, 10, 30000);
				const probe = await runPortProbe(input.host, port, timeoutMs);
				const stateLine = probe.open
					? `open ${input.host}:${port} latency=${probe.latencyMs}ms`
					: `closed ${input.host}:${port} (${probe.error ?? "refused"})`;
				return {
					content: [{ type: "text", text: stateLine }],
					details: {
						op: "portProbe",
						count: 1,
						truncated: false,
						open: probe.open,
					},
				};
			}

			// op === "connections"
			const sockets = await listListeningSockets();
			const tableRows = sockets.map((row) => [row.proto, row.local, row.remote, row.state, row.pid]);
			const truncation = truncateHead(formatTable(tableRows, ["PROTO", "LOCAL", "REMOTE", "STATE", "PID"]));
			return {
				content: [{ type: "text", text: truncation.content || "No listening sockets found." }],
				details: { op: "connections", count: sockets.length, truncated: truncation.truncated },
			};
		},
	};
	return definition;
}

function fmtNum(value: number | null): string {
	return value === null ? "-" : String(value);
}

export function createNetdiagTool(cwd: string): AgentTool<typeof netdiagSchema> {
	return wrapToolDefinition(createNetdiagToolDefinition(cwd));
}
