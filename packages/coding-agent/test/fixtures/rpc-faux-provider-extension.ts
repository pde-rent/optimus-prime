import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * Faux provider for the RPC-mode process tests.
 *
 * The RPC client spawns a real CLI subprocess, so its provider cannot be
 * scripted in-process. The test passes the script through the environment and
 * this extension replays it inside the child.
 */
export const FAUX_SCRIPT_ENV = "PI_TEST_RPC_FAUX_SCRIPT";

/**
 * One scripted assistant turn: either a literal reply, or a reply built from
 * the first regex match found in the context that was actually sent to the
 * provider (so tests can assert what reached the model, not just what came
 * back).
 */
export type RpcFauxScriptStep = string | { echoContextMatch: string };

function contextText(context: Context): string {
	const parts: string[] = [];
	for (const message of context.messages) {
		const content = message.content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		for (const block of content) {
			if (block.type === "text") parts.push(block.text);
			else if (block.type === "thinking") parts.push(block.thinking);
			else if (block.type === "toolCall") parts.push(JSON.stringify(block.arguments));
		}
	}
	return parts.join("\n");
}

function toResponse(step: RpcFauxScriptStep): AssistantMessage | ((context: Context) => AssistantMessage) {
	if (typeof step === "string") {
		return fauxAssistantMessage(step);
	}
	const pattern = new RegExp(step.echoContextMatch);
	return (context: Context) => fauxAssistantMessage(pattern.exec(contextText(context))?.[0] ?? "NO_CONTEXT_MATCH");
}

export default function registerRpcFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux", reasoning: true }] });
	const script = JSON.parse(process.env[FAUX_SCRIPT_ENV] ?? "[]") as RpcFauxScriptStep[];
	faux.setResponses(script.map(toResponse));

	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}

	const model = faux.getModel();
	pi.registerProvider(model.provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: model.baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((registered) => ({
			api: registered.api,
			baseUrl: registered.baseUrl,
			contextWindow: registered.contextWindow,
			cost: registered.cost,
			id: registered.id,
			input: registered.input,
			maxTokens: registered.maxTokens,
			name: registered.name,
			reasoning: registered.reasoning,
		})),
	});
}
