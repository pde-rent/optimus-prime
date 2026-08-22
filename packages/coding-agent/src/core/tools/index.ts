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
export {
	createReadFileTool,
	createReadFileToolDefinition,
	type ReadFileOperations,
	type ReadFileToolDetails,
	type ReadFileToolInput,
	type ReadFileToolOptions,
} from "./read-file.js";
export type { ReplToolDetails, ReplToolInput } from "./repl-types.js";
export {
	createSkillTool,
	createSkillToolDefinition,
	type SkillOperations,
	type SkillToolDetails,
	type SkillToolInput,
	type SkillToolOptions,
} from "./skill.js";
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
export {
	createWriteFileTool,
	createWriteFileToolDefinition,
	type WriteFileOperations,
	type WriteFileToolDetails,
	type WriteFileToolInput,
	type WriteFileToolOptions,
} from "./write-file.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type BunReplToolOptions, createBunReplTool, createBunReplToolDefinition } from "../bun-repl/tool.js";
import type { ToolDefinition } from "../extensions/types.js";
import { createSkillTool, createSkillToolDefinition, type SkillToolOptions } from "./skill.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "repl" | "skill";

export interface ToolsOptions {
	repl?: BunReplToolOptions;
	/** Skill provider; defaults to an empty roster (every lookup reports no skills). */
	skill?: SkillToolOptions;
}

export function createAllToolDefinitions(_cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		repl: createBunReplToolDefinition(options?.repl ?? {}),
		skill: createSkillToolDefinition(_cwd, options?.skill ?? {}),
	};
}

export function createAllTools(_cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		repl: createBunReplTool(options?.repl ?? {}),
		skill: createSkillTool(_cwd, options?.skill ?? {}),
	};
}
