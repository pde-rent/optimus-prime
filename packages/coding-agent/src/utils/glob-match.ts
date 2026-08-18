/**
 * Glob matching with the semantics the codebase relied on from minimatch.
 *
 * `Bun.Glob` differs from minimatch in two ways that matter here: a `*` matches a leading dot,
 * so `*` would match `.git`, and a trailing slash still matches a pattern expecting a child.
 * Both would silently widen path filters, so they are corrected rather than accepted.
 */

/** True when the pattern deliberately addresses a dot-segment (`.git/**`, `**\/.config`). */
const addressesDotSegment = (pattern: string): boolean => /(^|\/)\.[^/]/.test(pattern);

export function matchGlob(value: string, pattern: string, options?: { nocase?: boolean }): boolean {
	let subject = value;
	let glob = pattern;
	if (options?.nocase) {
		subject = subject.toLowerCase();
		glob = glob.toLowerCase();
	}
	// minimatch treats `dir/` as a directory reference that `dir/*` does not match.
	if (subject.endsWith("/")) subject = subject.slice(0, -1);
	// Without an explicit dot in the pattern, hidden segments are excluded.
	if (!addressesDotSegment(glob) && subject.split("/").some((seg) => seg.startsWith("."))) {
		return false;
	}
	return new Bun.Glob(glob).match(subject);
}
