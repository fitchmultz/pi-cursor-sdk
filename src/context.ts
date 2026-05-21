import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";
import type { SDKImage } from "@cursor/sdk";
import { getCursorReplayPromptLabel } from "./cursor-tool-names.js";

export interface CursorPrompt {
	text: string;
	images: SDKImage[];
}

export interface CursorPromptOptions {
	maxInputTokens?: number;
	charsPerToken?: number;
	imageTokenEstimate?: number;
}

const DEFAULT_CHARS_PER_TOKEN = 4;
const SECTION_SEPARATOR = "\n\n";

function isTextBlock(block: { type: string }): block is { type: "text"; text: string } {
	return block.type === "text";
}

function isImageBlock(block: { type: string }): block is { type: "image"; data: string; mimeType: string } {
	return block.type === "image";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function extractLatestImages(messages: Message[]): SDKImage[] {
	// Find the last user message and extract images only from it
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") return [];

		const images: SDKImage[] = [];
		for (const block of msg.content) {
			if (isImageBlock(block) && block.data && block.mimeType) {
				images.push({ data: block.data, mimeType: block.mimeType });
			}
		}
		return images;
	}
	return [];
}

function formatContentBlocks(content: string | { type: string; text?: string; data?: string; mimeType?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (isTextBlock(block)) return block.text;
			if (isImageBlock(block)) return "[image omitted from transcript]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatToolCall(toolCall: ToolCall): string {
	const args = JSON.stringify(toolCall.arguments) ?? "";
	return `Tool call (${getCursorReplayPromptLabel(toolCall.name)}, call ${toolCall.id}): ${args}`;
}

function sanitizeSystemPromptForCursor(systemPrompt: string): string {
	let sanitized = systemPrompt;
	sanitized = sanitized.replace(
		/Available tools:\n[\s\S]*?\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n\n/g,
		"Pi tool catalog omitted: Cursor can call only Cursor SDK tools exposed in this run.\n\n",
	);
	sanitized = sanitized.replace(
		/Guidelines:\n[\s\S]*?\n\nPi documentation /g,
		"Guidelines:\n- Be concise in your responses.\n- Show file paths clearly when working with files.\n\nPi documentation ",
	);
	sanitized = sanitized.replace(
		/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/g,
		"",
	);
	sanitized = sanitized.replace(/\n+Semantic code intelligence priority:[\s\S]*$/g, "");
	return sanitized.trim();
}

function formatMessage(msg: Message): string | undefined {
	switch (msg.role) {
		case "user": {
			const text = formatContentBlocks(msg.content);
			return text ? `User: ${text}` : undefined;
		}
		case "assistant": {
			const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: String(msg.content) }];
			const textParts: string[] = [];
			for (const block of blocks) {
				if (isTextBlock(block)) {
					textParts.push(block.text);
				} else if (isToolCallBlock(block)) {
					textParts.push(formatToolCall(block));
				}
				// Omit thinking content from transcript
			}
			return textParts.length > 0 ? `Assistant: ${textParts.join("\n")}` : undefined;
		}
		case "toolResult": {
			const text = formatContentBlocks(msg.content);
			const label = msg.isError ? "Tool error" : "Tool result";
			return `${label} (${getCursorReplayPromptLabel(msg.toolName)}, call ${msg.toolCallId}): ${text}`;
		}
	}
}

function getLatestUserMessageIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

function getSectionCost(section: string): number {
	return section.length + SECTION_SEPARATOR.length;
}

function applyPromptBudget(
	sectionsBeforeMessages: string[],
	messageSections: Array<{ index: number; text: string }>,
	sectionsAfterMessages: string[],
	latestUserMessageIndex: number,
	options: CursorPromptOptions,
): string[] {
	const maxInputTokens = options.maxInputTokens;
	if (maxInputTokens === undefined || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
		return [...sectionsBeforeMessages, ...messageSections.map((section) => section.text), ...sectionsAfterMessages];
	}

	const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
	const maxChars = Math.max(1, Math.floor(maxInputTokens * charsPerToken));
	const requiredMessageSections = messageSections.filter((section) => section.index === latestUserMessageIndex);
	const requiredCost = [...sectionsBeforeMessages, ...requiredMessageSections.map((section) => section.text), ...sectionsAfterMessages].reduce(
		(total, section) => total + getSectionCost(section),
		0,
	);
	let remainingChars = maxChars - requiredCost;
	const includedMessageIndexes = new Set(requiredMessageSections.map((section) => section.index));
	let omittedMessageCount = 0;

	for (let index = messageSections.length - 1; index >= 0; index -= 1) {
		const section = messageSections[index];
		if (includedMessageIndexes.has(section.index)) continue;
		const cost = getSectionCost(section.text);
		if (cost <= remainingChars) {
			includedMessageIndexes.add(section.index);
			remainingChars -= cost;
			continue;
		}
		omittedMessageCount += messageSections
			.slice(0, index + 1)
			.filter((candidate) => !includedMessageIndexes.has(candidate.index)).length;
		break;
	}

	const budgetNotice =
		omittedMessageCount > 0
			? [`[Earlier transcript omitted: ${omittedMessageCount} message${omittedMessageCount === 1 ? "" : "s"} to fit Cursor context budget]`]
			: [];
	const includedMessages = messageSections
		.filter((section) => includedMessageIndexes.has(section.index))
		.map((section) => section.text);
	return [...sectionsBeforeMessages, ...budgetNotice, ...includedMessages, ...sectionsAfterMessages];
}

export function buildCursorPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	const sectionsBeforeMessages: string[] = [
		[
			"Cursor SDK tool boundary:",
			"You can call only tools actually exposed by Cursor SDK in this run. Pi tool names, replay tool names, and transcript tool names are context only, not callable capabilities.",
			"If asked to list or exercise available tools, list and exercise Cursor SDK tools only; do not claim access to pi-side tools from the system prompt unless Cursor exposes an equivalent tool that runs.",
			"Use pi__cursor_ask_question for material choices if exposed.",
			"Web: use Cursor web/search/browser/MCP or say web search is not configured; do not claim WebSearch/WebFetch unless Cursor executes them.",
			"Replay: pi may display recorded Cursor tool activity as pi-style cards, but replay is display-only and not a capability to invoke.",
			"Images: only latest user images are sent; ask to reattach or describe prior images.",
		].join("\n"),
	];

	if (context.systemPrompt) {
		sectionsBeforeMessages.push(`System instructions from pi:\n${sanitizeSystemPromptForCursor(context.systemPrompt)}`);
	}

	const messageSections = context.messages
		.map((msg, index) => {
			const text = formatMessage(msg);
			return text ? { index, text } : undefined;
		})
		.filter((section): section is { index: number; text: string } => section !== undefined);
	const sectionsAfterMessages = [
		[
			"Answer the latest user request above using Cursor SDK capabilities only. Do not list, promise, or call pi-only tools from the system prompt as if they were available.",
			"If web research is requested, do not claim it unless a Cursor web/search/browser/MCP tool ran.",
		].join("\n"),
	];
	const images = extractLatestImages(context.messages);
	const imageTokenReserve = images.length * (options.imageTokenEstimate ?? 0);
	const budgetOptions =
		options.maxInputTokens === undefined
			? options
			: { ...options, maxInputTokens: Math.max(1, options.maxInputTokens - imageTokenReserve) };
	const parts = applyPromptBudget(
		sectionsBeforeMessages,
		messageSections,
		sectionsAfterMessages,
		getLatestUserMessageIndex(context.messages),
		budgetOptions,
	);
	const text = parts.join(SECTION_SEPARATOR);


	return { text, images };
}
