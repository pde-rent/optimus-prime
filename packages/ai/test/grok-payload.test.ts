import { describe, expect, it } from "bun:test";
import { sanitizeGrokPayload } from "../src/providers/grok-payload.js";

describe("sanitizeGrokPayload", () => {
	it("strips fields the SuperGrok proxy rejects", () => {
		const payload = {
			model: "grok-4.6",
			input: [],
			stream: true,
			seed: 1,
			parallel_tool_calls: true,
			service_tier: "auto",
			response_format: { type: "text" },
			prompt_cache_retention: "24h",
			store: false,
		};

		expect(sanitizeGrokPayload(payload, "grok-4.6")).toEqual({
			model: "grok-4.6",
			input: [],
			stream: true,
			store: false,
		});
	});

	it("removes enum values containing slashes from tool schemas", () => {
		const payload = {
			model: "grok-4.6",
			input: [],
			tools: [
				{
					type: "function",
					name: "pick",
					parameters: {
						type: "object",
						properties: {
							target: {
								type: "string",
								enum: ["alpha/beta", "gamma", "delta/eps"],
							},
						},
					},
				},
			],
		};

		const sanitized = sanitizeGrokPayload(payload, "grok-4.6");
		const tool = (sanitized as { tools: { parameters: { properties: { target: { enum?: string[] } } } }[] }).tools[0];
		expect(tool.parameters.properties.target.enum).toEqual(["gamma"]);
	});

	it("drops an enum entirely when every value contains a slash", () => {
		const payload = {
			model: "grok-4.5",
			input: [],
			tools: [
				{
					type: "function",
					name: "pick",
					parameters: { type: "object", properties: { target: { type: "string", enum: ["a/b"] } } },
				},
			],
		};

		const sanitized = sanitizeGrokPayload(payload, "grok-4.5");
		const tool = (sanitized as { tools: { parameters: { properties: { target: { enum?: string[] } } } }[] }).tools[0];
		expect(tool.parameters.properties.target.enum).toBeUndefined();
	});

	it("strips replayed reasoning items from input", () => {
		const payload = {
			model: "grok-4.6",
			input: [
				{ type: "message", role: "user", content: "hi" },
				{ type: "reasoning", summary: [] },
				{ type: "reasoning", encrypted_content: "abc" },
			],
		};

		expect(sanitizeGrokPayload(payload, "grok-4.6").input).toEqual([
			{ type: "message", role: "user", content: "hi" },
		]);
	});

	it("drops reasoning.summary for all models", () => {
		const payload = { model: "grok-4.6", input: [], reasoning: { effort: "high", summary: "auto" } };
		expect(sanitizeGrokPayload(payload, "grok-4.6").reasoning).toEqual({ effort: "high" });
	});

	it("keeps reasoning effort only for supported models", () => {
		for (const id of ["grok-3-mini", "grok-4.20-multi-agent-0309", "grok-4.3", "grok-4.5", "grok-4.6"]) {
			const payload = { model: id, input: [], reasoning: { effort: "low" } };
			expect(sanitizeGrokPayload(payload, id).reasoning).toEqual({ effort: "low" });
		}

		const unsupported = sanitizeGrokPayload(
			{ model: "grok-build", input: [], reasoning: { effort: "low" } },
			"grok-build",
		);
		expect(unsupported.reasoning).toBeUndefined();
	});
});
