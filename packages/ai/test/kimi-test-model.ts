import { getModels } from "../src/models.js";
import type { Model } from "../src/types.js";

const KIMI_TEST_MODEL_PREFERENCE = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"];

export function getKimiCodingTestModel(options: { image?: boolean } = {}): Model<"openai-completions"> {
	const models = getModels("moonshotai") as Model<"openai-completions">[];
	const eligible = options.image ? models.filter((model) => model.input.includes("image")) : models;
	for (const id of KIMI_TEST_MODEL_PREFERENCE) {
		const model = eligible.find((candidate) => candidate.id === id);
		if (model) return model;
	}
	const model = eligible[0];
	if (!model) {
		throw new Error(`No ${options.image ? "image-capable " : ""}Kimi Coding model is available`);
	}
	return model;
}
