/**
 * Shared helpers for the native diagnostic tools (processes/sysinfo/netdiag):
 * PATH lookup + subprocess execution with clean errors, and dense table
 * formatting. Pure node: APIs so every runtime (Bun and Node) can use them.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { waitForChildProcess } from "../../../utils/child-process.js";

export interface BinaryResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Resolve a bare command name against PATH (PATHEXT-aware on win32). */
export function lookupPath(command: string): string | null {
	if (command.includes("/") || command.includes("\\")) {
		return command;
	}
	const pathVar = process.env.PATH ?? "";
	const dirs = pathVar.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".exe", ".cmd", ".bat", ".com"])
			: [""];
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = `${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}${command}${ext}`;
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here; keep scanning.
			}
		}
	}
	return null;
}

/**
 * Spawn a binary and collect stdout/stderr/code. Throws a single clear error
 * when the binary itself is missing so callers degrade gracefully instead of
 * leaking ENOENT internals.
 */
export async function runBinary(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<BinaryResult> {
	if (!lookupPath(command)) {
		throw new Error(`Could not spawn ${command}: binary not found on PATH.`);
	}
	return new Promise<BinaryResult>((resolve, reject) => {
		const child = spawn(command, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const timer =
			options?.timeoutMs && options.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGKILL");
					}, options.timeoutMs)
				: undefined;
		const onAbort = () => child.kill("SIGKILL");
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			settled = true;
			if (timer) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Could not spawn ${command}: ${error.message}.`));
		});
		waitForChildProcess(child)
			.then((code) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				resolve({ stdout, stderr, code: timedOut ? 124 : (code ?? 0) });
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				resolve({ stdout, stderr, code: 1 });
			});
	});
}

/** Render rows (and an optional header row) as a dense space-aligned table. */
export function formatTable(rows: string[][], headers?: string[]): string {
	const all = headers ? [headers, ...rows] : rows;
	if (all.length === 0) return "";
	const width = Math.max(...all.map((row) => row.length));
	const widths: number[] = [];
	for (const row of all) {
		for (let i = 0; i < width; i++) {
			widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
		}
	}
	return all
		.map((row) =>
			row
				.map((cell, i) => cell.padEnd(widths[i]))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
