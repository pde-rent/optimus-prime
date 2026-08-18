import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import type { Context } from "../src/types.js";
import { mockOpenAIFetch, type OpenAIFetchMock } from "./openai-fetch-mock.js";

let fetchMock: OpenAIFetchMock;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAzureOpenAIBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureOpenAIResourceName = process.env.AZURE_OPENAI_RESOURCE_NAME;
const originalAzureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION;
const originalAzureOpenAIApiKey = process.env.AZURE_OPENAI_API_KEY;

beforeEach(() => {
	fetchMock = mockOpenAIFetch([]);
	delete process.env.AZURE_OPENAI_BASE_URL;
	delete process.env.AZURE_OPENAI_RESOURCE_NAME;
	delete process.env.AZURE_OPENAI_API_VERSION;
	delete process.env.AZURE_OPENAI_API_KEY;
});

afterEach(() => {
	fetchMock.restore();
	if (originalAzureOpenAIBaseUrl === undefined) {
		delete process.env.AZURE_OPENAI_BASE_URL;
	} else {
		process.env.AZURE_OPENAI_BASE_URL = originalAzureOpenAIBaseUrl;
	}

	if (originalAzureOpenAIResourceName === undefined) {
		delete process.env.AZURE_OPENAI_RESOURCE_NAME;
	} else {
		process.env.AZURE_OPENAI_RESOURCE_NAME = originalAzureOpenAIResourceName;
	}

	if (originalAzureOpenAIApiVersion === undefined) {
		delete process.env.AZURE_OPENAI_API_VERSION;
	} else {
		process.env.AZURE_OPENAI_API_VERSION = originalAzureOpenAIApiVersion;
	}

	if (originalAzureOpenAIApiKey === undefined) {
		delete process.env.AZURE_OPENAI_API_KEY;
	} else {
		process.env.AZURE_OPENAI_API_KEY = originalAzureOpenAIApiKey;
	}
});

/** The URL the provider actually requested: normalized base URL + `/responses` + `api-version`. */
async function captureRequestUrl(baseUrl: string): Promise<string> {
	process.env.AZURE_OPENAI_BASE_URL = baseUrl;
	const model = getModel("azure-openai-responses", "gpt-4o-mini");
	const result = await streamAzureOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
	expect(result.stopReason).not.toBe("error");
	expect(fetchMock.requests).toHaveLength(1);
	// `/responses` is not a deployments endpoint, so no `/deployments/<model>` segment.
	expect(fetchMock.lastRequest().url).not.toContain("/deployments/");
	expect(fetchMock.lastRequest().headers["api-key"]).toBe("test-api-key");
	return fetchMock.lastRequest().url;
}

describe("azure-openai-responses base URL normalization", () => {
	it("normalizes Cognitive Services root endpoints to /openai/v1", async () => {
		const url = await captureRequestUrl("https://marc-quicktests-resource.cognitiveservices.azure.com");
		expect(url).toBe(
			"https://marc-quicktests-resource.cognitiveservices.azure.com/openai/v1/responses?api-version=v1",
		);
	});

	it("normalizes Azure OpenAI root endpoints to /openai/v1", async () => {
		const url = await captureRequestUrl("https://my-resource.openai.azure.com");
		expect(url).toBe("https://my-resource.openai.azure.com/openai/v1/responses?api-version=v1");
	});

	it("normalizes /openai to /openai/v1", async () => {
		const url = await captureRequestUrl("https://my-resource.cognitiveservices.azure.com/openai");
		expect(url).toBe("https://my-resource.cognitiveservices.azure.com/openai/v1/responses?api-version=v1");
	});

	it("preserves /openai/v1 endpoints", async () => {
		const url = await captureRequestUrl("https://my-resource.cognitiveservices.azure.com/openai/v1");
		expect(url).toBe("https://my-resource.cognitiveservices.azure.com/openai/v1/responses?api-version=v1");
	});

	it("preserves explicit non-Azure proxy paths", async () => {
		const url = await captureRequestUrl("https://my-proxy.example.com/v1");
		expect(url).toBe("https://my-proxy.example.com/v1/responses?api-version=v1");
	});

	it("strips query params when normalizing Azure host URLs", async () => {
		const url = await captureRequestUrl("https://my-resource.openai.azure.com/openai?api-version=2024-12-01");
		expect(url).toBe("https://my-resource.openai.azure.com/openai/v1/responses?api-version=v1");
	});

	it("preserves query params on non-Azure proxy URLs", async () => {
		const url = await captureRequestUrl("https://my-proxy.example.com/v1?custom=true");
		// The SDK appended the path to a query-bearing base URL the same way.
		expect(url).toBe("https://my-proxy.example.com/v1?custom=true%2Fresponses&api-version=v1");
	});

	it("throws on invalid URLs", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "not-a-url";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const result = await streamAzureOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Azure OpenAI base URL");
	});

	it("builds correct default URL from AZURE_OPENAI_RESOURCE_NAME", async () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		await streamAzureOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
		expect(fetchMock.requests).toHaveLength(1);
		expect(fetchMock.lastRequest().url).toBe(
			"https://my-resource.openai.azure.com/openai/v1/responses?api-version=v1",
		);
	});
});
