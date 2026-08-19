/**
 * Run the project's own checker and report what it says.
 *
 * A resident language server answers per-file questions fast but cannot answer
 * "is the project sound", which is the question that matters after an edit -- it
 * will report a clean file while the build is broken elsewhere. The project's own
 * checker answers the sound question directly, and on a typical repository it
 * finishes fast enough that the distinction is not worth paying for: a full
 * typecheck of this repository takes about a third of a second.
 *
 * There is deliberately no "only show me new diagnostics" ledger. Several agents
 * can share one working tree, so a ledger that remembers what it already showed
 * turns another agent's error into a message this agent sees once and then never
 * again -- manufacturing exactly the clean-looking broken project the checker
 * exists to catch.
 */

/**
 * Checkers by the root markers that identify the project, in detection order.
 *
 * Markers are searched from the working directory upwards. A cwd-only check
 * misses every monorepo package that inherits its config from the repository
 * root, which is the common layout rather than the exception.
 */
const CHECKERS = [
	{
		name: "typescript",
		markers: ["tsconfig.build.json", "tsconfig.json"],
		bins: ["tsgo", "tsc"],
		args: (marker) => ["-p", marker, "--noEmit"],
	},
	{ name: "rust", markers: ["Cargo.toml"], bins: ["cargo"], args: () => ["check", "--message-format=short"] },
	{ name: "python", markers: ["pyproject.toml"], bins: ["ruff"], args: () => ["check"] },
	{ name: "go", markers: ["go.mod"], bins: ["go"], args: () => ["build", "./..."] },
	{ name: "solidity", markers: ["foundry.toml"], bins: ["forge"], args: () => ["build"] },
];

const MAX_OUTPUT_LINES = 200;

/**
 * A repository's pinned binary wins over whatever is on the PATH. In a workspace
 * the binaries live in the root `node_modules/.bin` rather than the package's, so
 * every ancestor is searched before falling back to the PATH.
 */
async function resolveBin(name, from) {
	let dir = from;
	for (;;) {
		const candidate = `${dir}/node_modules/.bin/${name}`;
		if (await Bun.file(candidate).exists()) return candidate;
		const parent = dir.slice(0, dir.lastIndexOf("/"));
		if (!parent || parent === dir) break;
		dir = parent;
	}
	return Bun.which(name) ?? undefined;
}

/** Keep the head and tail of a long report; the middle of a diagnostic dump is the least useful part. */
function boundOutput(text) {
	const lines = text.split("\n");
	if (lines.length <= MAX_OUTPUT_LINES) return { output: text, dropped: 0 };
	const head = lines.slice(0, MAX_OUTPUT_LINES - 40);
	const tail = lines.slice(-40);
	const dropped = lines.length - head.length - tail.length;
	return { output: [...head, `... ${dropped} lines omitted ...`, ...tail].join("\n"), dropped };
}

/** Nearest ancestor directory (starting at `from`) containing `marker`, or undefined. */
async function findUp(marker, from) {
	let dir = from;
	for (;;) {
		if (await Bun.file(`${dir}/${marker}`).exists()) return dir;
		const parent = dir.slice(0, dir.lastIndexOf("/"));
		if (!parent || parent === dir) return undefined;
		dir = parent;
	}
}

export default function createSkill({ cwd }) {
	/**
	 * Concurrent identical checks share one process. Two cells asking the same
	 * question should not run `cargo check` twice and contend on its target lock.
	 */
	const inFlight = new Map();

	async function detect() {
		const found = [];
		for (const checker of CHECKERS) {
			for (const marker of checker.markers) {
				const root = await findUp(marker, cwd);
				if (!root) continue;
				let bin;
				for (const name of checker.bins) {
					bin = await resolveBin(name, root);
					if (bin) break;
				}
				found.push({ name: checker.name, bins: checker.bins, marker, root, bin, args: checker.args(marker) });
				break; // first marker that exists wins; they are ordered most specific first
			}
		}
		return found;
	}

	async function runOne(checker) {
		if (!checker.bin) {
			return {
				checker: checker.name,
				ok: false,
				skipped: `no ${checker.bins.join(" or ")} on PATH or in node_modules/.bin`,
				output: "",
			};
		}
		const command = [checker.bin, ...checker.args];
		const key = `${checker.root}\u0000${command.join(" ")}`;
		const existing = inFlight.get(key);
		if (existing) return await existing;

		const started = Bun.nanoseconds();
		const promise = (async () => {
			// Run from the directory that owns the marker, not the agent's cwd.
			const proc = Bun.spawn(command, { cwd: checker.root, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const { output, dropped } = boundOutput(`${stdout}${stderr}`.trim());
			return {
				checker: checker.name,
				ok: exitCode === 0,
				command: command.join(" "),
				root: checker.root,
				exitCode,
				tookMs: Math.round((Bun.nanoseconds() - started) / 1e6),
				output,
				...(dropped > 0 ? { droppedLines: dropped } : {}),
			};
		})();
		inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			inFlight.delete(key);
		}
	}

	/**
	 * Run every checker this project declares, or one named checker.
	 *
	 * @param {string} [only] Checker name (`typescript`, `rust`, `python`, `go`, `solidity`).
	 * @returns {Promise<{ok: boolean, results: object[]}>} `ok` is false if any checker failed.
	 */
	async function run(only) {
		const detected = await detect();
		const selected = only ? detected.filter((checker) => checker.name === only) : detected;
		if (selected.length === 0) {
			return {
				ok: true,
				results: [],
				note: only
					? `no ${only} project found at or above ${cwd}`
					: `no recognised project markers at or above ${cwd} (looked for ${CHECKERS.flatMap((c) => c.markers).join(", ")})`,
			};
		}
		const results = await Promise.all(selected.map(runOne));
		return { ok: results.every((result) => result.ok || result.skipped), results };
	}

	return Object.assign(run, { run, detect });
}
