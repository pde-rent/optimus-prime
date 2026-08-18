import { execFileSync } from "node:child_process";

function resolveBunPath(): string {
	if (process.versions.bun) {
		return process.execPath;
	}
	try {
		const found = execFileSync(process.platform === "win32" ? "where" : "which", ["bun"], {
			encoding: "utf-8",
		})
			.split("\n")[0]
			?.trim();
		if (found) {
			return found;
		}
	} catch {
		// Fall through to the PATH lookup performed by spawn().
	}
	return "bun";
}

/**
 * Absolute path to the Bun binary used to spawn CLI subprocesses from tests.
 * Vitest workers run under Node, so `process.execPath` is the Node binary and
 * cannot execute the TypeScript sources directly.
 */
export const BUN_PATH = resolveBunPath();
