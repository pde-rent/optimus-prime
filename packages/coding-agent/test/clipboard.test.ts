import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { execSync, spawn } from "child_process";
import { platform } from "os";

const mocks = vi.hoisted(() => {
	return {
		execSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("child_process", () => {
	return {
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const { copyToClipboard } = await import("../src/utils/clipboard.js");

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\u001b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\u001b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("copyToClipboard", () => {
	test("darwin local: pbcopy success skips OSC 52", async () => {
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote: emits OSC 52 after a successful local write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", expect.anything());
		expect(osc52Writes()).toHaveLength(1);
	});

	test("darwin: pbcopy failure falls back to OSC 52", async () => {
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("win32: uses PowerShell Set-Clipboard for Unicode safety", async () => {
		mockedPlatform.mockReturnValue("win32");
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("héllo 世界");

		expect(mockedExecSync).toHaveBeenCalledWith(
			'powershell -NoProfile -Command "Set-Clipboard -Value ([Console]::In.ReadToEnd())"',
			expect.objectContaining({ input: "héllo 世界" }),
		);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
