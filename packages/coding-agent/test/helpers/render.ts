/**
 * Unified TUI render/output readers shared by interactive-mode suites.
 */
import type { Container, TUI } from "@earendil-works/pi-tui";

/** Renders only the last child of the container. */
export function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

/** Renders every child joined by newlines. */
export function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

/** Full-container render with ANSI codes stripped, backslashes normalized, trailing ws trimmed. */
export function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

/** Strip ANSI escape sequences from arbitrary terminal output. */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Join the text parts of a tool-result-like shape ({ content: [{type:'text',text}] }). */
export function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n") || ""
	);
}

/** Minimal TUI double: components only need requestRender. */
export function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}
