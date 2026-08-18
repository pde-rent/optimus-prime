import { ensureKernelPython } from "./core/kernel/bootstrap.js";
import { isTruthyEnvVar } from "./utils/shared.js";
import { ensureTool } from "./utils/tools-manager.js";

const bootstrapKernel = isTruthyEnvVar(process.env.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL);
const bootstrapTools = isTruthyEnvVar(process.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL);

if (!bootstrapKernel && !bootstrapTools) {
	process.exit(0);
}

if (bootstrapKernel && process.env.PRIME_AGENT_INSTALL_UV === undefined) {
	process.env.PRIME_AGENT_INSTALL_UV = "1";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

try {
	if (bootstrapTools) {
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	}
	if (bootstrapKernel) {
		await ensureKernelPython();
	}
} catch (error) {
	console.error(`prime-agent: postinstall setup skipped: ${oneLine(errorMessage(error))}`);
}
