/**
 * Render an exported session JSONL (header line + branch entries) as a Markdown
 * transcript.
 *
 * The HTML export is a self-contained page; pasting it somewhere is useless, so
 * `/export --clipboard` uses this instead.
 */

interface ContentBlock {
	type: string;
	text?: string;
	mimeType?: string;
	name?: string;
	arguments?: unknown;
}

/**
 * Wrap in a fence long enough to survive the body. Tool output regularly contains
 * its own ``` runs, which would otherwise close the block early.
 */
function fence(body: string, language = ""): string {
	let ticks = 3;
	for (const run of body.matchAll(/`{3,}/g)) {
		ticks = Math.max(ticks, run[0].length + 1);
	}
	const delimiter = "`".repeat(ticks);
	return `${delimiter}${language}\n${body}\n${delimiter}`;
}

function contentToMarkdown(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	// Thinking blocks are model-internal scratch and are deliberately dropped.
	for (const block of content as ContentBlock[]) {
		switch (block.type) {
			case "text":
				if (block.text?.trim()) parts.push(block.text.trim());
				break;
			case "image":
				parts.push(`_[image: ${block.mimeType ?? "image"}]_`);
				break;
			case "toolCall":
				parts.push(`**${block.name}**\n\n${fence(JSON.stringify(block.arguments, null, 2), "json")}`);
				break;
		}
	}
	return parts.join("\n\n");
}

export function sessionJsonlToMarkdown(jsonl: string): string {
	const sections: string[] = [];

	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as Record<string, unknown>;

		switch (entry.type) {
			case "session":
				sections.push(`# Session ${String(entry.id)}\n\n\`${String(entry.cwd)}\``);
				break;
			case "message": {
				const message = entry.message as Record<string, unknown>;
				if (message.role === "toolResult") {
					const label = `${String(message.toolName || "tool")} result${message.isError ? " (error)" : ""}`;
					sections.push(`### ${label}\n\n${fence(contentToMarkdown(message.content))}`);
					break;
				}
				if (message.role === "bashExecution") {
					sections.push(`## bash\n\n${fence(String(message.command ?? ""), "sh")}`);
					if (message.output) sections.push(fence(String(message.output)));
					break;
				}
				const body = contentToMarkdown(message.content);
				if (body) sections.push(`## ${String(message.role)}\n\n${body}`);
				break;
			}
			case "custom_message": {
				if (!entry.display) break;
				const body = contentToMarkdown(entry.content);
				if (body) sections.push(`## ${String(entry.customType)}\n\n${body}`);
				break;
			}
			case "compaction":
				sections.push(`## compaction\n\n${String(entry.summary)}`);
				break;
			case "branch_summary":
				sections.push(`## branch summary\n\n${String(entry.summary)}`);
				break;
		}
	}

	return `${sections.join("\n\n")}\n`;
}
