import type { Focusable } from "@earendil-works/pi-tui";

/**
 * Installs the `focused` accessor of the Focusable interface on `self`: it
 * tracks the value and forwards every change to the child focus targets
 * returned by `getTargets`, so their IME cursor positioning keeps working.
 */
export function installFocusForwarder(self: object, getTargets: () => Array<Focusable | null | undefined>): void {
	let focused = false;
	Object.defineProperty(self, "focused", {
		get: () => focused,
		set: (value: boolean) => {
			focused = value;
			for (const target of getTargets()) {
				if (target) {
					target.focused = value;
				}
			}
		},
	});
}
