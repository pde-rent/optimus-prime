/**
 * SSH via the system OpenSSH client (docs/net-stack-spec.md §3).
 *
 * No SSH wire code: we spawn the system `ssh`/`scp` binaries as subprocess
 * pipes, exactly like the clipboard delegates to osascript. Host-key policy,
 * agent auth, ~/.ssh/config, ProxyJump and FIDO2 keys are the system binary's
 * behavior. BatchMode is on by default so an unanswerable password prompt
 * fails fast instead of hanging the agent.
 */

import { statSync } from "node:fs";
import { resolveToCwd } from "../tools/path-utils.js";
import { DEFAULT_MAX_LINES, truncateHead } from "../tools/truncate.js";
import { NetAbortedError, NetTimeoutError } from "./core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SshTarget {
	host: string;
	port?: number;
	user?: string;
	/** Path to a private key; never logged. */
	identityFile?: string;
	/**
	 * Fail fast instead of hanging on a password prompt the agent can never
	 * answer. Default true; disable explicitly at your own risk.
	 */
	batchMode?: boolean;
	/** Default "yes"; "accept-new" auto-adds new hosts but never skips verification. */
	strictHostKeyChecking?: "yes" | "accept-new";
	connectTimeoutMs?: number;
	/** Extra arguments passed through verbatim (e.g. ProxyJump, -J). */
	sshArgs?: string[];
}

/** Minimal structural process handle so tests can mock spawning. */
interface SshProcess {
	exited: Promise<number>;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	kill(signal?: number): void;
}

type SshSpawn = (argv: string[], options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }) => SshProcess;

interface SshDeps {
	spawn?: SshSpawn;
	which?: (binary: string) => string | null;
}

export interface SshExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

interface ScpResult {
	bytes: number;
	localPath: string;
	remotePath: string;
}

// ---------------------------------------------------------------------------
// Argv builders (pure; unit-testable without spawning)
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

function commonSshFlags(target: SshTarget): string[] {
	const flags: string[] = [];
	if (target.batchMode !== false) flags.push("-o", "BatchMode=yes");
	flags.push("-o", `StrictHostKeyChecking=${target.strictHostKeyChecking ?? "yes"}`);
	if (target.port !== undefined) flags.push("-p", String(target.port));
	if (target.identityFile) flags.push("-i", target.identityFile);
	flags.push("-o", `ConnectTimeout=${Math.ceil((target.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000)}`);
	if (target.sshArgs?.length) flags.push(...target.sshArgs);
	return flags;
}

function targetString(target: SshTarget): string {
	return target.user ? `${target.user}@${target.host}` : target.host;
}

/** Build the full argv for exec; command is an argv array, never shell-joined. */
function buildExecArgv(target: SshTarget, command: string[]): string[] {
	return ["ssh", ...commonSshFlags(target), "--", targetString(target), ...command];
}

/** Build the full argv for scp put/get (-O for the classic protocol, not SFTP). */
function buildScpArgv(target: SshTarget, source: string, destination: string): string[] {
	const flags = ["-O"];
	if (target.batchMode !== false) flags.push("-o", "BatchMode=yes");
	flags.push("-o", `StrictHostKeyChecking=${target.strictHostKeyChecking ?? "yes"}`);
	if (target.identityFile) flags.push("-i", target.identityFile);
	if (target.port !== undefined) flags.push("-P", String(target.port));
	flags.push("-o", `ConnectTimeout=${Math.ceil((target.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000)}`);
	if (target.sshArgs?.length) flags.push(...target.sshArgs);
	return ["scp", ...flags, source, destination];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function runProcess(
	argv: string[],
	deps: Required<SshDeps>,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = deps.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abortListener = () => proc.kill();
	if (opts.signal) opts.signal.addEventListener("abort", abortListener, { once: true });
	try {
		const exitRace = Promise.race([
			proc.exited.then((code) => ({ code })),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					proc.kill();
					reject(new NetTimeoutError(`${argv[0]} timed out after ${opts.timeoutMs}ms and was killed.`));
				}, opts.timeoutMs);
			}),
		]);
		const [outcome, stdout, stderr] = await Promise.all([exitRace, drain(proc.stdout), drain(proc.stderr)]);
		return { exitCode: outcome.code, stdout, stderr };
	} catch (error: unknown) {
		proc.kill();
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", abortListener);
	}
}

function requireBinary(name: string, deps: Required<SshDeps>): void {
	if (!deps.which(name)) {
		throw new Error(`Could not find ${name} on PATH.`);
	}
}

function makeDeps(deps?: SshDeps): Required<SshDeps> {
	return {
		spawn:
			deps?.spawn ??
			((argv, options) => {
				const child = Bun.spawn(argv, { ...options });
				return {
					exited: child.exited,
					stdout: child.stdout,
					stderr: child.stderr,
					kill: (signal) => child.kill(signal),
				};
			}),
		which: deps?.which ?? ((binary) => Bun.which(binary)),
	};
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new NetAbortedError();
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface SshExecOptions {
	/** Kill the process on expiry. Default 30_000 ms. */
	timeoutMs?: number;
	signal?: AbortSignal;
	maxLines?: number;
	maxBytes?: number;
	deps?: SshDeps;
}

/** Run one remote command (argv array). The remote login shell joins it; that is inherent to ssh. */
export async function sshExec(target: SshTarget, command: string[], opts?: SshExecOptions): Promise<SshExecResult> {
	if (!command.length) throw new Error("Remote command must not be empty.");
	checkAborted(opts?.signal);
	const deps = makeDeps(opts?.deps);
	requireBinary("ssh", deps);
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

	const argv = buildExecArgv(target, command);
	const { exitCode, stdout, stderr } = await runProcess(argv, deps, { timeoutMs, signal: opts?.signal });

	const outTruncation = truncateHead(stdout, {
		maxLines: opts?.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: opts?.maxBytes,
	});
	const errTruncation = truncateHead(stderr, {
		maxLines: opts?.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: opts?.maxBytes ?? 8192,
	});
	return {
		exitCode,
		stdout: outTruncation.content,
		stderr: errTruncation.content,
		truncated: outTruncation.truncated || errTruncation.truncated,
	};
}

interface ScpOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	deps?: SshDeps;
}

/**
 * Copy a local file to the remote host via system scp. Local paths resolve
 * against cwd; write-then-rename discipline is the caller's concern.
 */
export async function scpPut(
	target: SshTarget,
	cwd: string,
	localPath: string,
	remotePath: string,
	opts?: ScpOptions,
): Promise<ScpResult> {
	return runScp(target, cwd, localPath, remotePath, "put", opts);
}

/** Copy a remote file to a local path via system scp. */
export async function scpGet(
	target: SshTarget,
	cwd: string,
	remotePath: string,
	localPath: string,
	opts?: ScpOptions,
): Promise<ScpResult> {
	return runScp(target, cwd, localPath, remotePath, "get", opts);
}

async function runScp(
	target: SshTarget,
	cwd: string,
	localPath: string,
	remotePath: string,
	direction: "put" | "get",
	opts?: ScpOptions,
): Promise<ScpResult> {
	checkAborted(opts?.signal);
	const deps = makeDeps(opts?.deps);
	requireBinary("scp", deps);
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

	const localAbs = resolveToCwd(localPath, cwd);
	const remoteSpec = `${targetString(target)}:${remotePath}`;
	const argv =
		direction === "put" ? buildScpArgv(target, localAbs, remoteSpec) : buildScpArgv(target, remoteSpec, localAbs);

	let localBytes = 0;
	try {
		localBytes = statSync(localAbs).size;
	} catch {
		if (direction === "put") throw new Error(`Local file does not exist: ${localPath}.`);
	}

	const { exitCode, stderr } = await runProcess(argv, deps, { timeoutMs, signal: opts?.signal });
	if (exitCode !== 0) {
		const tail = stderr.trim().split("\n").slice(-3).join("; ");
		throw new Error(`scp failed with exit code ${exitCode}: ${tail || "no stderr"}`);
	}

	let bytes = localBytes;
	if (direction === "get") {
		try {
			bytes = statSync(localAbs).size;
		} catch {
			throw new Error(`scp reported success but ${localAbs} is missing.`);
		}
	}
	return { bytes, localPath: localAbs, remotePath };
}
