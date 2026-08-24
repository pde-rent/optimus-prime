import { describe, expect, type Mock, test, vi } from "bun:test";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type AnthropicWarnings = { anthropicExtraUsage?: boolean };

function createSettingsManager(warnings: AnthropicWarnings = {}) {
	return {
		getWarnings: vi.fn<() => AnthropicWarnings>().mockReturnValue(warnings),
	};
}

interface FakeInteractiveMode {
	anthropicSubscriptionWarningShown: boolean;
	settingsManager: ReturnType<typeof createSettingsManager>;
	modelRegistry: {
		authStorage: { get: Mock<() => unknown> };
		getApiKeyForProvider: Mock<() => Promise<string | undefined>>;
	};
	showWarning: Mock<(message: string) => void>;
}

// The method is private, so the fake invokes it through Function.prototype.call.
function maybeWarnAboutAnthropicSubscriptionAuth(fakeThis: FakeInteractiveMode, model: unknown): Promise<void> {
	const method = Reflect.get(InteractiveMode.prototype, "maybeWarnAboutAnthropicSubscriptionAuth") as (
		this: FakeInteractiveMode,
		model?: unknown,
	) => Promise<void>;
	return method.call(fakeThis, model);
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("warns once when Anthropic subscription auth is detected", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			modelRegistry: {
				authStorage: { get: vi.fn<() => undefined>().mockReturnValue(undefined) },
				getApiKeyForProvider: vi.fn<() => Promise<string | undefined>>().mockResolvedValue("sk-ant-oat01-test"),
			},
			showWarning: vi.fn<(message: string) => void>(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(fakeThis, { provider: "anthropic" });
		await maybeWarnAboutAnthropicSubscriptionAuth(fakeThis, { provider: "anthropic" });

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.modelRegistry.getApiKeyForProvider).toHaveBeenCalledTimes(1);
	});

	test("warns when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			modelRegistry: {
				authStorage: { get: vi.fn<() => { type: string }>().mockReturnValue({ type: "oauth" }) },
				getApiKeyForProvider: vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined),
			},
			showWarning: vi.fn<(message: string) => void>(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(fakeThis, { provider: "anthropic" });

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn for non-Anthropic models", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			modelRegistry: {
				authStorage: { get: vi.fn<() => unknown>() },
				getApiKeyForProvider: vi.fn<() => Promise<string | undefined>>(),
			},
			showWarning: vi.fn<(message: string) => void>(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(fakeThis, { provider: "openai" });

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			modelRegistry: {
				authStorage: { get: vi.fn<() => unknown>() },
				getApiKeyForProvider: vi.fn<() => Promise<string | undefined>>(),
			},
			showWarning: vi.fn<(message: string) => void>(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(fakeThis, { provider: "anthropic" });

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.modelRegistry.authStorage.get).not.toHaveBeenCalled();
		expect(fakeThis.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});
});
