import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, ServiceTier, TextContent, Usage } from "@earendil-works/pi-ai";
import {
	appendFileSync,
	chmodSync,
	chownSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import { readFirstLineSync, readLinesAsBuffers } from "../utils/file-lines.js";
import { captureGitContext, type GitContext, gitContextsEqual } from "../utils/git.js";
import { ensureDir } from "../utils/shared.js";
import { v7 as uuidv7 } from "../utils/uuid.js";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.js";
import { cloneUsage } from "./usage.js";

export const CURRENT_SESSION_VERSION = 3;
const SESSION_LIST_SEARCH_TEXT_MAX_CHARS = 64 * 1024;
const SESSION_LIST_PARSE_MAX_LINE_CHARS = 1024 * 1024;
const SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS = 256;
const SESSION_STREAMING_LOAD_THRESHOLD_BYTES = 128 * 1024 * 1024;
const SESSION_ASYNC_PARSE_YIELD_BYTES = 4 * 1024 * 1024;
// Entry types whose payloads can dominate resident memory (multi-MB tool
// results, images). Only these become stubs on offload; small bookkeeping
// entries stay intact.
const OFFLOADABLE_ENTRY_TYPES = new Set(["message", "custom_message"]);
// _rewriteFile flushes serialized entries to its temp file in chunks of about
// this size instead of materializing one string for the whole file.
const REWRITE_FLUSH_BYTES = 1024 * 1024;

// Entry types that can represent user intent (vs. daemon bookkeeping like
// session_state/agent_status/git_state/child_usage_attributed). Used by
// hasUserContent to decide whether a message-less draft is safe to discard.
const CONTENT_ENTRY_TYPES = new Set([
	"message",
	"custom_message",
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"session_info",
	"label",
	"compaction",
	"branch_summary",
]);

function realpathIfPresent(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
		throw error;
	}
}

function statMetadataIfPresent(path: string): { mode: number; uid: number; gid: number } | undefined {
	try {
		const { mode, uid, gid } = statSync(path);
		return { mode: mode & 0o777, uid, gid };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	rlmDepth?: number;
	git?: GitContext;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	rlmDepth?: number;
}

export type SessionPersistListener = (sessionFile: string) => void;

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

type AssistantSessionMessageEntry = SessionMessageEntry & { message: AssistantMessage };

/** Who or what moved the level; `model_self`/`escalation` are dynamic-effort moves. */
export type ThinkingLevelChangeReason = "user" | "model_self" | "escalation" | "spawn" | "model_switch" | "resume";

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
	reason?: ThinkingLevelChangeReason;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTier;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
	customInstructions?: string;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/**
 * Records usage folded into a parent assistant message after an RLM child run.
 * The child usage is kept separately so audit/UI code can explain why the
 * parent turn's aggregate usage exceeds the parent model response itself.
 */
export interface ChildUsageAttributionEntry extends SessionEntryBase {
	type: "child_usage_attributed";
	targetId: string;
	childUsage: Usage;
	aggregateUsage: Usage;
	origin?: "spawn_task" | "agent_message" | "direct_user";
	/** Which child spent it. Without this the ledger totals a cohort but cannot itemise it. */
	rlmChildId?: string;
	childSessionName?: string;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export type SessionStateStatus = "active" | "archived" | "crash";

export interface SessionState {
	status: SessionStateStatus;
}

export interface SessionStateEntry extends SessionEntryBase {
	type: "session_state";
	state: SessionState;
}

export type AgentTaskState = "needs_input" | "completed";

export interface AgentStatus {
	summary: string;
	taskState?: AgentTaskState;
	basedOnMessageCount: number;
}

export interface AgentStatusEntry extends SessionEntryBase {
	type: "agent_status";
	status: AgentStatus;
}

export interface GitStateEntry extends SessionEntryBase {
	type: "git_state";
	git: GitContext;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ServiceTierChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| ChildUsageAttributionEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| SessionStateEntry
	| AgentStatusEntry
	| GitStateEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeFlatNode {
	entry: SessionEntry;
	label?: string;
	labelTimestamp?: string;
}

export interface SessionTreeNode extends SessionTreeFlatNode {
	children: SessionTreeNode[];
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	serviceTier: ServiceTier;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: SessionState;
	parentSessionPath?: string;
	rlmDepth: number;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	agentStatus?: AgentStatus;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

function getSessionFilePath(sessionDir: string, sessionId: string): string {
	return join(sessionDir, `${sessionId}.jsonl`);
}

function createUniqueSessionFileTarget(sessionDir: string): { sessionId: string; sessionFile: string } {
	for (let i = 0; i < 100; i++) {
		const sessionId = createSessionId();
		const sessionFile = getSessionFilePath(sessionDir, sessionId);
		if (!existsSync(sessionFile)) {
			return { sessionId, sessionFile };
		}
	}
	throw new Error("Unable to create a unique session file");
}

export function getSessionArtifactsRoot(sessionDir: string): string {
	return join(dirname(sessionDir), "session-artifacts");
}

export function getSessionArtifactPath(sessionDir: string, sessionId: string): string {
	return join(getSessionArtifactsRoot(sessionDir), sessionId);
}

export function getSessionArtifactPathForFile(sessionFile: string, sessionId?: string): string {
	return getSessionArtifactPath(dirname(sessionFile), sessionId ?? basename(sessionFile).replace(/\.jsonl$/, ""));
}

function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}

function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines.
		}
	}

	applyChildUsageAttributions(entries);
	return entries;
}

function applyChildUsageAttributions(entries: FileEntry[]): void {
	const assistantEntriesById = new Map<string, AssistantSessionMessageEntry>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			assistantEntriesById.set(entry.id, entry as AssistantSessionMessageEntry);
		}
	}

	for (const entry of entries) {
		if (entry.type !== "child_usage_attributed") continue;
		const target = assistantEntriesById.get(entry.targetId);
		if (!target) continue;
		target.message.usage = cloneUsage(entry.aggregateUsage);
	}
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}
/**
 * Stub left in resident memory when an entry is offloaded after compaction.
 * Keeps identity/tree fields plus the fields usage accounting and index
 * building read; the full entry stays in the session file and is hydrated
 * back on demand.
 */
function createOffloadedStub(entry: SessionEntry): SessionEntry {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
	if (entry.type === "message") {
		const message = entry.message;
		// usage must survive offload: computeOwnAndTotalUsage sums it across all
		// entries, cumulative across compactions. Assistant stubs also keep the
		// provider/model fields buildSessionContext reads for model attribution.
		const stubMessage: AgentMessage =
			message.role === "assistant"
				? ({
						role: "assistant",
						usage: message.usage,
						provider: message.provider,
						model: message.model,
						stopReason: message.stopReason,
					} as AssistantMessage)
				: ({ role: message.role } as Message);
		return { type: "message", ...base, message: stubMessage };
	}
	return {
		type: "custom_message",
		...base,
		customType: (entry as CustomMessageEntry).customType,
		content: "",
		display: (entry as CustomMessageEntry).display,
	};
}

function writeAllSync(fd: number, text: string): void {
	const buffer = Buffer.from(text, "utf8");
	let written = 0;
	while (written < buffer.length) {
		written += writeSync(fd, buffer, written);
	}
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
	}

	// push+reverse, not unshift-per-entry: unshift is O(n), making this O(n^2) on long sessions.
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	let thinkingLevel = "off";
	let serviceTier: ServiceTier = "default";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "service_tier_change") {
			serviceTier = entry.serviceTier;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// Build messages and collect corresponding entries
	// When there's a compaction, model context remains summary-first while the
	// summary records where clients should present it among retained messages.
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry, target = messages) => {
		if (entry.type === "message") {
			target.push(entry.message);
		} else if (entry.type === "custom_message") {
			target.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			target.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);

		// Collect kept messages (before compaction, starting from firstKeptEntryId).
		// The context remains summary-first for the model; retainedMessageCount records
		// the exact chronological presentation boundary for clients.
		const retainedMessages: AgentMessage[] = [];
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry, retainedMessages);
			}
		}

		messages.push(
			createCompactionSummaryMessage(
				compaction.summary,
				compaction.tokensBefore,
				compaction.timestamp,
				compaction.customInstructions,
				retainedMessages.length,
			),
			...retainedMessages,
		);

		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, serviceTier, model };
}

export function getDefaultSessionDir(_cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getSessionsDir(agentDir);
	ensureDir(sessionDir);
	return sessionDir;
}

// Decode per line off a Buffer: toString("utf8") on a whole large file is far slower
// (one giant UTF-16 string). Splitting on 0x0a is UTF-8-safe.
function appendEntryFromBuffer(entries: FileEntry[], buffer: Buffer, start = 0, end = buffer.length): void {
	if (end <= start) return;
	try {
		entries.push(JSON.parse(buffer.toString("utf8", start, end)) as FileEntry);
	} catch {
		// Skip malformed or blank lines.
	}
}

function parseEntriesFromBuffer(buffer: Buffer): FileEntry[] {
	const entries: FileEntry[] = [];
	let start = 0;
	while (start < buffer.length) {
		let end = buffer.indexOf(0x0a, start);
		if (end === -1) end = buffer.length;
		appendEntryFromBuffer(entries, buffer, start, end);
		start = end + 1;
	}
	return entries;
}

async function parseEntriesFromBufferAsync(buffer: Buffer): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	let start = 0;
	let bytesSinceYield = 0;
	while (start < buffer.length) {
		let end = buffer.indexOf(0x0a, start);
		if (end === -1) end = buffer.length;
		appendEntryFromBuffer(entries, buffer, start, end);
		bytesSinceYield += end - start + 1;
		start = end + 1;
		if (bytesSinceYield >= SESSION_ASYNC_PARSE_YIELD_BYTES) {
			bytesSinceYield = 0;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	return entries;
}

function finalizeLoadedEntries(entries: FileEntry[]): FileEntry[] {
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as any).id !== "string") {
		return [];
	}
	applyChildUsageAttributions(entries);
	return entries;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	if (!existsSync(filePath)) return [];
	return finalizeLoadedEntries(parseEntriesFromBuffer(readFileSync(filePath)));
}

// Async loader for the daemon: reads off the event loop and yields while parsing so a
// large load doesn't freeze other sessions. Large files stream to avoid retaining both
// the full input Buffer and the parsed entry graph at the same time.
export async function loadEntriesFromFileAsync(
	filePath: string,
	options: { streamThresholdBytes?: number } = {},
): Promise<FileEntry[]> {
	if (!existsSync(filePath)) return [];
	const streamThresholdBytes = options.streamThresholdBytes ?? SESSION_STREAMING_LOAD_THRESHOLD_BYTES;
	if ((await stat(filePath)).size < streamThresholdBytes) {
		return finalizeLoadedEntries(await parseEntriesFromBufferAsync(await readFile(filePath)));
	}

	const entries: FileEntry[] = [];
	let bytesSinceYield = 0;
	for await (const line of readLinesAsBuffers(filePath)) {
		appendEntryFromBuffer(entries, line);
		bytesSinceYield += line.length + 1;
		if (bytesSinceYield >= SESSION_ASYNC_PARSE_YIELD_BYTES) {
			bytesSinceYield = 0;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	return finalizeLoadedEntries(entries);
}

function readSessionHeader(filePath: string): Partial<SessionHeader> | undefined {
	const firstLine = readFirstLineSync(filePath);
	if (!firstLine) {
		return undefined;
	}
	return JSON.parse(firstLine) as Partial<SessionHeader>;
}

function isValidRlmDepth(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveSessionRlmDepth(
	header: { rlmDepth?: number; parentSession?: string },
	sessionPath: string,
): number {
	return resolveLegacySessionRlmDepth(header, sessionPath, new Set()) ?? legacyChildDepthFromPath(sessionPath);
}

function resolveLegacySessionRlmDepth(
	header: { rlmDepth?: number; parentSession?: string },
	sessionPath: string,
	visitedPaths: Set<string>,
): number | undefined {
	if (isValidRlmDepth(header.rlmDepth)) {
		return header.rlmDepth;
	}
	if (!header.parentSession) {
		return 0;
	}

	const resolvedSessionPath = resolve(sessionPath);
	if (visitedPaths.has(resolvedSessionPath)) {
		return undefined;
	}
	visitedPaths.add(resolvedSessionPath);

	const pathDepth = legacyChildDepthFromPath(sessionPath);
	const parentSessionPath = resolve(dirname(sessionPath), header.parentSession);
	try {
		const parentHeader = readSessionHeader(parentSessionPath);
		if (parentHeader) {
			const parentDepth = resolveLegacySessionRlmDepth(parentHeader, parentSessionPath, visitedPaths);
			if (parentDepth !== undefined) {
				return pathDepth > 0 ? parentDepth + 1 : parentDepth;
			}
		}
	} catch {
		// Fall back to artifact ancestry for unavailable or invalid legacy parents.
	} finally {
		visitedPaths.delete(resolvedSessionPath);
	}
	return pathDepth;
}

function legacyChildDepthFromPath(sessionPath: string): number {
	let depth = 0;
	for (const segment of dirname(sessionPath)
		.split(/[\\/]+/)
		.reverse()) {
		if (!/^sub-[0-9a-f]{8}$/.test(segment)) {
			break;
		}
		depth += 1;
	}
	return depth;
}

function deriveChildRlmDepth(parentHeader: Partial<SessionHeader> | undefined): number | undefined {
	const depth = parentHeader?.rlmDepth;
	return isValidRlmDepth(depth) && depth < Number.MAX_SAFE_INTEGER ? depth + 1 : undefined;
}

function rootRlmDepthFromEnv(): number {
	const value = process.env.RLM_DEPTH;
	if (value === undefined || value === "") {
		return 0;
	}
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !isValidRlmDepth(parsed)) {
		throw new Error("RLM_DEPTH must be a non-negative integer");
	}
	return parsed;
}

function isValidSessionFile(filePath: string): boolean {
	try {
		const header = readSessionHeader(filePath);
		return header?.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

export function findMostRecentSession(sessionDir: string): string | null {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.filter(isValidSessionFile)
			.map((path) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

function sessionInfoMatchesCwd(session: SessionInfo, cwd: string): boolean {
	return !!session.cwd && normalizeCwd(session.cwd) === normalizeCwd(cwd);
}

function sessionHeaderMatchesCwd(header: Partial<SessionHeader> | undefined, cwd: string): boolean {
	return (
		header?.type === "session" &&
		typeof header.id === "string" &&
		typeof header.cwd === "string" &&
		normalizeCwd(header.cwd) === normalizeCwd(cwd)
	);
}

function findMostRecentSessionForCwd(sessionDir: string, cwd: string): string | null {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.map((path) => {
				try {
					const header = readSessionHeader(path);
					if (!sessionHeaderMatchesCwd(header, cwd)) {
						return undefined;
					}
					return { path, mtime: statSync(path).mtime };
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is { path: string; mtime: Date } => entry !== undefined)
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function normalizeSessionStateStatus(value: unknown): SessionStateStatus | undefined {
	if (value === "active" || value === "archived" || value === "crash") {
		return value;
	}
	if (value === "hidden" || value === "sleep") {
		return "archived";
	}
	return undefined;
}

function updateLastActivityTime(lastActivityTime: number | undefined, entry: FileEntry): number | undefined {
	if (entry.type !== "message") {
		return lastActivityTime;
	}

	const message = (entry as SessionMessageEntry).message;
	if (!isMessageWithContent(message)) {
		return lastActivityTime;
	}
	if (message.role !== "user" && message.role !== "assistant") {
		return lastActivityTime;
	}

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return Math.max(lastActivityTime ?? 0, msgTimestamp);
	}

	const entryTimestamp = (entry as SessionEntryBase).timestamp;
	if (typeof entryTimestamp === "string") {
		const t = new Date(entryTimestamp).getTime();
		if (!Number.isNaN(t)) {
			return Math.max(lastActivityTime ?? 0, t);
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDateFromLastActivity(
	lastActivityTime: number | undefined,
	header: SessionHeader,
	statsMtime: Date,
): Date {
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

function appendCappedSearchText(current: string, text: string): string {
	if (!text || current.length >= SESSION_LIST_SEARCH_TEXT_MAX_CHARS) {
		return current;
	}
	const next = current ? ` ${text}` : text;
	return current + next.slice(0, SESSION_LIST_SEARCH_TEXT_MAX_CHARS - current.length);
}

function looksLikeMessageEntry(line: string): boolean {
	return line.includes('"type":"message"') || line.includes('"type": "message"');
}

function extractJsonStringPropertyPrefix(
	text: string,
	propertyName: string,
	maxChars: number,
	startIndex = 0,
): string | undefined {
	const propertyIndex = text.indexOf(`"${propertyName}"`, startIndex);
	if (propertyIndex < 0) {
		return undefined;
	}
	let index = propertyIndex + propertyName.length + 2;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	if (text[index] !== ":") {
		return undefined;
	}
	index++;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	if (text[index] !== '"') {
		return undefined;
	}
	index++;

	let result = "";
	let escaped = false;
	for (; index < text.length && result.length < maxChars; index++) {
		const char = text[index];
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			break;
		}
		result += char;
	}
	return result;
}

function extractOversizedMessageSummary(line: string): {
	role?: string;
	timestamp?: number;
	textPreview?: string;
} {
	const timestampText = extractJsonStringPropertyPrefix(line, "timestamp", 64);
	const timestamp = timestampText ? new Date(timestampText).getTime() : NaN;
	const messageIndex = line.indexOf('"message"');
	const role =
		messageIndex >= 0
			? extractJsonStringPropertyPrefix(line, "role", 64, messageIndex)
			: extractJsonStringPropertyPrefix(line, "role", 64);
	let textPreview: string | undefined;
	if (messageIndex >= 0) {
		textPreview =
			extractJsonStringPropertyPrefix(line, "content", SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS, messageIndex) ??
			extractJsonStringPropertyPrefix(line, "text", SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS, messageIndex);
	}
	return {
		role,
		...(Number.isNaN(timestamp) ? {} : { timestamp }),
		...(textPreview ? { textPreview } : {}),
	};
}

interface SessionInfoCacheEntry {
	size: number;
	mtimeMs: number;
	info: SessionInfo | null;
}

// Session files are append-only, so an unchanged (size, mtimeMs) means identical
// content: cache list metadata and rescan only files that changed.
const sessionInfoCache = new Map<string, SessionInfoCacheEntry>();

export async function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
	let stats: Stats;
	try {
		stats = await stat(filePath);
	} catch {
		return null;
	}
	const cached = sessionInfoCache.get(filePath);
	if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
		return cached.info;
	}
	const info = await scanSessionInfo(filePath, stats);
	sessionInfoCache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, info });
	return info;
}

async function scanSessionInfo(filePath: string, stats: Stats): Promise<SessionInfo | null> {
	try {
		let header: SessionHeader | undefined;
		let messageCount = 0;
		let firstMessage = "";
		let allMessagesText = "";
		let name: string | undefined;
		let state: SessionState | undefined;
		let agentStatus: AgentStatus | undefined;
		let lastActivityTime: number | undefined;

		for await (const lineBuffer of readLinesAsBuffers(filePath)) {
			const line = lineBuffer.toString("utf8");
			if (!line.trim()) continue;

			// Large tool-result entries can be many MB. They do not carry the
			// session-list metadata we need, and parsing them during every refresh
			// can exhaust the daemon heap.
			if (line.length > SESSION_LIST_PARSE_MAX_LINE_CHARS) {
				if (looksLikeMessageEntry(line)) {
					messageCount++;
					const summary = extractOversizedMessageSummary(line);
					if (typeof summary.timestamp === "number" && (summary.role === "user" || summary.role === "assistant")) {
						lastActivityTime = Math.max(lastActivityTime ?? 0, summary.timestamp);
					}
					if (summary.role === "user" && !firstMessage) {
						firstMessage = summary.textPreview || "(large message)";
					}
				}
				continue;
			}

			const trimmed = line.trim();
			let entry: FileEntry;
			try {
				entry = JSON.parse(trimmed) as FileEntry;
			} catch {
				continue;
			}

			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}
			if (entry.type === "session_state") {
				const stateEntry = entry as SessionStateEntry;
				const status = normalizeSessionStateStatus(stateEntry.state?.status);
				if (status) {
					state = { status };
				}
			}
			// Keep the latest recap/verdict so off-daemon sessions don't all show as
			// unjudged in the agents view. Append-only, so last seen wins.
			if (entry.type === "agent_status") {
				agentStatus = (entry as AgentStatusEntry).status;
			}

			if (!header) {
				if (entry.type !== "session") {
					return null;
				}
				header = entry as SessionHeader;
			}

			lastActivityTime = updateLastActivityTime(lastActivityTime, entry);

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessagesText = appendCappedSearchText(allMessagesText, textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;
		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const rlmDepth = resolveSessionRlmDepth(header, filePath);
		const modified = getSessionModifiedDateFromLastActivity(lastActivityTime, header, stats.mtime);

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			state,
			parentSessionPath,
			rlmDepth,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText,
			agentStatus,
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;
export type SessionListItem = (session: SessionInfo) => void;

export interface SessionListCallbacks {
	onProgress?: SessionListProgress;
	onSession?: SessionListItem;
}

async function listSessionsFromDir(
	dir: string,
	callbacks?: SessionListCallbacks,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		const present = new Set(files);
		for (const key of sessionInfoCache.keys()) {
			if (dirname(key) === dir && !present.has(key)) {
				sessionInfoCache.delete(key);
			}
		}

		let loaded = 0;
		for (const file of files) {
			const info = await readSessionInfo(file);
			loaded++;
			callbacks?.onProgress?.(progressOffset + loaded, total);
			if (info) {
				sessions.push(info);
				callbacks?.onSession?.(info);
			}
		}
	} catch {
		// Return no sessions when the directory cannot be read.
	}

	return sessions;
}

export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEnsured = false;
	private hasAssistantEntry = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private persistListeners = new Set<SessionPersistListener>();
	private stubIds: Set<string> = new Set();

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		preloadedEntries?: FileEntry[],
	) {
		this.cwd = cwd;
		this.sessionDir = sessionDir;
		this.persist = persist;
		if (persist && sessionDir && !existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this.setSessionFile(sessionFile, preloadedEntries);
		} else {
			this.newSession();
		}
	}

	/**
	 * Switch to a different session file (used for resume and branching).
	 * preloadedEntries must be loadEntriesFromFile(sessionFile) for the same path; it
	 * lets the async daemon path skip the synchronous re-read.
	 */
	setSessionFile(sessionFile: string, preloadedEntries?: FileEntry[]): void {
		this.sessionFile = resolve(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = preloadedEntries ?? loadEntriesFromFile(this.sessionFile);
			this.fileEnsured = true;

			// If file was empty or corrupted (no valid header), truncate and start fresh
			// to avoid appending messages without a session header (which breaks the session)
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				this.fileEnsured = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			let shouldRewrite = migrateToCurrentVersion(this.fileEntries);
			if (header?.parentSession && !isValidRlmDepth(header.rlmDepth)) {
				header.rlmDepth = resolveSessionRlmDepth(header, this.sessionFile);
				shouldRewrite = true;
			}
			if (shouldRewrite) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --resume selector
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		let sessionId = options?.id ?? createSessionId();
		let sessionFile: string | undefined;
		const hasExplicitRlmDepth = options !== undefined && Object.hasOwn(options, "rlmDepth");
		let parentHeader: Partial<SessionHeader> | undefined;
		if (options?.parentSession && !hasExplicitRlmDepth) {
			try {
				parentHeader = readSessionHeader(options.parentSession);
			} catch {
				// Unavailable parent metadata leaves the child depth unknown.
			}
		}
		if (this.persist) {
			if (options?.id) {
				sessionFile = getSessionFilePath(this.getSessionDir(), sessionId);
				if (existsSync(sessionFile)) {
					throw new Error(`Session file already exists for id "${sessionId}": ${sessionFile}`);
				}
			} else {
				const target = createUniqueSessionFileTarget(this.getSessionDir());
				sessionId = target.sessionId;
				sessionFile = target.sessionFile;
			}
		}

		this.sessionId = sessionId;
		const timestamp = new Date().toISOString();
		const git = this.persist ? (captureGitContext(this.cwd) ?? undefined) : undefined;
		const rlmDepth = hasExplicitRlmDepth
			? options?.rlmDepth
			: options?.parentSession
				? deriveChildRlmDepth(parentHeader)
				: rootRlmDepthFromEnv();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
			rlmDepth,
			git,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;
		this.fileEnsured = false;
		this.hasAssistantEntry = false;
		this.stubIds.clear();

		if (this.persist) {
			this.sessionFile = sessionFile;
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.hasAssistantEntry = false;
		this.stubIds.clear();
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "message" && entry.message.role === "assistant") {
				this.hasAssistantEntry = true;
			}
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		// Stubs only exist to shrink resident memory; the file must keep full
		// entries, so hydrate everything before serializing. If the file is gone
		// the offloaded history is unrecoverable — refuse to write gutted stubs
		// rather than silently corrupting the session.
		if (this.stubIds.size > 0) {
			this._hydrateOffloadedEntries(new Set(this.stubIds));
			if (this.stubIds.size > 0) {
				throw new Error(
					`Cannot rewrite session file: ${this.stubIds.size} offloaded entries could not be re-read from disk`,
				);
			}
		}
		const targetPath = realpathIfPresent(this.sessionFile);
		const directory = dirname(targetPath);
		mkdirSync(directory, { recursive: true });
		const tempPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
		let fd: number | undefined;
		try {
			const metadata = statMetadataIfPresent(targetPath);
			fd = openSync(tempPath, "w", metadata === undefined ? undefined : metadata.mode);
			// Stream entries out in bounded chunks; joining everything into one string
			// transiently costs ~2x the file size on large sessions.
			let pending: string[] = [];
			let pendingBytes = 0;
			const flushPending = () => {
				if (pending.length === 0 || fd === undefined) return;
				writeAllSync(fd, `${pending.join("\n")}\n`);
				pending = [];
				pendingBytes = 0;
			};
			for (const entry of this.fileEntries) {
				const line = JSON.stringify(entry);
				pending.push(line);
				pendingBytes += line.length;
				if (pendingBytes >= REWRITE_FLUSH_BYTES) {
					flushPending();
				}
			}
			flushPending();
			closeSync(fd);
			fd = undefined;
			if (metadata !== undefined) {
				chownSync(tempPath, metadata.uid, metadata.gid);
				chmodSync(tempPath, metadata.mode);
			}
			renameSync(tempPath, targetPath);
		} finally {
			if (fd !== undefined) closeSync(fd);
			rmSync(tempPath, { force: true });
		}
		this._notifyPersistListeners();
	}

	private _notifyPersistListeners(): void {
		if (!this.sessionFile) {
			return;
		}
		for (const listener of this.persistListeners) {
			try {
				listener(this.sessionFile);
			} catch {
				// Persistence observers must not break session writes.
			}
		}
	}

	onPersist(listener: SessionPersistListener): () => void {
		this.persistListeners.add(listener);
		return () => {
			this.persistListeners.delete(listener);
		};
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	materializeSessionFile(sessionDir?: string): string {
		if (this.sessionFile) {
			return this.sessionFile;
		}
		// Hydrate before this.sessionFile is repointed at the new target, so any
		// stubs still re-read from the original file.
		if (this.stubIds.size > 0) {
			this._hydrateOffloadedEntries(new Set(this.stubIds));
		}
		const dir = sessionDir ?? (this.sessionDir || getDefaultSessionDir(this.cwd));
		ensureDir(dir);
		const previousHeader = this.getHeader();
		const target = createUniqueSessionFileTarget(dir);
		this.sessionDir = dir;
		this.sessionId = target.sessionId;
		this.sessionFile = target.sessionFile;
		this.persist = true;
		const timestamp = new Date().toISOString();
		const git = captureGitContext(this.cwd) ?? undefined;
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: previousHeader?.parentSession,
			rlmDepth: resolveSessionRlmDepth(previousHeader ?? {}, target.sessionFile),
			git,
		};
		this.fileEntries = [header, ...this.getEntries()];
		this.hasAssistantEntry = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
		this._rewriteFile();
		this.flushed = true;
		this.fileEnsured = true;
		return this.sessionFile;
	}

	getSessionArtifactDir(): string | undefined {
		return this.persist ? getSessionArtifactPath(this.sessionDir, this.sessionId) : undefined;
	}

	/**
	 * Force-write all in-memory entries to the session file immediately.
	 * This bypasses the no-assistant guard in {@link _persist} so that
	 * pre-model entries (session header, goal state, settings changes)
	 * are durable on disk before the first assistant response.
	 * No-op for in-memory (non-persisted) sessions.
	 */
	flushNow(): void {
		if (!this.persist || !this.sessionFile) return;
		if (this.flushed && this.fileEnsured) return;
		this._rewriteFile();
		this.flushed = true;
		this.fileEnsured = true;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const shouldPersistWithoutAssistant = entry.type === "session_state" || entry.type === "session_info";
		if (!this.hasAssistantEntry && !shouldPersistWithoutAssistant) {
			this.flushed = false;
			return;
		}

		if (!this.flushed || !this.fileEnsured) {
			this._rewriteFile();
			this.flushed = true;
			this.fileEnsured = true;
		} else {
			try {
				this._appendToSessionFile(entry);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				// The file or its directory vanished underneath us; recover once by
				// rebuilding the file from in-memory entries, then fail if that fails.
				mkdirSync(dirname(this.sessionFile), { recursive: true });
				this._rewriteFile();
				this.flushed = true;
				this.fileEnsured = true;
			}
			this._notifyPersistListeners();
		}
	}

	/**
	 * Append one JSONL line to the session file. Opens with "r+" so a vanished
	 * file surfaces as ENOENT (append's default "a" flag would silently recreate
	 * a headerless file); avoids existsSync/mkdirSync on every append.
	 */
	private _appendToSessionFile(entry: SessionEntry): void {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		const line = `${JSON.stringify(entry)}\n`;
		const fd = openSync(sessionFile, "r+");
		try {
			writeSync(fd, line, fstatSync(fd).size);
		} finally {
			closeSync(fd);
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (entry.type === "message" && entry.message.role === "assistant") {
			this.hasAssistantEntry = true;
		}
		this._persist(entry);
	}

	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel: string, reason?: ThinkingLevelChangeReason): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
			...(reason ? { reason } : {}),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTier): string {
		const entry: ServiceTierChangeEntry = {
			type: "service_tier_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			serviceTier,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
			customInstructions,
		};
		this._appendEntry(entry);
		this._offloadPreCompactionEntries(entry.id);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendCustomEntryWithRollback(customType: string, data?: unknown): string {
		return this._appendEntryWithRollback(() => this.appendCustomEntry(customType, data));
	}

	appendChildUsageAttribution(
		targetId: string,
		childUsage: Usage,
		aggregateUsage: Usage,
		origin?: ChildUsageAttributionEntry["origin"],
		child?: { rlmChildId?: string; sessionName?: string },
	): string {
		const target = this.byId.get(targetId);
		if (target?.type !== "message" || target.message.role !== "assistant") {
			throw new Error(`Assistant message entry ${targetId} not found`);
		}

		target.message.usage = cloneUsage(aggregateUsage);
		const entry: ChildUsageAttributionEntry = {
			type: "child_usage_attributed",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			childUsage: cloneUsage(childUsage),
			aggregateUsage: cloneUsage(aggregateUsage),
			...(origin ? { origin } : {}),
			...(child?.rlmChildId ? { rlmChildId: child.rlmChildId } : {}),
			...(child?.sessionName ? { childSessionName: child.sessionName } : {}),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendSessionState(state: SessionState): string {
		const entry: SessionStateEntry = {
			type: "session_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			state: { status: state.status },
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getSessionName(): string | undefined {
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	getSessionState(): SessionState | undefined {
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_state") {
				const status = normalizeSessionStateStatus(entry.state.status);
				if (status) {
					return { status };
				}
			}
		}
		return undefined;
	}

	/**
	 * True when the session holds user-meaningful persisted content, as opposed to
	 * only daemon-written bookkeeping (session_state, agent_status, git_state) or
	 * the default model/thinking entries every new session is created with. Used by
	 * the daemon discard guard to decide whether a message-less draft is safe to
	 * delete (that guard always also requires zero messages).
	 *
	 * createAgentSession opens a new session with an optional leading `model_change`
	 * followed by `thinking_level_change` and `service_tier_change`. That creation
	 * prefix is skipped; anything beyond it is user content.
	 */
	hasUserContent(): boolean {
		const contentEntries = this.getEntries().filter((entry) => CONTENT_ENTRY_TYPES.has(entry.type));
		let start = 0;
		if (contentEntries[start]?.type === "model_change") {
			start++;
		}
		if (contentEntries[start]?.type === "thinking_level_change") {
			start++;
		}
		if (contentEntries[start]?.type === "service_tier_change") {
			start++;
		}
		return contentEntries.length > start;
	}

	appendAgentStatus(status: AgentStatus): string {
		const entry: AgentStatusEntry = {
			type: "agent_status",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			status: {
				summary: status.summary,
				taskState: status.taskState,
				basedOnMessageCount: status.basedOnMessageCount,
			},
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendGitState(git: GitContext): string {
		const entry: GitStateEntry = {
			type: "git_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			git,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	recordGitStateIfChanged(): string | undefined {
		if (!this.persist) return undefined;
		const git = captureGitContext(this.cwd);
		if (!git) return undefined;
		const last = this.getActiveGitContext();
		if (last && gitContextsEqual(last, git)) return undefined;
		return this.appendGitState(git);
	}

	private getActiveGitContext(): GitContext | undefined {
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "git_state") return current.git;
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		const header = this.fileEntries[0];
		return header?.type === "session" ? header.git : undefined;
	}

	getLatestAgentStatus(): AgentStatus | undefined {
		// Walk the current leaf to root so we only read status on the active branch,
		// not a sibling branch's status that happens to sit later in the file.
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "agent_status") {
				return { ...current.status };
			}
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return undefined;
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a custom message, undoing the append if persistence fails so a
	 * best-effort record never leaves an unsaved leaf for later entries.
	 */
	appendCustomMessageEntryWithRollback<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		return this._appendEntryWithRollback(() => this.appendCustomMessageEntry(customType, content, display, details));
	}

	private _appendEntryWithRollback(append: () => string): string {
		const previousLeafId = this.leafId;
		try {
			const entryId = append();
			this.flushNow();
			return entryId;
		} catch (error) {
			// The append indexes the entry before persisting it; undo exactly that.
			if (this.leafId !== null && this.leafId !== previousLeafId) {
				this.byId.delete(this.leafId);
				this.fileEntries.pop();
				this.leafId = previousLeafId;
				// The failed append may have left a torn line on disk. Restore the file
				// from the rolled-back entries now; if that also fails (e.g. the disk is
				// still full), fall back to forcing the next persist to rewrite.
				this.flushed = false;
				try {
					this.flushNow();
				} catch {
					this.flushed = false;
				}
			}
			throw error;
		}
	}
	/**
	 * Replace entries summarized away by the last compaction with lightweight
	 * stubs so multi-MB tool results and images stop costing resident memory.
	 * The session file on disk is untouched; stubs are hydrated back to full
	 * entries lazily from it (see {@link _hydrateOffloadedEntries}).
	 */
	private _offloadPreCompactionEntries(compactionId: string): void {
		if (!this.persist || !this.sessionFile) return;
		const compaction = this.byId.get(compactionId);
		if (compaction?.type !== "compaction") return;
		const cutoffIndex = this.fileEntries.findIndex(
			(e) => e.type !== "session" && e.id === compaction.firstKeptEntryId,
		);
		if (cutoffIndex < 0) return;
		for (let i = 1; i < cutoffIndex; i++) {
			const entry = this.fileEntries[i];
			if (entry.type === "session" || !OFFLOADABLE_ENTRY_TYPES.has(entry.type)) continue;
			if (this.stubIds.has(entry.id)) continue;
			this.fileEntries[i] = createOffloadedStub(entry);
			this.stubIds.add(entry.id);
		}
	}

	/** Hydrate every offloaded entry in one pass over the session file. */
	hydrateOffloadedEntries(): void {
		if (this.stubIds.size === 0) return;
		this._hydrateOffloadedEntries(new Set(this.stubIds));
	}

	private _hydrateEntry(entry: SessionEntry): SessionEntry {
		if (!this.stubIds.has(entry.id)) return entry;
		this._hydrateOffloadedEntries(new Set([entry.id]));
		const full = this.byId.get(entry.id);
		return full && !this.stubIds.has(full.id) ? full : entry;
	}

	private _hydratePathEntries(path: SessionEntry[]): SessionEntry[] {
		if (this.stubIds.size === 0) return path;
		const stubIds = path.filter((e) => this.stubIds.has(e.id)).map((e) => e.id);
		if (stubIds.length === 0) return path;
		this._hydrateOffloadedEntries(new Set(stubIds));
		return path.map((e) => (this.stubIds.has(e.id) ? e : (this.byId.get(e.id) ?? e)));
	}

	private _hydrateOffloadedEntries(ids: Set<string>): void {
		if (this.stubIds.size === 0 || !this.persist || !this.sessionFile) return;
		const pending = new Set([...ids].filter((id) => this.stubIds.has(id)));
		if (pending.size === 0) return;
		let buffer: Buffer;
		try {
			buffer = readFileSync(this.sessionFile);
		} catch {
			return;
		}
		let start = 0;
		while (start < buffer.length && pending.size > 0) {
			const end = buffer.indexOf(0x0a, start);
			const lineEnd = end === -1 ? buffer.length : end;
			if (lineEnd > start) {
				const line = buffer.toString("utf8", start, lineEnd);
				// Check every pending id against the line: an earlier corrupt match on
				// the same line must not strand later stubs. One line holds one entry,
				// so parse at most once per candidate line.
				const candidates: string[] = [];
				for (const id of pending) {
					if (line.includes(id)) candidates.push(id);
				}
				if (candidates.length > 0) {
					let parsed: FileEntry | undefined;
					try {
						parsed = JSON.parse(line) as FileEntry;
					} catch {
						// Malformed line: no id on it can be restored; stubs stay in place.
					}
					if (parsed && parsed.type !== "session") {
						for (const id of candidates) {
							if (parsed.id !== id) continue;
							const restored = parsed as SessionEntry;
							// Attributions appended after offload mutated the stub's usage;
							// re-apply them so the hydrated entry keeps the folded aggregate.
							if (restored.type === "message" && restored.message.role === "assistant") {
								for (const entry of this.byId.values()) {
									if (entry.type === "child_usage_attributed" && entry.targetId === id) {
										(restored as AssistantSessionMessageEntry).message.usage = cloneUsage(
											entry.aggregateUsage,
										);
									}
								}
							}
							const index = this.fileEntries.findIndex((e) => e.type !== "session" && e.id === id);
							if (index >= 0) this.fileEntries[index] = restored;
							this.byId.set(id, restored);
							this.stubIds.delete(id);
							pending.delete(id);
							break;
						}
					}
				}
			}
			start = lineEnd + 1;
		}
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.getEntry(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		const entry = this.byId.get(id);
		return entry ? this._hydrateEntry(entry) : undefined;
	}

	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return this._hydratePathEntries(children);
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		// push+reverse, not unshift-per-entry: unshift is O(n), which makes this O(n^2) on long sessions.
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return this._hydratePathEntries(path);
	}

	buildSessionContext(): SessionContext {
		// Offloaded stubs are safe here without hydration: stubs keep role, usage,
		// provider/model, and stopReason, which is all the walk below reads, and
		// message bodies are only collected from firstKeptEntryId onward - never
		// from the stubbed pre-compaction window. Hydrating here would undo the
		// offload on every call (and _performCompaction calls this immediately).
		// Pass fileEntries directly rather than getEntries(): the resolved context
		// is computed from the leaf-to-root walk over byId (which already excludes
		// the header), so the entries argument is only a fallback for an undefined
		// leaf — never hit here since leafId is always set or null. Avoids an O(n)
		// array copy on every call (attach, get_session_context, agent init, ...).
		return buildSessionContext(this.fileEntries as SessionEntry[], this.leafId, this.byId);
	}

	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	getFlatTree(): SessionTreeFlatNode[] {
		// Hydrate before mapping: tree UI and daemon session-tree consumers read
		// entry content (roles, previews, content search), which stubs lack.
		this.hydrateOffloadedEntries();
		return this.getEntries().map((entry) => ({
			entry,
			label: this.labelsById.get(entry.id),
			labelTimestamp: this.labelTimestampsById.get(entry.id),
		}));
	}

	getTree(): SessionTreeNode[] {
		const entries = this.getFlatTree();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const flatNode of entries) {
			nodeMap.set(flatNode.entry.id, { ...flatNode, children: [] });
		}

		for (const flatNode of entries) {
			const entry = flatNode.entry;
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	resetLeaf(): void {
		this.leafId = null;
	}

	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		const pathWithoutLabels = path.filter((e) => e.type !== "label");

		const target = this.persist
			? createUniqueSessionFileTarget(this.getSessionDir())
			: { sessionId: createSessionId(), sessionFile: undefined };
		const newSessionId = target.sessionId;
		const timestamp = new Date().toISOString();
		const newSessionFile = target.sessionFile;

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
			rlmDepth: resolveSessionRlmDepth(this.getHeader() ?? {}, previousSessionFile ?? newSessionFile ?? ""),
			git: this.persist ? (captureGitContext(this.cwd) ?? undefined) : undefined,
		};

		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// Only write the file now if it contains an assistant message.
			// Otherwise defer to _persist(), which creates the file on the
			// first assistant response, matching the newSession() contract
			// and avoiding the duplicate-header bug when _persist()'s
			// no-assistant guard later resets flushed to false.
			if (this.hasAssistantEntry) {
				this._rewriteFile();
				this.flushed = true;
				this.fileEnsured = true;
			} else {
				this.flushed = false;
				this.fileEnsured = false;
			}

			return newSessionFile;
		}

		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	static create(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true);
	}

	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		// Only the header's cwd is needed to construct the manager; the constructor
		// (setSessionFile) performs the full parse. Read just the first line here
		// instead of parsing the entire file a second time — that double parse is a
		// needless O(n) cost on open and is noticeable for long sessions.
		let cwd = cwdOverride;
		if (cwd === undefined) {
			let header: Partial<SessionHeader> | undefined;
			try {
				header = readSessionHeader(path);
			} catch {
				header = undefined;
			}
			// readSessionHeader only inspects the first physical line. If that isn't a
			// valid session header (e.g. a leading blank/whitespace or malformed line),
			// fall back to the full loader, which trims and skips such lines exactly
			// like setSessionFile does — so this.cwd stays consistent with the header
			// the session is actually loaded with. This slow path is rare.
			if (header?.type !== "session" || typeof header.id !== "string") {
				header = loadEntriesFromFile(path).find((e) => e.type === "session") as SessionHeader | undefined;
			}
			cwd = header?.cwd;
		}
		const dir = sessionDir ?? resolve(path, "..");
		return new SessionManager(cwd ?? process.cwd(), dir, path, true);
	}

	static async openAsync(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager> {
		if (!existsSync(path)) {
			return SessionManager.open(path, sessionDir, cwdOverride);
		}
		const entries = await loadEntriesFromFileAsync(path);
		if (entries.length === 0) {
			return SessionManager.open(path, sessionDir, cwdOverride);
		}
		const cwd = cwdOverride ?? (entries[0] as SessionHeader).cwd;
		const dir = sessionDir ?? resolve(path, "..");
		return new SessionManager(cwd ?? process.cwd(), dir, path, true, entries);
	}

	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		const mostRecent = findMostRecentSessionForCwd(dir, cwd);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	static inMemory(cwd: string = process.cwd(), sessionDir = ""): SessionManager {
		return new SessionManager(cwd, sessionDir, undefined, false);
	}

	static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
		const sourceEntries = loadEntriesFromFile(sourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${sourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${sourcePath}`);
		}
		migrateToCurrentVersion(sourceEntries);

		const dir = sessionDir ?? getDefaultSessionDir(targetCwd);
		ensureDir(dir);

		const target = createUniqueSessionFileTarget(dir);
		const newSessionId = target.sessionId;
		const timestamp = new Date().toISOString();
		const newSessionFile = target.sessionFile;

		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: targetCwd,
			parentSession: sourcePath,
			rlmDepth: resolveSessionRlmDepth(sourceHeader, sourcePath),
			git: captureGitContext(targetCwd) ?? undefined,
		};
		appendFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`);

		// Drop the source's git_state entries (re-linking children): they describe the source repo,
		// so the fork would otherwise report the source's git instead of its own target context.
		const droppedParent = new Map<string, string | null>();
		for (const entry of sourceEntries) {
			if (entry.type === "git_state") droppedParent.set(entry.id, entry.parentId);
		}
		const liveParent = (parentId: string | null): string | null => {
			let pid = parentId;
			while (pid !== null && droppedParent.has(pid)) pid = droppedParent.get(pid) ?? null;
			return pid;
		};
		for (const entry of sourceEntries) {
			if (entry.type === "session" || entry.type === "git_state") continue;
			const parentId = liveParent(entry.parentId);
			const out = parentId === entry.parentId ? entry : { ...entry, parentId };
			appendFileSync(newSessionFile, `${JSON.stringify(out)}\n`);
		}

		return new SessionManager(targetCwd, dir, newSessionFile, true);
	}

	static async list(cwd: string, sessionDir?: string, callbacks?: SessionListCallbacks): Promise<SessionInfo[]> {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		const matchesCwd = (session: SessionInfo) => sessionInfoMatchesCwd(session, cwd);
		const sessions = (
			await listSessionsFromDir(dir, {
				onProgress: callbacks?.onProgress,
				onSession: callbacks?.onSession
					? (session) => {
							if (matchesCwd(session)) {
								callbacks.onSession?.(session);
							}
						}
					: undefined,
			})
		).filter(matchesCwd);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	static async listAll(callbacks?: SessionListCallbacks, sessionDir?: string): Promise<SessionInfo[]> {
		const sessionsDir = sessionDir ?? getSessionsDir();
		const sessions = await listSessionsFromDir(sessionsDir, callbacks);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}
}
