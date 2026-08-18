/**
 * Opt-in test tags.
 *
 * Replaces Vitest's `{ tags: [...] }` option and `--tagsFilter`, which `bun test`
 * has no equivalent for. Tagged suites are skipped unless their tag is listed in
 * the `PI_TEST_TAGS` environment variable (comma separated), so the default
 * `bun run test` stays as fast as the old `tagsFilter: ["!process-stress",
 * "!kernel-heavy"]` default. `test:process-stress` and `test:kernel` set it.
 */
const enabled = new Set(
	(process.env.PI_TEST_TAGS ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean),
);

export function hasTag(tag: string): boolean {
	return enabled.has(tag);
}
