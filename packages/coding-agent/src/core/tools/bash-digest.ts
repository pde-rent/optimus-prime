/**
 * Compact digests for known-noisy bash commands whose output got truncated.
 *
 * When a command like "npm install" or "git status" produces more output than
 * the truncation caps, only the tail is shown. For these commands the signal
 * (package counts, branch state) can sit in the head or middle of the output.
 * A one-line digest parsed from head and tail is prepended so the summary
 * survives truncation.
 */

import { formatSize } from "./truncate.js";

interface BashDigestInput {
	/** The executed command */
	command: string;
	/** First bytes of the full output */
	outputHead: string;
	/** Last lines of the full output (the part shown to the model) */
	outputTail: string;
	/** Total lines and bytes of the full output */
	totalLines: number;
	totalBytes: number;
	/** Exit code, when known (null on abort/timeout paths) */
	exitCode: number | null;
}

type DigestParser = (text: { head: string; tail: string }) => string | null;

function firstMatch(text: string, patterns: RegExp[]): RegExpExecArray | null {
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		if (match) return match;
	}
	return null;
}

function parsePackageInstall({ tail }: { head: string; tail: string }): string | null {
	const parts: string[] = [];
	const added = firstMatch(tail, [/added (\d+) packages?/, /(\d+) packages? installed/]);
	if (added) parts.push(`added ${added[1]}`);
	const removed = /removed (\d+) packages?/.exec(tail);
	if (removed) parts.push(`removed ${removed[1]}`);
	const changed = /changed (\d+) packages?/.exec(tail);
	if (changed) parts.push(`changed ${changed[1]}`);
	const audited = /audited (\d+) packages?/.exec(tail);
	if (audited) parts.push(`audited ${audited[1]}`);
	return parts.length > 0 ? parts.join(" ") : null;
}

function parseGitStatus({ head, tail }: { head: string; tail: string }): string | null {
	// Long-format git status repeats its summary per section; the head holds
	// branch state, per-file entries fill the middle. Parse both ends.
	const text = head.length >= tail.length ? `${head}\n${tail}` : `${tail}\n${head}`;
	const parts: string[] = [];

	const detached = /^HEAD detached at (.+)$/m.exec(text);
	const branch = /^On branch (.+)$/m.exec(text);
	if (detached) parts.push(`detached at ${detached[1]}`);
	else if (branch) parts.push(`branch=${branch[1]}`);

	const aheadBehind = /Your branch is ((?:ahead|behind)[^.\n]*)/.exec(text);
	if (aheadBehind) parts.push(aheadBehind[1].replace(/\s+/g, " ").trim());

	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let section: "staged" | "unstaged" | "untracked" | null = null;
	for (const line of text.split("\n")) {
		if (/^Changes to be committed:/.test(line)) section = "staged";
		else if (/^Changes not staged for commit:/.test(line)) section = "unstaged";
		else if (/^Untracked files:/.test(line)) section = "untracked";
		else if (/^[^\s\t(]/.test(line)) section = null;

		if (!section) continue;
		if (section === "untracked") {
			if (/^\t[^\s]/.test(line)) untracked++;
		} else if (/^\t(modified|new file|deleted|renamed|copied|typechange):/.test(line)) {
			if (section === "staged") staged++;
			else unstaged++;
		}
	}
	if (staged) parts.push(`staged=${staged}`);
	if (unstaged) parts.push(`unstaged=${unstaged}`);
	if (untracked) parts.push(`untracked=${untracked}`);

	return parts.length > 0 ? parts.join(" ") : null;
}

function parseKubectlDescribe({ tail }: { head: string; tail: string }): string | null {
	const parts: string[] = [];
	const name = /^Name:\s*(.+)$/m.exec(tail);
	if (name) parts.push(`name=${name[1].trim()}`);
	const ns = /^Namespace:\s*(.+)$/m.exec(tail);
	if (ns) parts.push(`ns=${ns[1].trim()}`);
	const reason = /^Reason:\s*(.+)$/m.exec(tail);
	if (reason) parts.push(`reason=${reason[1].trim()}`);
	const eventsIndex = tail.indexOf("Events:");
	if (eventsIndex !== -1) {
		const eventRows = tail
			.slice(eventsIndex)
			.split("\n")
			.filter((line) => /^\s+\d|^\s+(?:Normal|Warning)/.test(line)).length;
		parts.push(`events=${eventRows}`);
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

const DIGEST_PARSERS: Array<[RegExp, DigestParser]> = [
	[/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/, parsePackageInstall],
	[/\bgit\s+status\b/, parseGitStatus],
	[/\bkubectl\s+describe\b/, parseKubectlDescribe],
];

/**
 * Build a one-line digest for a truncated output of a known-noisy command.
 * Returns null when the command is not recognized as noisy.
 */
export function buildBashDigest(input: BashDigestInput): string | null {
	const parserEntry = DIGEST_PARSERS.find(([pattern]) => pattern.test(input.command));
	if (!parserEntry) return null;

	const summary = parserEntry[1]({ head: input.outputHead, tail: input.outputTail });
	const bits: string[] = [input.exitCode !== null ? `exit=${input.exitCode}` : "exit=?"];
	bits.push(`${input.totalLines} lines/${formatSize(input.totalBytes)} total (showing tail)`);
	if (summary) bits.push(summary);
	return `[digest] ${bits.join(" | ")}`;
}
