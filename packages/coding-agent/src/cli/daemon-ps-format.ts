import { color as chalk } from "../utils/ansi.js";
import { formatElapsedDuration, formatTable } from "../utils/shared.js";
import type { DaemonInfo, DaemonStatus } from "./daemon-ps.js";

type DaemonRow = {
	socket: string;
	pid: string;
	version: string;
	status: string;
	sessions: string;
	uptime: string;
};

export function formatDaemonListTable(daemons: readonly DaemonInfo[]): string {
	const rows = daemons.map((daemon) => ({
		socket: daemon.isDefault ? `${daemon.socketPath} *` : daemon.socketPath,
		pid: daemon.pid !== undefined ? String(daemon.pid) : "",
		version: daemon.version ?? "",
		status: daemon.status,
		sessions: daemon.sessionCount !== undefined ? String(daemon.sessionCount) : "",
		uptime: formatUptime(daemon.uptimeSeconds),
	}));
	const table = formatTable(["socket", "pid", "version", "status", "sessions", "uptime"], rows, formatDaemonCell);
	return daemons.some((daemon) => daemon.isDefault)
		? `${table}\n\n${chalk.dim("* default background service")}`
		: table;
}

function formatDaemonCell(_row: DaemonRow, column: keyof DaemonRow, value: string): string {
	if (column !== "status") {
		return value;
	}
	return colorStatus(value.trim() as DaemonStatus, value);
}

function colorStatus(status: DaemonStatus, value: string): string {
	switch (status) {
		case "current":
			return chalk.green(value);
		case "stale":
			return chalk.yellow(value);
		case "unreachable":
			return chalk.red(value);
		case "orphan-file":
			return chalk.dim(value);
	}
}

export function formatUptime(uptimeSeconds: number | undefined): string {
	if (uptimeSeconds === undefined || !Number.isFinite(uptimeSeconds)) {
		return "";
	}
	return formatElapsedDuration(Math.max(0, Math.floor(uptimeSeconds)));
}
