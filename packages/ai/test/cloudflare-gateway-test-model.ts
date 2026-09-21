import type { Model } from "../src/types.js";

/**
 * Cloudflare AI Gateway /compat-routed test model.
 *
 * The static catalog no longer ships a /compat-routed Workers AI entry, but
 * several tests exercise the gateway compat path (conservative fields,
 * cf-aig-authorization, session affinity). This helper builds the equivalent
 * model inline so those tests don't depend on catalog churn.
 */
export function getGatewayCompatTestModel(): Model<"openai-completions"> {
	return {
		id: "workers-ai/@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		provider: "cloudflare-ai-gateway",
		baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 256000,
	};
}
