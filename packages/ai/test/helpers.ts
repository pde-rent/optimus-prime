import { describe, it } from "bun:test";
import type { Api, Model, StreamOptions } from "../src/types.js";

export type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

export type ProviderTestCase = {
	name: string;
	fn: (model: Model<Api>, options?: StreamOptionsWithExtras) => Promise<void>;
	options?: StreamOptionsWithExtras;
	retry?: number;
	timeout?: number;
	skip?: boolean;
	skipIf?: boolean;
};

export type ProviderSpec = {
	name: string;
	skipIf: boolean;
	model: () => Model<Api>;
	cases: ProviderTestCase[];
};

/**
 * Registers one describe block per provider, skipped when spec.skipIf is true,
 * with each case running fn(model, case.options). Mirrors the hand-written
 * describe.skipIf(...) + it(...) matrix previously duplicated per provider.
 */
export function describeProviders(providers: ProviderSpec[]): void {
	for (const provider of providers) {
		describe.skipIf(provider.skipIf)(provider.name, () => {
			const model = provider.model();
			for (const testCase of provider.cases) {
				const run = async () => {
					await testCase.fn(model, testCase.options);
				};
				const testOptions = { retry: testCase.retry ?? 3, timeout: testCase.timeout };
				if (testCase.skip) it.skip(testCase.name, testOptions, run);
				else if (testCase.skipIf) it.skipIf(testCase.skipIf)(testCase.name, testOptions, run);
				else it(testCase.name, testOptions, run);
			}
		});
	}
}
