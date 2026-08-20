/**
 * Rendering keybindings as human-readable labels.
 *
 * Lives in the TUI package (not the app) so list components can label their own
 * hints without importing the theme; colour is applied by the caller.
 */

import { getKeybindings, type Keybinding } from "./keybindings.js";
import type { KeyId } from "./keys.js";

export interface KeyTextOptions {
	primaryOnly?: boolean;
}

function normalizeKeyPart(part: string): string {
	return part === "escape" ? "esc" : part;
}

function formatArrowKey(part: string): string | undefined {
	switch (part) {
		case "up":
			return "↑";
		case "down":
			return "↓";
		case "left":
			return "←";
		case "right":
			return "→";
		default:
			return undefined;
	}
}

function formatKeyPart(part: string, platform: NodeJS.Platform): string {
	const normalized = normalizeKeyPart(part);
	const arrow = formatArrowKey(normalized);
	if (arrow) return arrow;
	// Terminals send the literal Control key on macOS, so never label it Cmd.
	if (platform === "darwin" && normalized === "alt") {
		return "Option";
	}
	return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function formatKeyText(key: string, platform: NodeJS.Platform = process.platform): string {
	return key
		.split("/")
		.map((binding) =>
			binding
				.split("+")
				.map((part) => formatKeyPart(part, platform))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextOptions = {}): string {
	const displayKeys = options.primaryOnly ? keys.slice(0, 1) : keys;
	if (displayKeys.length === 0) return "";
	if (displayKeys.length === 1) return formatKeyText(displayKeys[0]!);
	return formatKeyText(displayKeys.join("/"));
}

/** Label for whatever key the user currently has bound to `keybinding`. */
export function keyText(keybinding: Keybinding, options: KeyTextOptions = {}): string {
	return formatKeys(getKeybindings().getKeys(keybinding), options);
}
