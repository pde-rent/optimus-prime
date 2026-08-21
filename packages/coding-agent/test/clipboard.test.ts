import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Snapshot the real exports: mock.module patches the live module namespace in place, so a
// bare namespace reference would resolve to the mock and recurse forever.
const actualChildProcess = { ...(await import("child_process")) };
const actualOs = { ...(await import("os")) };
const actualClipboardImage = { ...(await import("../src/utils/clipboard-image.js")) };

const mocks = {
	execSync: mock(),
	spawn: mock(),
	platform: mock<() => NodeJS.Platform>(),
	isWaylandSession: mock<() => boolean>(),
};

mock.module("child_process", () => {
	return {
		...actualChildProcess,
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

mock.module("os", () => {
	return {
		...actualOs,
		platform: mocks.platform,
	};
});

mock.module("../src/utils/clipboard-image.js", () => {
	return {
		...actualClipboardImage,
		isWaylandSession: mocks.isWaylandSession,
	};
});

const { copyToClipboard } = await import("../src/utils/clipboard.js");

// Restore the real modules so the mocks do not leak into other test files in this process.
afterAll(() => {
	mock.module("child_process", () => actualChildProcess);
	mock.module("os", () => actualOs);
	mock.module("../src/utils/clipboard-image.js", () => actualClipboardImage);
});

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\u001b]52;c;"));
}

const stubbedEnvKeys = ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"] as const;
const originalEnvValues = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of stubbedEnvKeys) {
		originalEnvValues.set(key, process.env[key]);
		process.env[key] = "";
	}
	stdoutWrites = [];
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mocks.platform.mockReturnValue("darwin");
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
	for (const key of stubbedEnvKeys) {
		const original = originalEnvValues.get(key);
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
});

describe("copyToClipboard", () => {
	test("darwin local: pbcopy success skips OSC 52", async () => {
		mocks.execSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mocks.execSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	test("remote: emits OSC 52 after a successful local write", async () => {
		process.env.SSH_CONNECTION = "client server";
		mocks.execSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mocks.execSync).toHaveBeenCalledWith("pbcopy", expect.anything());
		expect(osc52Writes()).toHaveLength(1);
	});

	test("darwin: pbcopy failure falls back to OSC 52", async () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("win32: uses PowerShell Set-Clipboard for Unicode safety", async () => {
		mocks.platform.mockReturnValue("win32");
		mocks.execSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("héllo 世界");

		expect(mocks.execSync).toHaveBeenCalledWith(
			'powershell -NoProfile -Command "Set-Clipboard -Value ([Console]::In.ReadToEnd())"',
			expect.objectContaining({ input: "héllo 世界" }),
		);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
