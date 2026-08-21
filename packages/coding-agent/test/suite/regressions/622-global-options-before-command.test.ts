import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const mocks = {
	daemonCommands: [] as string[][],
};

// Snapshot the real exports: mock.module patches the live module namespace in place, so a
// bare namespace reference would resolve to the mock and recurse forever.
const actualDaemonCommand = { ...(await import("../../../src/cli/daemon-command.js")) };

mock.module("../../../src/cli/daemon-command.js", () => ({
	handleDaemonCommand: async (args: string[]) => {
		mocks.daemonCommands.push(args);
		return true;
	},
}));

const { handlePublicCommand } = await import("../../../src/cli/public-command.js");

// Restore the real module so the mock does not leak into other test files in this process.
afterAll(() => {
	mock.module("../../../src/cli/daemon-command.js", () => actualDaemonCommand);
});

describe("issue #622 global options before commands", () => {
	beforeEach(() => {
		mocks.daemonCommands.length = 0;
	});

	it.each([
		["stop", ["worker"], ["kill", "worker"]],
		["rename", ["worker", "reviewer"], ["rename", "worker", "reviewer"]],
	])(
		"routes %s with the documented socket option before or after the command",
		async (command, operands, internalArgs) => {
			const socketPath = "/tmp/custom-daemon.sock";

			await expect(
				handlePublicCommand(["--daemon-socket", socketPath, command, ...operands]),
			).resolves.toMatchObject({ handled: true });
			await expect(
				handlePublicCommand([command, ...operands, "--daemon-socket", socketPath]),
			).resolves.toMatchObject({ handled: true });
			await expect(handlePublicCommand([command, ...operands, "--socket", socketPath])).resolves.toMatchObject({
				handled: true,
			});

			expect(mocks.daemonCommands).toEqual([
				["daemon", ...internalArgs, "--daemon-socket", socketPath],
				["daemon", ...internalArgs, "--daemon-socket", socketPath],
				["daemon", ...internalArgs, "--socket", socketPath],
			]);
		},
	);
});
