import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT } from "./interactive-mode.js";

export function initialRenderMessages(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length <= INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT) {
		return messages;
	}
	const toolCallMessages = new Map<string, { index: number; message: Extract<AgentMessage, { role: "assistant" }> }>();
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const content of message.content) {
			if (content.type === "toolCall") {
				toolCallMessages.set(content.id, { index, message });
			}
		}
	}

	const initialStartIndex = messages.length - INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT;
	for (let startIndex = initialStartIndex; startIndex < messages.length; startIndex++) {
		const visibleMessages = messages.slice(startIndex);
		const visibleToolCallIds = new Set<string>();
		for (const message of visibleMessages) {
			if (message.role !== "assistant") {
				continue;
			}
			for (const content of message.content) {
				if (content.type === "toolCall") {
					visibleToolCallIds.add(content.id);
				}
			}
		}

		const requiredToolCallIdsByMessage = new Map<
			number,
			{ message: Extract<AgentMessage, { role: "assistant" }>; toolCallIds: Set<string> }
		>();
		for (const message of visibleMessages) {
			if (message.role !== "toolResult" || visibleToolCallIds.has(message.toolCallId)) {
				continue;
			}
			const toolCallMessage = toolCallMessages.get(message.toolCallId);
			if (!toolCallMessage || toolCallMessage.index >= startIndex) {
				continue;
			}
			const requiredMessage = requiredToolCallIdsByMessage.get(toolCallMessage.index) ?? {
				message: toolCallMessage.message,
				toolCallIds: new Set<string>(),
			};
			requiredMessage.toolCallIds.add(message.toolCallId);
			requiredToolCallIdsByMessage.set(toolCallMessage.index, requiredMessage);
		}

		if (visibleMessages.length + requiredToolCallIdsByMessage.size > INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT) {
			continue;
		}

		const requiredToolCallMessages = [...requiredToolCallIdsByMessage.entries()]
			.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
			.map(([, { message, toolCallIds }]) => ({
				...message,
				content: message.content.filter((content) => content.type !== "toolCall" || toolCallIds.has(content.id)),
			}));
		return omitOrphanToolResults([...requiredToolCallMessages, ...visibleMessages]);
	}

	return [];
}

export function omitOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
	const renderedToolCallIds = new Set<string>();
	const renderableMessages: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") {
					renderedToolCallIds.add(content.id);
				}
			}
			renderableMessages.push(message);
		} else if (message.role === "toolResult") {
			if (renderedToolCallIds.has(message.toolCallId)) {
				renderableMessages.push(message);
			}
		} else {
			renderableMessages.push(message);
		}
	}
	return renderableMessages;
}
