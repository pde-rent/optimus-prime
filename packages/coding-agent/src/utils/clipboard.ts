import { execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.js";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Direct clipboard writes first: emitting OSC 52 first can desynchronize
	// terminal rendering when the terminal also writes the native clipboard.
	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	try {
		if (p === "darwin") {
			execSync("pbcopy", options);
			copied = true;
		} else if (p === "win32") {
			// PowerShell Set-Clipboard is Unicode-safe; clip mangles non-ASCII
			// text through the OEM code page.
			execSync('powershell -NoProfile -Command "Set-Clipboard -Value ([Console]::In.ReadToEnd())"', options);
			copied = true;
		} else {
			// Linux. Try Termux, Wayland, or X11 clipboard tools.
			if (process.env.TERMUX_VERSION) {
				try {
					execSync("termux-clipboard-set", options);
					copied = true;
				} catch {
					// Fall back to Wayland or X11 tools.
				}
			}

			if (!copied) {
				const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
				const hasX11Display = Boolean(process.env.DISPLAY);
				const isWayland = isWaylandSession();
				if (isWayland && hasWaylandDisplay) {
					try {
						// Verify wl-copy exists (spawn errors are async and will not be caught)
						execSync("which wl-copy", { stdio: "ignore" });
						// wl-copy with execSync hangs due to fork behavior; use spawn instead
						const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
						proc.stdin.on("error", () => {
							// Ignore EPIPE errors if wl-copy exits early
						});
						proc.stdin.write(text);
						proc.stdin.end();
						proc.unref();
						copied = true;
					} catch {
						if (hasX11Display) {
							copyToX11Clipboard(options);
							copied = true;
						}
					}
				} else if (hasX11Display) {
					copyToX11Clipboard(options);
					copied = true;
				}
			}
		}
	} catch {
		// Fall through to OSC 52 fallback.
	}

	// On a remote session a platform tool writes the clipboard of the remote
	// host, which the user cannot see; OSC 52 is the only path back to their
	// local terminal, so it is always emitted there. Locally it is the last
	// resort after every platform tool failed.
	const remote = isRemoteSession();
	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
