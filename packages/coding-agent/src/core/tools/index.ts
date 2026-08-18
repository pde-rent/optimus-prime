export { BunReplProvisioner } from "../bun-repl/provisioner.js";
export {
	type BunReplToolDetails,
	type BunReplToolOptions,
	createBunReplTool,
	createBunReplToolDefinition,
} from "../bun-repl/tool.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export type { IpythonToolDetails, IpythonToolInput } from "./kernel-types.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type BunReplToolOptions, createBunReplTool, createBunReplToolDefinition } from "../bun-repl/tool.js";
import type { ToolDefinition } from "../extensions/types.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "ipython";
export const allToolNames: Set<ToolName> = new Set(["ipython"]);

export interface ToolsOptions {
	ipython?: BunReplToolOptions;
}

export function createToolDefinition(toolName: ToolName, _cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "ipython":
			// The agent's code-execution tool is the Bun REPL (Bun-only fork).
			return createBunReplToolDefinition(options?.ipython ?? {});
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, _cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "ipython":
			return createBunReplTool(options?.ipython ?? {});
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(_cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		ipython: createBunReplToolDefinition(options?.ipython ?? {}),
	};
}

export function createAllTools(_cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		ipython: createBunReplTool(options?.ipython ?? {}),
	};
}
