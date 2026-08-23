import { APP_NAME } from "../../config.js";

export function updateArgsIncludeSelf(args: readonly string[]): boolean {
	let selfFlag = false;
	let extensionsOnlyFlag = false;
	let positional: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--self") {
			selfFlag = true;
		} else if (arg === "--extensions") {
			extensionsOnlyFlag = true;
		} else if (arg === "--extension") {
			extensionsOnlyFlag = true;
			index++;
		} else if (arg === "--daemon-socket") {
			index++;
		} else if (arg && !arg.startsWith("-") && positional === undefined) {
			positional = arg;
		}
	}
	if (selfFlag) {
		return true;
	}
	if (extensionsOnlyFlag) {
		return false;
	}
	if (!positional) {
		return true;
	}
	const normalized = positional.toLowerCase();
	return normalized === "self" || normalized === "pi" || normalized === APP_NAME.toLowerCase();
}

function argsIncludeSessionSelection(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--resume" || arg === "-r" || arg === "--continue" || arg === "-c" || arg === "--fork") {
			return true;
		}
	}
	return false;
}

export function buildUpdateRelaunchArgs(args: readonly string[], sessionFile: string | undefined): string[] {
	const relaunchArgs = [...args];
	if (sessionFile && !argsIncludeSessionSelection(relaunchArgs)) {
		relaunchArgs.push("--resume", sessionFile);
	}
	return relaunchArgs;
}

export function buildUpdateChildArgs(args: readonly string[], daemonSocketPath: string): string[] {
	return args.includes("--daemon-socket") ? [...args] : [...args, "--daemon-socket", daemonSocketPath];
}

export function resolveInteractiveUpdateDaemonSocketPath(
	args: readonly string[],
	activeDaemonSocketPath: string,
): string {
	const socketFlagIndex = args.indexOf("--daemon-socket");
	return socketFlagIndex === -1 ? activeDaemonSocketPath : (args[socketFlagIndex + 1] ?? activeDaemonSocketPath);
}
