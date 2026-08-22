/**
 * Request-body sanitization for the SuperGrok CLI proxy, which rejects
 * (HTTP 422) Responses-API fields it does not implement.
 */

const STRIPPED_FIELDS = [
	"seed",
	"parallel_tool_calls",
	"service_tier",
	"response_format",
	"prompt_cache_retention",
] as const;

const REASONING_EFFORT_MODELS = /^(grok-3-mini|grok-4\.20-multi-agent|grok-4\.3|grok-4\.5|grok-4\.6)/;

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Remove enum entries containing "/" everywhere in a JSON schema. */
function stripSlashEnums(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripSlashEnums);
	}
	if (!isRecord(value)) {
		return value;
	}

	const result: Payload = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "enum" && Array.isArray(item)) {
			const filtered = item.filter((entry) => typeof entry !== "string" || !entry.includes("/"));
			if (filtered.length > 0) {
				result[key] = filtered;
			}
			continue;
		}
		result[key] = stripSlashEnums(item);
	}
	return result;
}

function sanitizeTools(tools: unknown[]): unknown[] {
	return tools.map((tool) => {
		if (!isRecord(tool) || !isRecord(tool.parameters)) {
			return tool;
		}
		return { ...tool, parameters: stripSlashEnums(tool.parameters) };
	});
}

export function sanitizeGrokPayload<T extends Payload>(payload: T, modelId: string): T {
	const result: Payload = { ...payload };

	for (const field of STRIPPED_FIELDS) {
		delete result[field];
	}

	if (Array.isArray(result.tools)) {
		result.tools = sanitizeTools(result.tools);
	}

	if (Array.isArray(result.input)) {
		// The proxy rejects replayed reasoning items from prior turns.
		result.input = result.input.filter((item) => !(isRecord(item) && item.type === "reasoning"));
	}

	if (isRecord(result.reasoning)) {
		const reasoning: Payload = { ...result.reasoning };
		delete reasoning.summary;
		if (!REASONING_EFFORT_MODELS.test(modelId)) {
			delete reasoning.effort;
		}
		if (Object.keys(reasoning).length > 0) {
			result.reasoning = reasoning;
		} else {
			delete result.reasoning;
		}
	}

	return result as T;
}
