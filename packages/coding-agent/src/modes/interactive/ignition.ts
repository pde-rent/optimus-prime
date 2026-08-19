/**
 * Start-up ignition: the brand mark lights up under a red scan while a short sound plays.
 *
 * Deliberately decorative and deliberately cheap to skip. It never gates input — the editor is
 * live from the first frame, and the first keystroke ends the animation — because a start-up
 * flourish that delays the prompt is a regression dressed as a feature.
 */

import { spawn } from "node:child_process";
import { existsSync } from "fs";
import { getBundledInteractiveAssetPath } from "../../config.js";

export const IGNITION_DURATION_MS = 5_000;

/** ~20fps. Fast enough for a smooth sweep, slow enough to stay invisible in a profile. */
export const IGNITION_FRAME_MS = 50;

/**
 * Players that can handle Opus, in order of preference, each with the flags that make it exit
 * quietly. macOS ships `afplay`; the rest are only tried if it is missing.
 */
const PLAYERS: ReadonlyArray<{ cmd: string; args: (file: string) => string[] }> = [
	{ cmd: "afplay", args: (file) => [file] },
	{ cmd: "ffplay", args: (file) => ["-nodisp", "-autoexit", "-loglevel", "quiet", file] },
	{ cmd: "mpv", args: (file) => ["--no-video", "--really-quiet", file] },
	{ cmd: "paplay", args: (file) => [file] },
];

/** Resolved the same way as the other bundled interactive assets. */
export function ignitionSoundPath(): string | undefined {
	const path = getBundledInteractiveAssetPath("ignition.opus");
	return existsSync(path) ? path : undefined;
}

/**
 * Play the ignition sound without blocking or owning the child.
 *
 * Failure is silence: a machine with no audio, no player, or a busy device must start the agent
 * exactly as fast as one that plays the sound, so every error here is swallowed on purpose.
 */
export function playIgnitionSound(): void {
	const file = ignitionSoundPath();
	if (!file) return;
	for (const player of PLAYERS) {
		try {
			const child = spawn(player.cmd, player.args(file), { stdio: "ignore", detached: true });
			// A missing binary surfaces asynchronously; swallow it so the next player is not
			// preempted by an unhandled error event killing the process.
			child.on("error", () => {});
			child.unref();
			return;
		} catch {
			// Try the next player.
		}
	}
}

/** Red ramp from near-black to hot, the colours the scan interpolates between. */
const LASER_RAMP = ["#2a0000", "#5c0505", "#a01010", "#e01818", "#ff3b30", "#ff8a80", "#ffd9d6"] as const;

/**
 * Colour for one row of art at a moment in the animation.
 *
 * `undefined` means "leave this row alone", so the caller keeps the ordinary theme colour and the
 * art never disappears if the effect is disabled or has finished.
 */
export function ignitionRowColor(row: number, rows: number, elapsedMs: number): string | undefined {
	if (elapsedMs < 0 || elapsedMs >= IGNITION_DURATION_MS || rows <= 0) return undefined;
	const progress = elapsedMs / IGNITION_DURATION_MS;

	// Two sweeps down the mark, then a hold: the scan reads as a pass rather than a loop.
	const sweeps = 2;
	const scan = (progress * sweeps) % 1;
	const scanRow = scan * (rows - 1);
	const distance = Math.abs(row - scanRow);

	// Beyond the beam the art sits at the dim end of the ramp rather than going dark, so the
	// silhouette stays readable through the whole animation.
	const beam = Math.max(1.5, rows / 6);
	const intensity = distance >= beam ? 0 : 1 - distance / beam;

	// A fast flicker on top of the sweep, easing out so the mark settles instead of stopping dead.
	const settle = 1 - progress;
	const flicker = 1 - 0.25 * settle * (0.5 + 0.5 * Math.sin(elapsedMs / 40));
	const level = Math.min(1, intensity * flicker + 0.12);
	const index = Math.min(LASER_RAMP.length - 1, Math.max(0, Math.round(level * (LASER_RAMP.length - 1))));
	return LASER_RAMP[index];
}
