/**
 * The CLI flags that are nothing but a one-shot override of a stored setting.
 *
 * One entry here drives the parse arm, the help row, the daemon value-flag list, and the copy into
 * the runtime config. Flags with bespoke semantics (`--resume`, `--print`, `--model`, path-resolving
 * and `--autonomous*` flags) stay hand-written in args.ts; they have nothing to share.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ServiceTier } from "@earendil-works/pi-ai";
import { GRAPH_RESOLVER_LEVELS, type GraphResolverLevel } from "../core/graph-resolver.js";
import type { RlmMaxDepthValue } from "../core/rlm-max-depth.js";
import type { DynamicEffortMode } from "../core/settings-manager.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const SERVICE_TIERS: readonly NonNullable<ServiceTier>[] = ["auto", "default", "flex", "scale", "priority"] as const;

const DYNAMIC_EFFORT_MODES: readonly DynamicEffortMode[] = ["off", "banded", "free"] as const;

/** The fields these flags write. Shared by `Args` and `AgentSessionRuntimeConfig`. */
export interface SettingsFlagValues {
	thinking?: ThinkingLevel;
	/** Graph budget for this run. Overrides the stored setting; unset falls through to it. */
	graphResolver?: GraphResolverLevel;
	/** Lowers the graph ceiling for this run. Cannot raise it past the level's own budget. */
	graphMaxTokens?: number;
	rlmMaxDepth?: RlmMaxDepthValue;
	dynamicDepth?: boolean;
	degeneracyGuard?: boolean;
	reasoningLoopGuard?: boolean;
	dynamicEffort?: DynamicEffortMode;
	serviceTier?: ServiceTier;
	compaction?: boolean;
	retry?: boolean;
}

type SettingsFlagSpec<K extends keyof SettingsFlagValues> = {
	flag: string;
	aliases?: readonly string[];
	/** Help summary. Enum flags get their valid values appended. */
	help: string;
	field: K;
} & (
	| {
			kind: "enum";
			placeholder: string;
			values: readonly NonNullable<SettingsFlagValues[K]>[];
			/** Noun in the warning: `Invalid <label> "x". Valid values: ...` */
			label: string;
			/** Warning noun when the flag was spelled as its alias. */
			aliasLabel?: string;
	  }
	| {
			kind: "number";
			placeholder: string;
			accepts: (value: number) => boolean;
			expected: string;
			/** Literal words the flag also accepts, e.g. "unlimited". */
			words?: readonly NonNullable<SettingsFlagValues[K]>[];
	  }
	| { kind: "bool" }
);

// Identity, but it infers K per entry so a spec cannot list values of the wrong field's type.
const spec = <K extends keyof SettingsFlagValues>(value: SettingsFlagSpec<K>): SettingsFlagSpec<K> => value;

export const SETTINGS_FLAGS = [
	// `/effort` is what the setting is called in the session, `--thinking` is what the flag has
	// always been called. Accept both rather than making the same setting answer to one name
	// interactively and another from the command line.
	spec({
		kind: "enum",
		flag: "--thinking",
		aliases: ["--effort"],
		field: "thinking",
		placeholder: "<level>",
		values: THINKING_LEVELS,
		label: "thinking level",
		aliasLabel: "effort level",
		help: "Set reasoning",
	}),
	spec({
		kind: "enum",
		flag: "--graph",
		field: "graphResolver",
		placeholder: "<level>",
		values: GRAPH_RESOLVER_LEVELS,
		label: "graph level",
		help: "Multi-agent graph budget",
	}),
	spec({
		kind: "number",
		flag: "--graph-max-tokens",
		field: "graphMaxTokens",
		placeholder: "<n>",
		accepts: (value) => Number.isFinite(value) && value > 0,
		expected: "a positive number",
		help: "Lower the graph token ceiling for this run",
	}),
	spec({
		kind: "number",
		flag: "--rlm-max-depth",
		field: "rlmMaxDepth",
		placeholder: "<n>",
		accepts: (value) => Number.isInteger(value) && value >= 0,
		expected: 'a non-negative integer or "unlimited"',
		words: ["unlimited"],
		help: "Maximum sub-agent recursion depth",
	}),
	spec({
		kind: "bool",
		flag: "--dynamic-depth",
		field: "dynamicDepth",
		help: "Let the agent raise its own recursion depth",
	}),
	spec({
		kind: "bool",
		flag: "--degeneracy-guard",
		field: "degeneracyGuard",
		help: "Abort a turn whose output collapses into a repetition loop",
	}),
	spec({
		kind: "bool",
		flag: "--reasoning-loop-guard",
		field: "reasoningLoopGuard",
		help: "Steer or stop a run whose assistant keeps planning without acting",
	}),
	spec({
		kind: "enum",
		flag: "--dynamic-effort",
		field: "dynamicEffort",
		placeholder: "<mode>",
		values: DYNAMIC_EFFORT_MODES,
		label: "dynamic effort mode",
		help: "Adaptive reasoning",
	}),
	spec({
		kind: "enum",
		flag: "--service-tier",
		field: "serviceTier",
		placeholder: "<tier>",
		values: SERVICE_TIERS,
		label: "service tier",
		help: "Request routing",
	}),
	spec({ kind: "bool", flag: "--compact", field: "compaction", help: "Automatic context compaction" }),
	spec({ kind: "bool", flag: "--retry", field: "retry", help: "Automatic retry on transient API failures" }),
] as const;

type AnySettingsFlagSpec = (typeof SETTINGS_FLAGS)[number];

// TypeScript will not write through a union-typed key, so the per-entry write goes through one
// function whose key parameter is a single type variable.
function write<K extends keyof SettingsFlagValues>(
	target: SettingsFlagValues,
	field: K,
	value: SettingsFlagValues[K],
): void {
	target[field] = value;
}

function negatedFlag(entry: AnySettingsFlagSpec): string {
	return `--no-${entry.flag.slice(2)}`;
}

/** `["--thinking, --effort <level>", "Set reasoning: off, minimal, ..."]` rows for `--help`. */
export const SETTINGS_FLAG_HELP_ROWS: ReadonlyArray<readonly [option: string, summary: string]> = SETTINGS_FLAGS.map(
	(entry) => {
		if (entry.kind === "bool") {
			return [`${entry.flag}, ${negatedFlag(entry)}`, entry.help] as const;
		}
		const names = [entry.flag, ...(entry.aliases ?? [])].join(", ");
		let summary = entry.kind === "enum" ? `${entry.help}: ${entry.values.join(", ")}` : entry.help;
		if (entry.kind === "number" && entry.words !== undefined) {
			summary = `${summary}: ${entry.words.join(", ")}`;
		}
		return [`${names} ${entry.placeholder}`, summary] as const;
	},
);

/** Flag spellings that consume the next argv token. */
export const SETTINGS_VALUE_FLAGS: readonly string[] = SETTINGS_FLAGS.filter((entry) => entry.kind !== "bool").flatMap(
	(entry) => [entry.flag, ...(entry.aliases ?? [])],
);

export type SettingsFlagMatch = "none" | "flag" | "value";

/**
 * Applies one argv token if the table claims it. Returns "value" when the next token was consumed.
 * A value flag with no following token is left unclaimed so the caller's unknown-flag capture sees
 * it, as it did when every arm was written out by hand.
 */
export function applySettingsFlag(
	arg: string,
	next: string | undefined,
	target: SettingsFlagValues & { diagnostics: Array<{ type: "warning" | "error"; message: string }> },
): SettingsFlagMatch {
	for (const entry of SETTINGS_FLAGS) {
		if (entry.kind === "bool") {
			const negated = arg === negatedFlag(entry);
			if (!negated && arg !== entry.flag) continue;
			write(target, entry.field, !negated);
			return "flag";
		}
		const alias = entry.aliases?.includes(arg) === true;
		if (!alias && arg !== entry.flag) continue;
		if (next === undefined) return "none";
		if (entry.kind === "number") {
			const word = entry.words?.find((candidate) => candidate === next.toLowerCase());
			if (word !== undefined) {
				write(target, entry.field, word);
				return "value";
			}
			const value = Number(next);
			if (entry.accepts(value)) {
				write(target, entry.field, value);
			} else {
				target.diagnostics.push({
					type: "warning",
					message: `Invalid ${entry.flag} "${value}". Expected ${entry.expected}.`,
				});
			}
			return "value";
		}
		const value = entry.values.find((candidate) => candidate === next);
		if (value !== undefined) {
			write(target, entry.field, value);
		} else {
			target.diagnostics.push({
				type: "warning",
				message: `Invalid ${alias ? (entry.aliasLabel ?? entry.label) : entry.label} "${next}". Valid values: ${entry.values.join(", ")}`,
			});
		}
		return "value";
	}
	return "none";
}

/** Copies the table's fields, `override` winning. One argument picks them out of a wider object. */
export function settingsFlagValues(base: SettingsFlagValues, override: SettingsFlagValues = {}): SettingsFlagValues {
	const merged: SettingsFlagValues = {};
	for (const entry of SETTINGS_FLAGS) {
		write(merged, entry.field, override[entry.field] ?? base[entry.field]);
	}
	return merged;
}
