import {
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type Context,
	type Message,
	type Tool,
} from "@earendil-works/pi-ai";

export function isCursorSystemMessage(message: { role: string }): boolean {
	return message.role === "system";
}

/** Conversation-only view for Cursor text/history and trailing tool-result scans. */
export function getCursorConversationMessages(context: Pick<Context, "messages">): Message[] {
	return context.messages.filter((message) => !isCursorSystemMessage(message));
}

export function resolveCursorPiContext(context: Context): { systemPrompt: string; tools: Tool[] | undefined } {
	const messages = normalizeContext(context).messages;
	const shorthandWithoutTools = ("systemPrompt" in context || "tools" in context)
		&& context.tools === undefined && !context.messages.some(isCursorSystemMessage);
	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: shorthandWithoutTools ? undefined : getCurrentTools(messages),
	};
}
