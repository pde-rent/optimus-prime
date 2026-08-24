/**
 * Start-up ignition: the mark's eyes light red while a short sound plays.
 *
 * Deliberately decorative and deliberately cheap to skip. It never gates input — the editor is
 * live from the first frame, and the first keystroke ends it — because a start-up flourish that
 * delays the prompt is a regression dressed as a feature.
 */

import { spawn } from "node:child_process";
import { existsSync } from "fs";
import { getBundledInteractiveAssetPath } from "../../config.js";

export const IGNITION_DURATION_MS = 5_000;

/** ~20fps. Fast enough for a clean pulse, slow enough to stay invisible in a profile. */
export const IGNITION_FRAME_MS = 50;

/**
 * The character cells that are the eyes, as `[row, column]` into OPTIMUS_LOGO.
 *
 * Column and string index agree because every cell in the mark is a single-width braille glyph.
 * If the glow lands off-target, this is the only thing to change.
 */
/** Half-period of the blink. Short enough to read as flashing, long enough not to strobe. */
const EYE_BLINK_MS = 140;

export const IGNITION_EYES: ReadonlyArray<readonly [number, number]> = [
	[3, 20],
	[3, 26],
];

/**
 * Candidate players, most-preferred first for the current platform.
 *
 * Ordered so the common case needs nothing installed: macOS ships `afplay`, Windows ships
 * PowerShell, and most Linux desktops have at least one of these. `paplay` and `aplay` are absent
 * because they take WAV and raw PCM only. Windows Media Foundation may not decode Opus, so the
 * ffplay and mpv fallbacks matter more there than on the other platforms.
 */
function candidatePlayers(file: string): ReadonlyArray<readonly string[]> {
	const ffplay = ["ffplay", "-nodisp", "-autoexit", "-nostats", "-hide_banner", "-loglevel", "quiet", file];
	const mpv = ["mpv", "--no-video", "--really-quiet", "--no-terminal", file];
	if (process.platform === "darwin") {
		return [["afplay", file], ffplay, mpv];
	}
	if (process.platform === "win32") {
		// MediaPlayer is asynchronous, so the script has to outlive the clip; hidden window style
		// keeps it from stealing focus from the terminal.
		const command =
			"Add-Type -AssemblyName PresentationCore;" +
			"$p = New-Object System.Windows.Media.MediaPlayer;" +
			`$p.Open([uri]'${file.replace(/'/g, "''")}');` +
			"Start-Sleep -Milliseconds 400; $p.Play(); Start-Sleep -Seconds 6; $p.Close()";
		const ps = ["-NoProfile", "-WindowStyle", "Hidden", "-Command", command];
		return [["powershell", ...ps], ["pwsh", ...ps], ffplay, mpv];
	}
	return [
		ffplay,
		mpv,
		["gst-play-1.0", "--no-interactive", file],
		["cvlc", "--play-and-exit", "--intf", "dummy", file],
	];
}

/**
 * Resolved the same way as the other bundled interactive assets.
 *
 * The original Opus stream, remuxed from Ogg into MP4 without re-encoding. macOS CoreAudio reads
 * Opus from MP4 but not from Ogg: given the `.opus` original, `afplay` plays roughly its first two
 * seconds and then exits reporting success, which looks like the sound being cut off rather than
 * like a decode failure. Remuxing keeps the audio bit-exact and the file smaller than any AAC
 * transcode that still sounded right.
 */
export function ignitionSoundPath(): string | undefined {
	const path = getBundledInteractiveAssetPath("ignition.m4a");
	return existsSync(path) ? path : undefined;
}

/**
 * Whether this process is a genuinely user-launched foreground session.
 *
 * Agent-spawned instances mark themselves with an `OPTIMUS_INTERNAL_` env prefix (daemon workers,
 * owned session workers, kernels), and any piped or captured run has no terminal on stdin/stdout.
 * Each such instance shares the user's audio device, so without this gate one chime per spawn
 * reads from the user's seat as "a sound plays every time a subagent runs". The prefix check
 * mirrors the daemon wire's own internal-metadata fence (daemon-worker-protocol.ts).
 */
export function shouldPlayIgnitionSound(io?: {
	env?: NodeJS.ProcessEnv;
	stdinIsTTY?: boolean | undefined;
	stdoutIsTTY?: boolean | undefined;
}): boolean {
	const env = io?.env ?? process.env;
	if (Object.keys(env).some((key) => key.startsWith("OPTIMUS_INTERNAL_"))) return false;
	return (io?.stdinIsTTY ?? process.stdin.isTTY) === true && (io?.stdoutIsTTY ?? process.stdout.isTTY) === true;
}

let soundStarted = false;

/**
 * Play the ignition sound without blocking or owning the player.
 *
 * Launched through a shell that backgrounds the player and exits, so the player is reparented away
 * and cannot be cut short by anything that later happens to this process or its group. Guarded so
 * a re-rendered header cannot stack a second copy over the first. Only a user-launched
 * foreground session earns it at all: agent-spawned or non-terminal processes stay silent.
 *
 * Failure is silence: a machine with no audio, no player, or a busy device must start the agent
 * exactly as fast as one that plays the sound, so every error here is swallowed on purpose.
 */
export function playIgnitionSound(): void {
	if (soundStarted) return;
	if (!shouldPlayIgnitionSound()) return;
	const file = ignitionSoundPath();
	if (!file) return;
	soundStarted = true;
	for (const [bin, ...args] of candidatePlayers(file)) {
		// Resolved before spawning: a missing binary surfaces as an asynchronous `error` event, so a
		// loop that spawned blindly would commit to the first candidate whether or not it exists.
		if (!Bun.which(bin!)) continue;
		try {
			const child = spawn(bin!, args, { stdio: "ignore", detached: true });
			// A missing binary surfaces asynchronously, so this handler is what keeps an unhandled
			// error event from taking the session down with it.
			child.on("error", () => {});
			child.unref();
			return;
		} catch {
			// Try the next player.
		}
	}
}

/** The theme's bright green, and the dim green it blinks down to. */
const EYE_HOT = "#2ADB5C";
const EYE_DIM = "#1a5c2c";

/**
 * Colour for one cell of the mark, or `undefined` to leave it the ordinary theme colour.
 *
 * Only the eye cells themselves. Earlier versions beamed outward from each eye, but at this scale
 * two eyes six cells apart plus any beam at all reads as a band drawn across the face rather than
 * as eyes lighting up.
 */
export function ignitionCellColor(
	row: number,
	col: number,
	elapsedMs: number,
	eyes: ReadonlyArray<readonly [number, number]> = IGNITION_EYES,
): string | undefined {
	if (elapsedMs < 0 || elapsedMs >= IGNITION_DURATION_MS) return undefined;
	if (!eyes.some(([eyeRow, eyeCol]) => eyeRow === row && eyeCol === col)) return undefined;
	// A hard blink rather than a fade: on/off on a fixed period reads as powered, and interpolating
	// through mid greens just looks like the mark is out of focus.
	return Math.floor(elapsedMs / EYE_BLINK_MS) % 2 === 0 ? EYE_HOT : EYE_DIM;
}
