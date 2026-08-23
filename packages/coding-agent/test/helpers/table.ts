/**
 * Table-driven case runner. Folds literal-duplicate and constant-parameterized
 * tests into data tables while keeping one test() per row so failure output and
 * case names preserve diagnostics.
 */
import { describe, it } from "bun:test";

export interface CaseRow {
	/** Test name; keep it descriptive — it is the diagnostic on failure. */
	name: string;
	[key: string]: unknown;
}

type CaseBody<T> = (row: T) => void | Promise<void>;

/**
 * Generate a describe block with one test per row.
 * Example: cases("strips X", rows, (row) => expect(f(row.input)).toBe(row.want))
 * Rows may set skip: true to keep a documented-but-disabled case visible.
 */
export function cases<T extends CaseRow>(title: string, rows: T[], run: CaseBody<T>): void {
	describe(title, () => {
		for (const row of rows) {
			const body = () => run(row);
			if ((row as { skip?: boolean }).skip) {
				it.skip(row.name, body);
			} else {
				it(row.name, body);
			}
		}
	});
}
