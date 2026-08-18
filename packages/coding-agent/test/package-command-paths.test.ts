import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { APP_NAME, ENV_AGENT_DIR, PACKAGE_NAME, SELF_UPDATE_INTERACTIVE_CHILD_ENV, VERSION } from "../src/config.js";
import { main } from "../src/main.js";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function runSelfUpdateInstallChild(args: string[]): Promise<void> {
	const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
	process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
	try {
		await main(args);
	} finally {
		restoreEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, previousValue);
	}
}

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalPrimeAgentDownloadBaseUrl: string | undefined;
	let originalTmpDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;
	let originalPath: string | undefined;

	/**
	 * Stage a bun global install of the agent itself, with a fake `bun` first on
	 * PATH that answers `pm bin -g` and records every other argv it is handed.
	 * Self-update always drives `bun` (config.ts detectInstallMethod), so the fake
	 * has to be resolved from PATH rather than injected through a setting.
	 */
	function stageBunGlobalSelfInstall(options: { scope: string; recordPath: string; failOnInstall?: boolean }): {
		selfPackageDir: string;
	} {
		const prefix = join(tempDir, "bun-global");
		const binDir = join(prefix, "bin");
		const selfPackageDir = join(prefix, "install", "global", "node_modules", options.scope, "pi-coding-agent");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(selfPackageDir, { recursive: true });

		const recorderPath = join(tempDir, "fake-bun.cjs");
		writeFileSync(
			recorderPath,
			`const fs=require("node:fs"),args=process.argv.slice(2);
if(args[0]==="pm"&&args[1]==="bin"&&args[2]==="-g"){console.log(${JSON.stringify(binDir)});process.exit(0);}
const rec=${JSON.stringify(options.recordPath)};
const records=fs.existsSync(rec)?JSON.parse(fs.readFileSync(rec,"utf-8")):[];
records.push(args);
fs.writeFileSync(rec,JSON.stringify(records));
if(${options.failOnInstall ? "true" : "false"}&&args.includes("install"))process.exit(23);
`,
		);
		const bunShim = join(binDir, "bun");
		writeFileSync(
			bunShim,
			`#!/bin/sh\nexec ${JSON.stringify(originalExecPath)} ${JSON.stringify(recorderPath)} "$@"\n`,
		);
		chmodSync(bunShim, 0o755);

		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", { value: join(selfPackageDir, "dist", "cli.js"), configurable: true });
		return { selfPackageDir };
	}

	function readRecordedCalls(recordPath: string): string[][] {
		return JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
	}

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalPrimeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
		originalTmpDir = process.env.TMPDIR;
		// Bun ignores `process.exitCode = undefined` (unlike Node), so the suite has
		// to reset with 0 or one failing command leaks its exit code into every
		// later test.
		originalExitCode = process.exitCode ?? 0;
		originalExecPath = process.execPath;
		originalPath = process.env.PATH;
		process.exitCode = 0;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.TMPDIR = tempDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode ?? 0;
		restoreEnv(ENV_AGENT_DIR, originalAgentDir);
		restoreEnv("PI_PACKAGE_DIR", originalPiPackageDir);
		restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalPrimeAgentDownloadBaseUrl);
		restoreEnv("TMPDIR", originalTmpDir);
		restoreEnv("PATH", originalPath);
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["package", "install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["package", "install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["package", "remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain(`${APP_NAME} package install <source> [--local]`);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(0);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain(`Use "${APP_NAME} --help" or "${APP_NAME} package install <source> [--local]".`);
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("directs the removed -l package option to --local", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", packageDir, "-l"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Option -l was removed. Use "--local".');
			expect(process.exitCode).toBe(1);
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("treats -l as an unknown option for package update", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "-l"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option -l for "update".');
			expect(stderr).not.toContain('Use "--local".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain(`Usage: ${APP_NAME} package install <source> [--local]`);
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("installs the release manifest tarball spec for forced self updates", async () => {
		const recordPath = join(tempDir, "self-update.json");
		const tarballUrl = "https://downloads.example.test/prime-agent/prime-agent-current.tgz";
		stageBunGlobalSelfInstall({ scope: "@earendil-works", recordPath });
		const fetchMock = vi.fn(async () => Response.json({ tarball: tarballUrl, version: VERSION }));
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self", "--force"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(readRecordedCalls(recordPath)).toEqual([["install", "-g", tarballUrl]]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("uses the current package name when the update check omits packageName", async () => {
		const recordPath = join(tempDir, "self-update.json");
		stageBunGlobalSelfInstall({ scope: "@mariozechner", recordPath });
		const fetchMock = vi.fn(async () => Response.json({ version: getNewerPatchVersion() }));
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(readRecordedCalls(recordPath)).toEqual([["install", "-g", PACKAGE_NAME]]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs the active package name from the update check during self-update", async () => {
		const recordPath = join(tempDir, "self-update.json");
		stageBunGlobalSelfInstall({ scope: "@mariozechner", recordPath });
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(readRecordedCalls(recordPath)).toEqual([
				["uninstall", "-g", PACKAGE_NAME],
				["install", "-g", activePackageName],
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs the Prime Agent tarball from the update manifest during self-update", async () => {
		const recordPath = join(tempDir, "self-update.json");
		const baseUrl = "https://downloads.example.test/prime-agent";
		const newerVersion = getNewerPatchVersion();
		const tarballPath = `releases/v${newerVersion}/prime-agent-${newerVersion}.tgz`;
		stageBunGlobalSelfInstall({ scope: "@earendil-works", recordPath });
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = baseUrl;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ package: "prime-agent", tarball: tarballPath, version: newerVersion })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(readRecordedCalls(recordPath)).toEqual([
				["install", "-g", `${baseUrl}/${tarballPath}`],
				["uninstall", "-g", PACKAGE_NAME],
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("does not self-update when the same-version manifest uses the Prime Agent package alias", async () => {
		const recordPath = join(tempDir, "self-update.json");
		const baseUrl = "https://downloads.example.test/prime-agent";
		stageBunGlobalSelfInstall({ scope: "@earendil-works", recordPath });
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = baseUrl;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					package: "prime-agent",
					tarball: "releases/current/prime-agent.tgz",
					version: VERSION,
				}),
			),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("is already up to date");
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("fails self-update when renamed package installation fails", async () => {
		const recordPath = join(tempDir, "self-update-fail.json");
		stageBunGlobalSelfInstall({ scope: "@mariozechner", recordPath, failOnInstall: true });
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain(`Updated pi`);
			expect(stderr).toContain("exited with code 23");
			expect(readRecordedCalls(recordPath)).toEqual([
				["uninstall", "-g", PACKAGE_NAME],
				["install", "-g", activePackageName],
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
