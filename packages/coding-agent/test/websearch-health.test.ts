import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebsearchHealthExtension } from "../src/core/extensions/builtin/websearch-health.js";

interface NotifyCall {
	message: string;
	type: string | undefined;
}

function runSessionStart(): Promise<NotifyCall[]> {
	const calls: NotifyCall[] = [];
	let handler: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
	const pi = {
		on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			if (event === "session_start") handler = fn;
		},
	};
	const factory = createWebsearchHealthExtension();
	factory(pi as never);
	const ctx = {
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				calls.push({ message, type });
			},
		},
	};
	return Promise.resolve(handler?.({}, ctx)).then(() => calls);
}

describe("websearch-health extension", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-websearch-health-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv("OPTIMUS_CODING_AGENT_DIR", tempDir);
		vi.stubEnv("SERPER_API_KEY", undefined);
		vi.stubEnv("SEARXNG_URL", undefined);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("serper key in env means no warning", async () => {
		vi.stubEnv("SERPER_API_KEY", "test-key");
		expect(await runSessionStart()).toEqual([]);
	});

	test("serper key in auth.json means no warning", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ serper: { type: "api_key", key: "stored-key" } }));
		expect(await runSessionStart()).toEqual([]);
	});

	test("nothing configured warns with setup links", async () => {
		const calls = await runSessionStart();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.type).toBe("warning");
		expect(calls[0]?.message).toContain("https://serper.dev");
		expect(calls[0]?.message).toContain("docs.searxng.org");
	});

	test("healthy SearXNG means no warning", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } }),
		});
		try {
			vi.stubEnv("SEARXNG_URL", `http://localhost:${server.port}`);
			expect(await runSessionStart()).toEqual([]);
		} finally {
			server.stop(true);
		}
	});

	test("unreachable SearXNG warns with the URL", async () => {
		vi.stubEnv("SEARXNG_URL", "http://localhost:1");
		const calls = await runSessionStart();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.type).toBe("warning");
		expect(calls[0]?.message).toContain("http://localhost:1");
		expect(calls[0]?.message).toContain("unreachable");
	});

	test("PI_OFFLINE skips the reachability probe", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("SEARXNG_URL", "http://localhost:1");
		expect(await runSessionStart()).toEqual([]);
	});
});
