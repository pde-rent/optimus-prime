import { beforeEach, describe, expect, test, vi } from "bun:test";
import type { SpawnSyncReturns } from "child_process";
import { writeFileSync } from "fs";

const mocks = vi.hoisted(() => {
	return {
		spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
	};
});

vi.mock("child_process", () => {
	return {
		spawnSync: mocks.spawnSync,
	};
});

function spawnOk(stdout: Buffer): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	};
}

function spawnError(error: Error): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: null,
		signal: null,
		error,
	};
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
	});

	test("Wayland: uses wl-paste and never calls osascript/powershell", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(Buffer.from([1, 2, 3]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		const enoent = new Error("spawn ENOENT");
		(enoent as { code?: string }).code = "ENOENT";

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste") {
				return spawnError(enoent);
			}
			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}
			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([9, 8]));
			}
			return spawnOk(Buffer.alloc(0));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return spawnOk(Buffer.alloc(0));
			}
			if (command === "wslpath") {
				tmpFile = args[1];
				return spawnOk(Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
			}
			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.PI_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				return spawnOk(Buffer.from("ok\n", "utf-8"));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
	});

	test("Non-Wayland X11: uses xclip", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}
			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([7]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("darwin: reads PNG via osascript and returns null when absent", async () => {
		// No image: osascript exits non-zero.
		mocks.spawnSync.mockImplementation(() => {
			return { ...spawnOk(Buffer.alloc(0)), status: 1 };
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "darwin", env: {} });
		expect(result).toBeNull();
		expect(mocks.spawnSync).toHaveBeenCalledWith("osascript", expect.any(Array), expect.anything());
	});

	test("win32: uses powershell GetImage and returns bytes", async () => {
		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "powershell") {
				const psScript = args[2];
				const m = /\$path = '([^']+)'/.exec(psScript);
				if (!m) throw new Error("no $path in script");
				tmpFile = m[1];
				writeFileSync(tmpFile, Buffer.from([8, 9]));
				return spawnOk(Buffer.from("ok\n", "utf-8"));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([8, 9]);
		expect(tmpFile).toBeDefined();
	});
});
