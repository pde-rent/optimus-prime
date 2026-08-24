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
	createFindTool,
	createFindToolDefinition,
	type FindToolDetails,
	type FindToolInput,
} from "./native/find.js";

import { createGitTool, createGitToolDefinition } from "./native/git.js";
import { createGrepTool, createGrepToolDefinition } from "./native/grep.js";

export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
} from "./native/grep.js";
export {
	createHeadTool,
	createHeadToolDefinition,
	createTailTool,
	createTailToolDefinition,
	type WindowBatchDetails,
	type WindowBatchFileDetails,
	type WindowToolDetails,
} from "./native/head-tail.js";
export {
	createLnTool,
	createLnToolDefinition,
	type LnToolDetails,
	type LnToolInput,
} from "./native/ln.js";
export {
	createMailTool,
	createMailToolDefinition,
	type MailToolDetails,
	type MailToolInput,
} from "./native/mail.js";
export {
	createNetdiagTool,
	createNetdiagToolDefinition,
	type NetdiagToolDetails,
	type NetdiagToolInput,
} from "./native/netdiag.js";
export {
	createProcessesTool,
	createProcessesToolDefinition,
	type ProcessesToolDetails,
	type ProcessesToolInput,
} from "./native/processes.js";
export {
	createSedTool,
	createSedToolDefinition,
	parseSubstitution,
	type SedToolDetails,
	type SedToolInput,
} from "./native/sed.js";
export {
	createSshTool,
	createSshToolDefinition,
	type SshToolDetails,
	type SshToolInput,
} from "./native/ssh.js";
export {
	createSysinfoTool,
	createSysinfoToolDefinition,
	type SysinfoToolDetails,
	type SysinfoToolInput,
} from "./native/sysinfo.js";
export {
	createTodoTool,
	createTodoToolDefinition,
	type TodoToolDetails,
	type TodoToolInput,
} from "./native/todo.js";
export { walkFiles, walkTree } from "./native/walk.js";
export {
	createWcTool,
	createWcToolDefinition,
	type WcToolDetails,
	type WcToolInput,
} from "./native/wc.js";

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
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createEditTool, createEditToolDefinition } from "./edit.js";
import { createFindTool, createFindToolDefinition } from "./native/find.js";
import {
	createHeadTool,
	createHeadToolDefinition,
	createTailTool,
	createTailToolDefinition,
} from "./native/head-tail.js";
import { createLnTool, createLnToolDefinition } from "./native/ln.js";
import { createMailTool, createMailToolDefinition } from "./native/mail.js";
import { createNetdiagTool, createNetdiagToolDefinition } from "./native/netdiag.js";
import { createProcessesTool, createProcessesToolDefinition } from "./native/processes.js";
import { createSedTool, createSedToolDefinition } from "./native/sed.js";
import { createSshTool, createSshToolDefinition } from "./native/ssh.js";
import { createSysinfoTool, createSysinfoToolDefinition } from "./native/sysinfo.js";
import { createTodoTool, createTodoToolDefinition } from "./native/todo.js";
import { createWcTool, createWcToolDefinition } from "./native/wc.js";
import { createReadFileTool, createReadFileToolDefinition } from "./read-file.js";
import { createSkillTool, createSkillToolDefinition, type SkillToolOptions } from "./skill.js";
import { createWriteFileTool, createWriteFileToolDefinition } from "./write-file.js";

export type Tool = AgentTool;
type ToolDef = ToolDefinition;
/**
 * Priority-ordered: agents should pick the first tool that fits the job and
 * treat bash as the last resort (mission rule - natives run in-process on
 * every OS; bash assumes a Unix shell).
 */
type ToolName =
	| "read_file"
	| "write_file"
	| "edit"
	| "todo"
	| "grep"
	| "find"
	| "sed"
	| "wc"
	| "head"
	| "tail"
	| "ln"
	| "processes"
	| "sysinfo"
	| "netdiag"
	| "mail"
	| "ssh"
	| "skill"
	| "repl"
	| "git"
	| "bash";
export interface ToolsOptions {
	repl?: BunReplToolOptions;
	/** Skill provider; defaults to an empty roster (every lookup reports no skills). */
	skill?: SkillToolOptions;
	/** Live bash tool options; sessions thread defaultTimeoutSeconds from settings.toolTimeouts.bashSeconds. */
	bash?: BashToolOptions;
}

export function createAllToolDefinitions(_cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read_file: createReadFileToolDefinition(_cwd),
		write_file: createWriteFileToolDefinition(_cwd),
		edit: createEditToolDefinition(_cwd),
		todo: createTodoToolDefinition(_cwd),
		grep: createGrepToolDefinition(_cwd),
		find: createFindToolDefinition(_cwd),
		git: createGitToolDefinition(_cwd),
		sed: createSedToolDefinition(_cwd),
		wc: createWcToolDefinition(_cwd),
		head: createHeadToolDefinition(_cwd),
		tail: createTailToolDefinition(_cwd),
		ln: createLnToolDefinition(_cwd),
		processes: createProcessesToolDefinition(_cwd),
		sysinfo: createSysinfoToolDefinition(_cwd),
		netdiag: createNetdiagToolDefinition(_cwd),
		mail: createMailToolDefinition(_cwd),
		ssh: createSshToolDefinition(_cwd),
		skill: createSkillToolDefinition(_cwd, options?.skill ?? {}),
		repl: createBunReplToolDefinition(options?.repl ?? {}),
		bash: createBashToolDefinition(_cwd, options?.bash),
	};
}

export function createAllTools(_cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read_file: createReadFileTool(_cwd),
		write_file: createWriteFileTool(_cwd),
		edit: createEditTool(_cwd),
		todo: createTodoTool(_cwd),
		grep: createGrepTool(_cwd),
		find: createFindTool(_cwd),
		git: createGitTool(_cwd),
		sed: createSedTool(_cwd),
		wc: createWcTool(_cwd),
		head: createHeadTool(_cwd),
		tail: createTailTool(_cwd),
		ln: createLnTool(_cwd),
		processes: createProcessesTool(_cwd),
		sysinfo: createSysinfoTool(_cwd),
		netdiag: createNetdiagTool(_cwd),
		mail: createMailTool(_cwd),
		ssh: createSshTool(_cwd),
		skill: createSkillTool(_cwd, options?.skill ?? {}),
		repl: createBunReplTool(options?.repl ?? {}),
		bash: createBashTool(_cwd, options?.bash),
	};
}
