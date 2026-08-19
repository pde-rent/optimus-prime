#!/usr/bin/env bun
/**
 * What changed upstream since we last looked.
 *
 *   bun scripts/upstream-report.ts            # commits not yet triaged
 *   bun scripts/upstream-report.ts --since 2026-08-01
 *   bun scripts/upstream-report.ts --mark     # record today's heads as triaged
 *
 * Two upstreams, and they behave differently:
 *
 * - `optimus` shares history with us, so its changes arrive via `git merge`.
 * - `pi` does NOT. optimus *vendors* pi's source — `packages/coding-agent` is a copy of
 *   `@earendil-works/pi-coding-agent`. Nothing propagates on its own; every pi fix that matters
 *   has to be reimplemented by hand against our tree.
 *
 * The ledger below records the last triaged head per upstream, so this only ever shows work
 * nobody has looked at yet.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const ledgerPath = join(repoRoot, "docs", "upstream-sync-ledger.json");

interface Ledger {
	/** remote -> last commit sha that has been triaged */
	triaged: Record<string, string>;
	updatedAt?: string;
}

const UPSTREAMS = [
	{ remote: "optimus", branch: "main", mergeable: true },
	{ remote: "pi", branch: "main", mergeable: false },
] as const;

function arg(name: string): string | undefined {
	const i = Bun.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : Bun.argv[i + 1];
}
const mark = Bun.argv.includes("--mark");
const since = arg("since");

function sh(cmd: string[]): string {
	const proc = Bun.spawnSync(cmd, { cwd: repoRoot });
	return new TextDecoder().decode(proc.stdout).trim();
}

const ledger: Ledger = existsSync(ledgerPath)
	? (JSON.parse(readFileSync(ledgerPath, "utf-8")) as Ledger)
	: { triaged: {} };

// Interest filter. Everything is listed, but these are surfaced first: a fix in an area we
// have rewritten is the most likely to matter and the least likely to apply cleanly.
const HOT = /compact|context|token|cache|session|daemon|snapshot|restore|repl|kernel|ipython|prompt|security|leak|credential|auth/i;

for (const { remote, branch, mergeable } of UPSTREAMS) {
	sh(["git", "fetch", "--quiet", remote]);
	const head = sh(["git", "rev-parse", `${remote}/${branch}`]);
	const from = ledger.triaged[remote];

	const range = since ? [`--since=${since}`, `${remote}/${branch}`] : from ? [`${from}..${remote}/${branch}`] : [`-30`, `${remote}/${branch}`];
	const log = sh(["git", "log", "--no-merges", "--pretty=format:%h\t%ad\t%s", "--date=short", ...range]);
	const commits = log ? log.split("\n") : [];

	console.log(`\n## ${remote}  (${mergeable ? "shares history — mergeable" : "vendored — hand-port only"})`);
	console.log(from ? `   last triaged: ${from.slice(0, 9)}` : "   never triaged — showing last 30");
	if (commits.length === 0) {
		console.log("   nothing new");
		continue;
	}

	const hot = commits.filter((c) => HOT.test(c));
	const rest = commits.filter((c) => !HOT.test(c));
	console.log(`   ${commits.length} new commit(s), ${hot.length} in areas we have rewritten\n`);
	for (const c of hot) console.log(`   ★ ${c}`);
	if (rest.length > 0) {
		console.log("");
		for (const c of rest) console.log(`     ${c}`);
	}

	if (mark) ledger.triaged[remote] = head;
}

if (mark) {
	ledger.updatedAt = new Date().toISOString().slice(0, 10);
	writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
	console.log(`\nmarked triaged up to current heads → ${ledgerPath}`);
} else {
	console.log("\nRun with --mark once these have been triaged, so the next report starts here.");
}
