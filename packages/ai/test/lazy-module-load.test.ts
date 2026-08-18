import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;

const SDK_SPECIFIERS = ["@anthropic-ai/sdk", "openai", "@google/genai", "@mistralai/mistralai"] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
};

/**
 * Runs `action` in a child Bun process that records every provider SDK module
 * actually pulled into the module graph. `Bun.plugin`'s `build.module` hook
 * fires on the exact bare specifier, so a stub is substituted (and recorded)
 * the first time anything imports it — statically or dynamically.
 */
function runProbe(action: string): ProbeResult {
	const script = `
		const loaded = [];

		Bun.plugin({
			name: "sdk-load-spy",
			setup(build) {
				for (const specifier of ${JSON.stringify(SDK_SPECIFIERS)}) {
					build.module(specifier, () => {
						loaded.push(specifier);
						return { exports: {}, loader: "object" };
					});
				}
			},
		});

		const mod = await import(${JSON.stringify(aiEntryUrl)});
		${action}
		console.log(JSON.stringify({ loadedSpecifiers: [...new Set(loaded)] }));
	`;

	const result = spawnSync("bun", ["-e", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(`Probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const stdoutLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastLine = stdoutLines.at(-1);
	if (!lastLine) {
		throw new Error(`Probe produced no output\nSTDERR:\n${result.stderr}`);
	}

	return JSON.parse(lastLine) as ProbeResult;
}

describe("lazy provider module loading", () => {
	it("detects a provider SDK import (spy self-check)", () => {
		const result = runProbe(`await import("openai");`);
		expect(result.loadedSpecifiers).toEqual(["openai"]);
	});

	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbe("");
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads no provider SDK when calling the root lazy wrapper", () => {
		const result = runProbe(`
			const model = {
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			};
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimpleAnthropic(model, context).result();
		`);

		// The Anthropic provider now talks to /v1/messages over fetch; the SDK is types-only.
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads no provider SDK when dispatching through streamSimple", () => {
		const result = runProbe(`
			const model = mod.getModel("anthropic", "claude-sonnet-4-6");
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimple(model, context).result();
		`);

		// The Anthropic provider now talks to /v1/messages over fetch; the SDK is types-only.
		expect(result.loadedSpecifiers).toEqual([]);
	});
});
