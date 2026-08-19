import { isTruthyEnvVar } from "./utils/shared.js";
import { ensureTool } from "./utils/tools-manager.js";

const bootstrapTools = isTruthyEnvVar(process.env.OPTIMUS_BOOTSTRAP_TOOLS_ON_INSTALL);

if (!bootstrapTools) {
	process.exit(0);
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
} catch (error) {
	console.error(`optimus: postinstall setup skipped: ${oneLine(errorMessage(error))}`);
}
