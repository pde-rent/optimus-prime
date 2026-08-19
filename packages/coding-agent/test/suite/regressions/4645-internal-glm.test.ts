import { afterEach, describe, vi } from "bun:test";
import type { Harness } from "../harness.js";

describe("ENG-4645 internal GLM configuration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});
});
