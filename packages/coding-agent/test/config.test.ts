import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import {
	detectInstallMethod,
	ENV_LEGACY_SESSION_DIR,
	ENV_SESSION_DIR,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getSessionsDir,
	getUpdateInstruction,
} from "../src/config.js";
import { getDefaultSessionDir } from "../src/core/session-manager.js";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
const originalSessionDir = process.env[ENV_SESSION_DIR];
const originalLegacySessionDir = process.env[ENV_LEGACY_SESSION_DIR];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
	if (originalSessionDir === undefined) {
		delete process.env[ENV_SESSION_DIR];
	} else {
		process.env[ENV_SESSION_DIR] = originalSessionDir;
	}
	if (originalLegacySessionDir === undefined) {
		delete process.env[ENV_LEGACY_SESSION_DIR];
	} else {
		process.env[ENV_LEGACY_SESSION_DIR] = originalLegacySessionDir;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createUnmanagedInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-unmanaged-"));
	const packageDir = join(temp, "opt", "optimus");
	mkdirSync(packageDir, { recursive: true });
	tempDir = temp;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createHomebrewInstall(): { packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), "pi-homebrew-"));
	const packageDir = join(prefix, "Cellar", "optimus", "0.7.0", "libexec", "lib", "node_modules", "optimus");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: pnpm install -g @earendil-works/pi-coding-agent",
		);
	});

	test("does not self-update installs outside a global package root", () => {
		createUnmanagedInstall();

		expect(detectInstallMethod()).toBe("bun");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toBe(
			"This installation is not managed by a global bun install. Update it with the package manager, wrapper, or source checkout that provides it.",
		);
	});

	test("leaves Homebrew installs under Homebrew ownership", () => {
		createHomebrewInstall();

		expect(detectInstallMethod()).toBe("homebrew");
		expect(getSelfUpdateCommand("optimus")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("optimus")).toBe("Update with: brew upgrade optimus");
		expect(getUpdateInstruction("optimus")).toBe("Update with: brew upgrade optimus");
	});

	test("self-updates tarball specs without uninstalling the same logical package first", () => {
		createBunGlobalInstall();
		const tarballUrl = "https://downloads.example.test/optimus/optimus-0.73.0.tgz";

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", tarballUrl);

		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", tarballUrl],
			display: `bun install -g ${tarballUrl}`,
		});
	});

	test("self-updates renamed tarball packages by uninstalling the old package after install", () => {
		createBunGlobalInstall();
		const tarballUrl = "https://downloads.example.test/optimus/optimus-0.73.0.tgz";

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", tarballUrl, "optimus");

		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", tarballUrl],
			display: `bun install -g ${tarballUrl} && bun uninstall -g @earendil-works/pi-coding-agent`,
			steps: [
				{
					command: "bun",
					args: ["install", "-g", tarballUrl],
					display: `bun install -g ${tarballUrl}`,
				},
				{
					command: "bun",
					args: ["uninstall", "-g", "@earendil-works/pi-coding-agent"],
					display: `bun uninstall -g @earendil-works/pi-coding-agent`,
				},
			],
		});
	});

	test("quotes self-update display arguments containing spaces", () => {
		createBunGlobalInstall();
		const localSpec = "file:/tmp/pi prefix/optimus-0.73.0.tgz";

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", localSpec);

		expect(command?.display).toBe(`bun install -g "${localSpec}"`);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@earendil-works/pi-coding-agent"],
			display: "bun install -g @earendil-works/pi-coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", "@new-scope/pi");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "@new-scope/pi"],
			display: "pnpm remove -g @mariozechner/pi-coding-agent && pnpm install -g @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/pi-coding-agent"],
					display: "pnpm remove -g @mariozechner/pi-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "@new-scope/pi"],
					display: "pnpm install -g @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", "@new-scope/pi");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "@new-scope/pi"],
			display: "yarn global remove @mariozechner/pi-coding-agent && yarn global add @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/pi-coding-agent"],
					display: "yarn global remove @mariozechner/pi-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "@new-scope/pi"],
					display: "yarn global add @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@new-scope/pi"],
			display: "bun uninstall -g @mariozechner/pi-coding-agent && bun install -g @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "@new-scope/pi"],
					display: "bun install -g @new-scope/pi",
				},
			],
		});
	});

	test("does not self-update when the install path is not writable", () => {
		const { packageDir } = createBunGlobalInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toContain(
			"the install path is not writable",
		);
	});
});

describe("session paths", () => {
	test("uses the short app-prefixed session dir env var", () => {
		expect(ENV_SESSION_DIR).toBe("OPTIMUS_SESSION_DIR");
	});

	test("still reads the pre-rename env var so existing shells keep working", () => {
		const sessionRoot = join(tmpdir(), `pi-renamed-session-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		delete process.env[ENV_LEGACY_SESSION_DIR];
		process.env.OPTIMUS_SESSION_DIR = sessionRoot;
		try {
			expect(getSessionsDir("/agent")).toBe(sessionRoot);
		} finally {
			delete process.env.OPTIMUS_SESSION_DIR;
		}
	});

	test("uses the session root env var when computing sessions dir", () => {
		const sessionRoot = join(tmpdir(), `pi-session-root-${Date.now()}`);
		process.env[ENV_SESSION_DIR] = sessionRoot;

		expect(getSessionsDir("/agent")).toBe(sessionRoot);
	});

	test("uses the legacy coding agent session root env var when the new env var is unset", () => {
		const sessionRoot = join(tmpdir(), `pi-legacy-session-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		process.env[ENV_LEGACY_SESSION_DIR] = sessionRoot;

		expect(getSessionsDir("/agent")).toBe(sessionRoot);
	});

	test("expands tilde in the session root env var", () => {
		process.env[ENV_SESSION_DIR] = "~/optimus-sessions";

		expect(getSessionsDir("/agent")).toBe(join(homedir(), "optimus-sessions"));
	});

	test("uses the env session root as the default session dir", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-root-"));
		const cwd = join(tempDir, "project");
		const sessionRoot = join(tempDir, "sessions-root");
		process.env[ENV_SESSION_DIR] = sessionRoot;

		const sessionDir = getDefaultSessionDir(cwd, join(tempDir, "agent"));

		expect(sessionDir).toBe(sessionRoot);
	});
});
