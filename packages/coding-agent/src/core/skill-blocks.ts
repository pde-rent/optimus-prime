/** Parsed skill block from a user message. */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/**
 * Canonical envelope for injected skill content.
 *
 * Shared by /skill:name slash-command expansion and the skill tool so both render
 * identically, and so parseSkillBlock can always read back what injection produced.
 * `location` is absolute and `baseDir` names where relative references resolve.
 */
export function buildSkillBlock(skill: { name: string; filePath: string; baseDir: string }, body: string): string {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}
