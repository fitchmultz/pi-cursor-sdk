import { createHash } from "node:crypto";
import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { SDKImage } from "@cursor/sdk";
import { getCursorPiBridgeContractText } from "./cursor-bridge-contract.js";
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

export const CURSOR_APPROX_CHARS_PER_TOKEN = 4;
export const CURSOR_IMAGE_TOKEN_ESTIMATE = 1200;
const SECTION_SEPARATOR = "\n\n";

export function getCursorToolTailGuardText(): string {
	return "Tool boundary reminder: If a tool is needed, call an available Cursor SDK/MCP tool. Never print a tool card (for example Tool call/Shell/command) as assistant text.";
}

function getCursorToolBoundaryText(): string {
	return [
		"Cursor SDK tool boundary:",
		"You can call only tools actually exposed by Cursor SDK in this run. Pi tool names, replay tool names, and transcript tool names are context only, not callable capabilities.",
		getCursorPiBridgeContractText(),
		"If asked to list or exercise available tools, list and exercise Cursor SDK tools only; do not claim access to pi-side tools from the system prompt unless Cursor exposes an equivalent tool that runs.",
		"Use pi__cursor_ask_question for material choices if exposed.",
		"Web: use Cursor web/search/browser/MCP or say web search is not configured; do not claim WebSearch/WebFetch unless Cursor executes them.",
		"Replay: pi may display recorded Cursor tool activity as pi-style cards, but replay is display-only and not a capability to invoke.",
		"Images: only latest user images are sent; ask to reattach or describe prior images.",
	].join("\n");
}

function getCursorBootstrapTailSections(): string[] {
	return [
		[
			"Answer the latest user request above using Cursor SDK capabilities only. Do not list, promise, or call pi-only tools from the system prompt as if they were available.",
			"If web research is requested, do not claim it unless a Cursor web/search/browser/MCP tool ran.",
		].join("\n"),
		getCursorToolTailGuardText(),
	];
}

function normalizePiContextMessages(messages: Context["messages"]): Message[] {
	return convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
}

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

	const charsPerToken = options.charsPerToken ?? CURSOR_APPROX_CHARS_PER_TOKEN;
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

export function estimateCursorTextTokens(text: string, options: Pick<CursorPromptOptions, "charsPerToken"> = {}): number {
	const charsPerToken = options.charsPerToken ?? CURSOR_APPROX_CHARS_PER_TOKEN;
	return Math.ceil(text.length / charsPerToken);
}

export function estimateCursorPromptTokens(prompt: CursorPrompt, options: Pick<CursorPromptOptions, "charsPerToken" | "imageTokenEstimate"> = {}): number {
	return estimateCursorTextTokens(prompt.text, options) + prompt.images.length * (options.imageTokenEstimate ?? CURSOR_IMAGE_TOKEN_ESTIMATE);
}

export function estimateCursorPromptMessageTokens(message: Message, options: Pick<CursorPromptOptions, "charsPerToken"> = {}): number {
	const text = formatMessage(message);
	return text ? estimateCursorTextTokens(text, options) : 0;
}

export function estimateCursorContextTokens(context: Context, options: CursorPromptOptions = {}): number {
	return estimateCursorPromptTokens(buildCursorPrompt(context, options), options);
}

interface CursorContextFingerprintPayload {
	systemHash: string;
	messageHashes: string[];
}

function hashCursorContextValue(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function serializeMessageForFingerprint(message: Message, index: number): string {
	switch (message.role) {
		case "user": {
			const text =
				typeof message.content === "string"
					? message.content
					: JSON.stringify(message.content);
			return hashCursorContextValue(`user:${message.timestamp ?? index}:${text}`);
		}
		case "assistant":
			return hashCursorContextValue(`assistant:${message.timestamp ?? index}:${JSON.stringify(message.content)}`);
		case "toolResult":
			return hashCursorContextValue(
				`toolResult:${message.timestamp ?? index}:${message.toolCallId}:${message.toolName}:${JSON.stringify(message.content)}:${message.isError === true}`,
			);
	}
}

function serializeRawPiMessageForFingerprint(message: Context["messages"][number], index: number): string {
	const role = (message as { role?: string }).role;
	switch (role) {
		case "branchSummary": {
			const entry = message as { summary?: string; fromId?: string; timestamp?: number };
			return hashCursorContextValue(
				`branchSummary:${entry.timestamp ?? index}:${entry.fromId ?? ""}:${entry.summary ?? ""}`,
			);
		}
		case "compactionSummary": {
			const entry = message as { summary?: string; tokensBefore?: number; timestamp?: number };
			return hashCursorContextValue(
				`compactionSummary:${entry.timestamp ?? index}:${entry.tokensBefore ?? ""}:${entry.summary ?? ""}`,
			);
		}
		case "custom": {
			const entry = message as { customType?: string; content?: unknown; timestamp?: number };
			return hashCursorContextValue(
				`custom:${entry.timestamp ?? index}:${entry.customType ?? ""}:${JSON.stringify(entry.content)}`,
			);
		}
		case "bashExecution": {
			const entry = message as {
				command?: string;
				output?: string;
				exitCode?: number | null;
				cancelled?: boolean;
				excludeFromContext?: boolean;
				timestamp?: number;
			};
			if (entry.excludeFromContext) {
				return hashCursorContextValue(`bashExecution:excluded:${entry.timestamp ?? index}`);
			}
			return hashCursorContextValue(
				`bashExecution:${entry.timestamp ?? index}:${entry.command ?? ""}:${entry.output ?? ""}:${entry.exitCode ?? ""}:${entry.cancelled === true}`,
			);
		}
		default:
			return serializeMessageForFingerprint(message as Message, index);
	}
}

function parseCursorContextFingerprint(fingerprint: string): CursorContextFingerprintPayload | undefined {
	try {
		const parsed = JSON.parse(fingerprint) as CursorContextFingerprintPayload;
		if (!parsed || typeof parsed.systemHash !== "string" || !Array.isArray(parsed.messageHashes)) return undefined;
		if (!parsed.messageHashes.every((entry) => typeof entry === "string")) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function computeCursorContextFingerprint(context: Context): string {
	const payload: CursorContextFingerprintPayload = {
		systemHash: hashCursorContextValue(context.systemPrompt ?? ""),
		messageHashes: context.messages.map((message, index) => serializeRawPiMessageForFingerprint(message, index)),
	};
	return JSON.stringify(payload);
}

export function shouldBootstrapCursorContext(
	sendState: { bootstrapped: boolean; contextFingerprint: string },
	context: Context,
): boolean {
	if (!sendState.bootstrapped) return true;
	const previous = parseCursorContextFingerprint(sendState.contextFingerprint);
	if (!previous) return true;
	const current = parseCursorContextFingerprint(computeCursorContextFingerprint(context));
	if (!current) return true;
	if (current.systemHash !== previous.systemHash) return true;
	if (current.messageHashes.length < previous.messageHashes.length) return true;
	if (current.messageHashes.length > previous.messageHashes.length) {
		for (let index = previous.messageHashes.length; index < context.messages.length; index += 1) {
			const role = (context.messages[index] as { role?: string }).role;
			if (role === "branchSummary" || role === "compactionSummary") return true;
		}
	}
	for (let index = 0; index < previous.messageHashes.length; index += 1) {
		if (current.messageHashes[index] !== previous.messageHashes[index]) return true;
	}
	return false;
}

/** @deprecated Use planCursorSessionSend() for send mode and shouldBootstrapCursorContext() for context-only checks. */
export function shouldBootstrapCursorSend(
	sendState: { bootstrapped: boolean; contextFingerprint: string },
	context: Context,
): boolean {
	return shouldBootstrapCursorContext(sendState, context);
}

export function buildCursorIncrementalPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	// Incremental sends omit the full Cursor SDK tool boundary block; the session agent retains prior bootstrap context.
	const messages = normalizePiContextMessages(context.messages);
	const latestUserMessageIndex = getLatestUserMessageIndex(messages);
	const latestUserMessage = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex] : undefined;
	const latestUserText = latestUserMessage ? formatMessage(latestUserMessage) : undefined;
	const sectionsBeforeMessages = [
		"Continue the conversation using Cursor SDK capabilities only. Do not list, promise, or call pi-only tools from earlier context as if they were available.",
	];
	if (context.systemPrompt) {
		sectionsBeforeMessages.push(`System instructions from pi:\n${sanitizeSystemPromptForCursor(context.systemPrompt)}`);
	}
	const latestUserMessageSections =
		latestUserText && latestUserMessageIndex >= 0 ? [{ index: latestUserMessageIndex, text: latestUserText }] : [];
	const images = extractLatestImages(messages);
	const imageTokenReserve = images.length * (options.imageTokenEstimate ?? 0);
	const budgetOptions =
		options.maxInputTokens === undefined
			? options
			: { ...options, maxInputTokens: Math.max(1, options.maxInputTokens - imageTokenReserve) };
	const parts = applyPromptBudget(
		sectionsBeforeMessages,
		latestUserMessageSections,
		[getCursorToolTailGuardText()],
		latestUserMessageIndex,
		budgetOptions,
	);
	return { text: parts.join(SECTION_SEPARATOR), images };
}

export function buildCursorPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	const sectionsBeforeMessages: string[] = [getCursorToolBoundaryText()];

	if (context.systemPrompt) {
		sectionsBeforeMessages.push(`System instructions from pi:\n${sanitizeSystemPromptForCursor(context.systemPrompt)}`);
	}

	const messages = normalizePiContextMessages(context.messages);
	const messageSections = messages
		.map((msg, index) => {
			const text = formatMessage(msg);
			return text ? { index, text } : undefined;
		})
		.filter((section): section is { index: number; text: string } => section !== undefined);
	const sectionsAfterMessages = getCursorBootstrapTailSections();
	const images = extractLatestImages(messages);
	const imageTokenReserve = images.length * (options.imageTokenEstimate ?? 0);
	const budgetOptions =
		options.maxInputTokens === undefined
			? options
			: { ...options, maxInputTokens: Math.max(1, options.maxInputTokens - imageTokenReserve) };
	const parts = applyPromptBudget(
		sectionsBeforeMessages,
		messageSections,
		sectionsAfterMessages,
		getLatestUserMessageIndex(messages),
		budgetOptions,
	);
	const text = parts.join(SECTION_SEPARATOR);


	return { text, images };
}
