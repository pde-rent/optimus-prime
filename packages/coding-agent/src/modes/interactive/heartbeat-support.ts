import type { Message } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { AgentCronJob } from "../../core/cron-jobs.js";



export const HEARTBEAT_LEGACY_PROMPT_MIN_TOLERANCE_MS = 15_000;
export const HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS = 120_000;

export const HEARTBEAT_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{
		value: "every ",
		label: "every <duration> <instruction>",
		description: "Set an interval, then add an instruction: /heartbeat every 10s Scan the logs",
	},
	{
		value: "--steer ",
		label: "--steer <instruction>",
		description: "Deliver by interrupting the current turn (default)",
	},
	{
		value: "--follow-up ",
		label: "--follow-up <instruction>",
		description: "Deliver as a follow-up after the current turn finishes",
	},
];

export function isTextOnlyUserMessage(message: Message): boolean {
	if (message.role !== "user") {
		return false;
	}
	if (typeof message.content === "string") {
		return true;
	}
	return message.content.every((content) => content.type === "text");
}

export function isLikelyHeartbeatPromptTimestamp(job: AgentCronJob, timestamp: number): boolean {
	const directRunTimes = [job.lastRunAt, job.nextRunAt]
		.map((value) => (value ? Date.parse(value) : Number.NaN))
		.filter((value) => Number.isFinite(value));
	const tolerance = heartbeatLegacyPromptToleranceMs(job);
	if (directRunTimes.some((runAt) => Math.abs(timestamp - runAt) <= tolerance)) {
		return true;
	}
	return false;
}

export function heartbeatLegacyPromptToleranceMs(job: AgentCronJob): number {
	const intervalMs = job.schedule.intervalMs;
	if (!intervalMs || intervalMs <= 0) {
		return HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS;
	}
	return Math.min(
		HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS,
		Math.max(HEARTBEAT_LEGACY_PROMPT_MIN_TOLERANCE_MS, intervalMs / 3),
	);
}
