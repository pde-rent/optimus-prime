import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { FAUX_SCRIPT_ENV, type RpcFauxScriptStep } from "./fixtures/rpc-faux-provider-extension.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fauxExtensionPath = join(__dirname, "fixtures", "rpc-faux-provider-extension.ts");

interface StartOptions {
	script?: RpcFauxScriptStep[];
	settings?: Record<string, unknown>;
}

describe("RPC mode", () => {
	let client: RpcClient | undefined;
	let sessionDir: string | undefined;
	let daemonSocket: string | undefined;

	/**
	 * The RPC client drives a real CLI subprocess, so its provider is scripted
	 * through the child's environment instead of an in-process faux registration.
	 * Each client also gets a private daemon socket: RPC mode is daemon-backed,
	 * and the default socket is shared machine-wide.
	 */
	async function startClient({ script = [], settings }: StartOptions = {}): Promise<RpcClient> {
		const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		sessionDir = join(tmpdir(), `pi-rpc-${runId}`);
		daemonSocket = join(tmpdir(), `pi-rpc-${runId}.sock`);
		mkdirSync(sessionDir, { recursive: true });
		if (settings) {
			writeFileSync(join(sessionDir, "settings.json"), JSON.stringify(settings));
		}
		client = new RpcClient({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: {
				[ENV_AGENT_DIR]: sessionDir,
				[FAUX_SCRIPT_ENV]: JSON.stringify(script),
				PI_SKIP_VERSION_CHECK: "1",
			},
			provider: "faux",
			model: "faux",
			args: ["--daemon-socket", daemonSocket, "--extension", fauxExtensionPath],
		});
		await client.start();
		return client;
	}

	async function stopDaemon(socketPath: string): Promise<void> {
		const daemon = new DaemonClient(socketPath);
		try {
			await daemon.connect(1000);
			await daemon.request({ type: "shutdown" }, 5000);
		} catch {
			// The daemon may already be gone; nothing left to shut down.
		} finally {
			daemon.close();
		}
		// The shutdown reply precedes process exit; the exiting daemon and its
		// workers keep writing into the agent dir until the socket is unlinked,
		// which would recreate the directory the cleanup below removes.
		for (let attempt = 0; attempt < 100 && existsSync(socketPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	function readSessionEntries() {
		const sessionsPath = join(sessionDir!, "sessions");
		expect(existsSync(sessionsPath)).toBe(true);
		const sessionFiles = readdirSync(sessionsPath).filter((file) => file.endsWith(".jsonl"));
		expect(sessionFiles.length).toBe(1);
		return readFileSync(join(sessionsPath, sessionFiles[0]), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (daemonSocket) {
			await stopDaemon(daemonSocket);
			daemonSocket = undefined;
		}
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}
		sessionDir = undefined;
	});

	test("should get state", async () => {
		const client = await startClient();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe("faux");
		expect(state.model?.id).toBe("faux");
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	}, 30000);

	test("should save messages to session file", async () => {
		const client = await startClient({ script: ["hello"] });

		const events = await client.promptAndWait("Reply with just the word 'hello'");

		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2);

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		const entries = readSessionEntries();
		expect(entries[0].type).toBe("session");

		const messages = entries.filter((e: { type: string }) => e.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(2);

		const roles = messages.map((m: { message: { role: string } }) => m.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		// The default 20k keepRecentTokens window would leave nothing to
		// summarize in a two-turn session, so shrink the retained window.
		const client = await startClient({
			// Compaction summarizes each turn prefix before the final summary, so
			// queue the same summary for every summarization call it makes.
			script: ["Hi there.", "Hello again.", ...Array(6).fill("Summary: the user said hello.")],
			settings: { compaction: { keepRecentTokens: 1 } },
		});

		await client.promptAndWait("Say hello");
		await client.promptAndWait("Say hello again");

		const result = await client.compact();
		expect(result.summary).toContain("the user said hello");
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		const entries = readSessionEntries();
		const compactionEntries = entries.filter((e: { type: string }) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0].summary).toBeDefined();
	}, 120000);

	test("should execute bash command", async () => {
		const client = await startClient();

		const result = await client.bash("echo hello");
		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	}, 30000);

	test("should add bash output to context", async () => {
		const client = await startClient({ script: ["Hi."] });

		await client.promptAndWait("Say hi");

		const uniqueValue = `test-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		const entries = readSessionEntries();
		const bashMessages = entries.filter(
			(e: { type: string; message?: { role: string } }) =>
				e.type === "message" && e.message?.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0].message.output).toContain(uniqueValue);
	}, 90000);

	test("should include bash output in LLM context", async () => {
		// The faux provider replies with whatever `unique-<n>` token it finds in
		// the context it was handed, so the assertion below only passes when the
		// bash output really reached the model request.
		const client = await startClient({ script: [{ echoContextMatch: "unique-[0-9]+" }] });

		const uniqueValue = `unique-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		const events = await client.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);

		const messageEndEvents = events.filter((e) => e.type === "message_end") as AgentEvent[];
		const assistantMessage = messageEndEvents.find(
			(e) => e.type === "message_end" && e.message?.role === "assistant",
		) as any;

		expect(assistantMessage).toBeDefined();

		const textContent = assistantMessage.message.content.find((c: any) => c.type === "text");
		expect(textContent?.text).toContain(uniqueValue);
	}, 90000);

	test("should set and get thinking level", async () => {
		const client = await startClient();

		await client.setThinkingLevel("high");

		const state = await client.getState();
		expect(state.thinkingLevel).toBe("high");
	}, 30000);

	test("should cycle thinking level", async () => {
		const client = await startClient();

		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		const result = await client.cycleThinkingLevel();
		expect(result).toBeDefined();
		expect(result!.level).not.toBe(initialLevel);

		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result!.level);
	}, 30000);

	test("should get available models", async () => {
		const client = await startClient();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);
		expect(models.some((model) => model.provider === "faux" && model.id === "faux")).toBe(true);

		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		const client = await startClient({ script: ["Hi."] });

		await client.promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should create new session", async () => {
		const client = await startClient({ script: ["Hi."] });

		await client.promptAndWait("Hello");

		let state = await client.getState();
		expect(state.messageCount).toBeGreaterThan(0);

		await client.newSession();

		state = await client.getState();
		expect(state.messageCount).toBe(0);
	}, 90000);

	test("should export to HTML", async () => {
		const client = await startClient({ script: ["Hi."] });

		await client.promptAndWait("Hello");

		const result = await client.exportHtml();
		expect(result.path).toBeDefined();
		expect(result.path.endsWith(".html")).toBe(true);
		expect(existsSync(result.path)).toBe(true);
		rmSync(result.path, { force: true });
	}, 90000);

	test("should get last assistant text", async () => {
		const client = await startClient({ script: ["test123"] });

		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		await client.promptAndWait("Reply with just: test123");

		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);

	test("should set and get session name", async () => {
		const client = await startClient({ script: ["ok"] });

		let state = await client.getState();
		expect(state.sessionName).toBeUndefined();

		// Send a prompt first - session files are only written after first assistant message
		await client.promptAndWait("Reply with just 'ok'");

		await client.setSessionName("my-test-session");

		state = await client.getState();
		expect(state.sessionName).toBe("my-test-session");

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		const entries = readSessionEntries();
		const sessionInfoEntries = entries.filter((e: { type: string }) => e.type === "session_info");
		expect(sessionInfoEntries.length).toBe(1);
		expect(sessionInfoEntries[0].name).toBe("my-test-session");
	}, 60000);
});
