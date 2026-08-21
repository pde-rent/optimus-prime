import { createHash } from "node:crypto";
import { spawnSync } from "child_process";
import {
	accessSync,
	appendFileSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { shouldUseWindowsShell } from "./utils/child-process.js";
import { normalizeSocketPath } from "./utils/daemon-socket-path.js";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

export const SELF_UPDATE_INTERACTIVE_CHILD_ENV = "OPTIMUS_INTERACTIVE_SELF_UPDATE";
export const SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE = 75;

// =============================================================================
// Install Method Detection
// =============================================================================

/**
 * How this installation was placed on disk. There is no npm/node entry: the
 * published bin is `#!/usr/bin/env bun` (src/cli.ts) and package.json declares
 * `engines.bun` only, so every process — including daemons and subprocesses that
 * re-exec `process.execPath` — runs under Bun.
 */
export type InstallMethod = "bun-binary" | "homebrew" | "pnpm" | "yarn" | "bun";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
	options: { uninstallAfterInstall?: boolean } = {},
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	if (options.uninstallAfterInstall) {
		return {
			...installStep,
			display: `${installStep.display} && ${uninstallStep.display}`,
			steps: [installStep, uninstallStep],
		};
	}
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}
	if (isHomebrewInstall()) {
		return "homebrew";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	// Anything that is not a pnpm or yarn global is a Bun install: the runtime is
	// always Bun (see InstallMethod). Whether the install is actually managed —
	// i.e. self-updatable — is decided by isManagedByGlobalPackageManager, not here.
	return "bun";
}

function isHomebrewInstall(): boolean {
	const packageDir = getPackageDir().toLowerCase().replace(/\\/g, "/");
	return packageDir.includes("/cellar/") && packageDir.includes("/libexec/lib/node_modules/");
}

function isDirectPackageArtifactSpec(updateSpec: string): boolean {
	const spec = updateSpec.trim().toLowerCase();
	return (
		spec.startsWith("http://") ||
		spec.startsWith("https://") ||
		spec.startsWith("file:") ||
		spec.endsWith(".tgz") ||
		spec.endsWith(".tar.gz")
	);
}

function getDefaultUpdatePackageName(installedPackageName: string, updateSpec: string): string {
	if (isDirectPackageArtifactSpec(updateSpec)) {
		return installedPackageName;
	}
	return updateSpec;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updateSpec = installedPackageName,
	updatePackageName = getDefaultUpdatePackageName(installedPackageName, updateSpec),
): SelfUpdateCommand | undefined {
	const uninstallAfterInstall = isDirectPackageArtifactSpec(updateSpec);
	switch (method) {
		case "bun-binary":
		case "homebrew":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", ["install", "-g", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", ["install", "-g", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
	}
}

function readCommandOutput(command: string, args: string[]): string | undefined {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: shouldUseWindowsShell(command),
	});
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function getGlobalPackageRoots(method: InstallMethod): string[] {
	switch (method) {
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "homebrew":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath: string;
	try {
		normalizedPath = realpathSync(resolvedPath);
	} catch {
		return undefined;
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod): boolean {
	const packageDir = normalizeExistingPathForComparison(getPackageDir());
	return (
		!!packageDir &&
		getGlobalPackageRoots(method).some((root) => {
			const normalizedRoot = normalizeExistingPathForComparison(root);
			return (
				!!normalizedRoot &&
				packageDir.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`)
			);
		})
	);
}

export function getSelfUpdateCommand(
	packageName: string,
	updateSpec = packageName,
	updatePackageName = getDefaultUpdatePackageName(packageName, updateSpec),
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updateSpec, updatePackageName);
	if (!command || !isManagedByGlobalPackageManager(method) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	updateSpec = packageName,
	updatePackageName = getDefaultUpdatePackageName(packageName, updateSpec),
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/pde-rent/optimus-prime/releases/latest`;
	}
	if (method === "homebrew") {
		return `Update with: brew upgrade ${APP_NAME}`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, updateSpec, updatePackageName);
	if (command) {
		if (isManagedByGlobalPackageManager(method) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updateSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For source runs (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source runs (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For source runs (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For source runs (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

/**
 * Get the directory containing built-in skills shipped with the package.
 * - For Bun binary: skills/ next to executable
 * - For Node.js (dist/): dist/skills/
 * - For source runs (src/): skills/ at the package root
 */
export function getBundledSkillsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "skills");
	}
	const packageDir = getPackageDir();
	// Source checkouts keep built-in skills at the package root; built
	// packages copy them to dist/skills. Decide by whether src/ is present so a
	// stale dist/ from a prior build never shadows live source edits.
	const isSourceCheckout = existsSync(join(packageDir, "src"));
	return isSourceCheckout ? join(packageDir, "skills") : join(packageDir, "dist", "skills");
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
const envPrefix =
	(piConfigName || "pi")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "") || "PI";
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".optimus/agent";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or OPTIMUS_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${envPrefix}_SESSION_DIR`;

export function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.optimus/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.optimus/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Directory where daemon and client diagnostic logs are written (e.g. ~/.optimus/agent/logs/). */
export function getLogsDir(): string {
	return join(getAgentDir(), "logs");
}

/** Log file capturing client-side agent-open failures. */
export function getClientErrorLogPath(): string {
	return join(getLogsDir(), "client-errors.log");
}

/** Shared structured (JSON lines) log for client, daemon, and provider diagnostics. */
export function getAgentLogPath(): string {
	return join(getLogsDir(), "agent.jsonl");
}

/**
 * Log file for a daemon. The basename keeps it readable; a hash of the full
 * socket path makes it unique so two sockets that share a basename (e.g.
 * daemon.sock in different dirs) don't interleave into one file.
 */
export function getDaemonLogPath(socketPath: string): string {
	const normalized = normalizeSocketPath(socketPath);
	const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
	return join(getLogsDir(), `${basename(normalized)}.${hash}.log`);
}

export function getDaemonUpdateRestartManifestPath(socketPath: string, agentDir: string = getAgentDir()): string {
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const socketHash = createHash("sha256").update(normalizedSocketPath).digest("hex");
	return join(agentDir, "daemon-update-restarts", `${socketHash}.json`);
}

export function getLegacyDaemonUpdateRestartManifestPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "daemon-update-restart.json");
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Append a line to a log file, keeping its size bounded with a single-generation
 * rotation. Opens and closes per call (no held fd), so rotation works at runtime
 * — a long-lived writer rotates on the write that crosses the cap, not only at
 * startup. Best-effort: diagnostics must never throw into the caller.
 */
export function appendRotatingLog(logPath: string, message: string, maxBytes: number = MAX_LOG_BYTES): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		try {
			if (existsSync(logPath) && statSync(logPath).size > maxBytes) {
				// Drop any prior .old first: renameSync fails on Windows if it exists.
				rmSync(`${logPath}.old`, { force: true });
				renameSync(logPath, `${logPath}.old`);
			}
		} catch {
			// Keep appending rather than dropping the log on a rotation failure.
		}
		appendFileSync(logPath, `${message}\n`);
	} catch {
		// A read-only or missing log dir must never break the caller.
	}
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to cron jobs store */
export function getCronJobsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cron-jobs.json");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to sessions directory */
export function getSessionsDir(agentDir: string = getAgentDir()): string {
	const envDir = getSessionDirEnvOverride();
	if (envDir) {
		return envDir;
	}
	return join(agentDir, "sessions");
}

export function getSessionDirEnvOverride(): string | undefined {
	const envDir = process.env[ENV_SESSION_DIR];
	return envDir ? expandTildePath(envDir) : undefined;
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
