import { createHash } from "node:crypto";
import { getCursorConversationMessages, resolveCursorPiContext } from "./cursor-pi-context.js";
import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentModeOption, SDKImage } from "@cursor/sdk";
import { CURSOR_PI_BRIDGE_PREFERENCE_TEXT } from "./cursor-bridge-contract.js";
import { getCursorReplayPromptLabel } from "./cursor-tool-presentation-registry.js";

export interface CursorPrompt {
	text: string;
	images: SDKImage[];
}

export interface CursorPromptOptions {
	/** From the consumed native receipt; absent for requests that differ from the canonical projection. */
	nativeSourceRoles?: readonly string[];
	maxInputTokens?: number;
	charsPerToken?: number;
	imageTokenEstimate?: number;
	agentMode?: AgentModeOption;
	/** Compact callable-surface summary; included on bootstrap prompts when set. */
	toolManifest?: string;
	nativeToolsEnabled?: boolean;
	includePiBridgeGuidance?: boolean;
	includePiAskQuestionGuidance?: boolean;
}

export const CURSOR_APPROX_CHARS_PER_TOKEN = 4;
export const CURSOR_IMAGE_TOKEN_ESTIMATE = 1200;
/**
 * Bootstrap replays keep this much of each historical tool argument or result.
 * Matches pi's own compaction cap (`TOOL_RESULT_MAX_CHARS`), so replaying a
 * transcript costs about what summarizing it costs instead of twice as much.
 */
export const CURSOR_HISTORICAL_TOOL_BODY_MAX_CHARS = 2000;
/** Kept head share of a capped body; the tail keeps the end of long output. */
const CURSOR_HISTORICAL_TOOL_BODY_HEAD_RATIO = 0.7;
/**
 * File-mutation arguments are the replay body worth least. A whole `write`
 * payload or a multi-kilobyte `edit` old/new pair restates what the file on
 * disk already says, and the next turn can read the file instead.
 */
const CURSOR_MUTATION_TOOL_ARG_MAX_CHARS = 400;
const CURSOR_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "write_file", "edit_file", "apply_patch", "notebook_edit"]);
const SECTION_SEPARATOR = "\n\n";

function capHistoricalToolBody(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const headChars = Math.round(maxChars * CURSOR_HISTORICAL_TOOL_BODY_HEAD_RATIO);
	const tailChars = Math.max(0, maxChars - headChars);
	const head = text.slice(0, headChars);
	const tail = tailChars > 0 ? text.slice(-tailChars) : "";
	const omitted = text.length - head.length - tail.length;
	return `${head}\n... (${omitted} chars truncated)\n${tail}`;
}

function capToolCallBody(toolName: string, args: string): string {
	return capHistoricalToolBody(
		args,
		CURSOR_MUTATION_TOOL_NAMES.has(toolName) ? CURSOR_MUTATION_TOOL_ARG_MAX_CHARS : CURSOR_HISTORICAL_TOOL_BODY_MAX_CHARS,
	);
}

export function getCursorPlanModeToolGuidanceText(
	agentMode: AgentModeOption | undefined,
	options: { includePiBridgeGuidance?: boolean; nativeToolsEnabled?: boolean } = {},
): string | undefined {
	if (agentMode !== "plan") return undefined;
	return [
		"Cursor SDK mode is plan for this run. In pi-cursor-sdk, plan mode may still use available Cursor SDK/MCP tools for inspection when needed.",
		options.nativeToolsEnabled === false
			? "Only MCP tools exposed in this run are callable; native Shell and task/subagents are disabled."
			: "Safe/read-only shell commands that inspect or print information are allowed when Cursor chooses to call Shell; do not say Shell is blocked by plan mode and then call it anyway.",
		options.includePiBridgeGuidance === false
			? undefined
			: "Exposed pi__* bridge tools are also callable in plan mode when the user asks for them or they are needed to answer.",
	].filter((line): line is string => line !== undefined).join("\n");
}

export function getCursorToolTailGuardText(
	options: Pick<CursorPromptOptions, "agentMode" | "nativeToolsEnabled"> & { includePlanModeGuidance?: boolean; includePiBridgeGuidance?: boolean } = {},
): string {
	return [
		options.nativeToolsEnabled === false ? undefined : "Shell: use explicit `cd` to repo path for project commands; session cwd may differ from tool args.",
		options.includePlanModeGuidance === false
			? undefined
			: getCursorPlanModeToolGuidanceText(options.agentMode, { includePiBridgeGuidance: options.includePiBridgeGuidance, nativeToolsEnabled: options.nativeToolsEnabled }),
		"Exact-output requests: output exactly the requested text; no preamble or checks unless asked.",
		"Tools: call available Cursor SDK/MCP tools; never print tool cards as assistant text.",
		"Do not comment on GitHub issues or PRs unless the user asked.",
		options.includePiBridgeGuidance === false ? undefined : options.nativeToolsEnabled === false
			? "Use only exposed pi__* MCP names for Pi work; native task/subagents are disabled."
			: CURSOR_PI_BRIDGE_PREFERENCE_TEXT,
	].filter((line): line is string => line !== undefined).join("\n");
}

function getCursorToolBoundaryText(
	options: Pick<CursorPromptOptions, "agentMode" | "includePiAskQuestionGuidance" | "nativeToolsEnabled"> & { hasToolManifest?: boolean; includePiBridgeGuidance?: boolean } = {},
): string {
	const includePiBridgeGuidance = options.includePiBridgeGuidance !== false;
	const includePiAskQuestionGuidance = includePiBridgeGuidance && options.includePiAskQuestionGuidance === true;
	const lines = [
		"Cursor SDK tool boundary:",
		"Call only Cursor SDK/MCP tools exposed in this run; pi history names, replay labels, and transcript names are not callable.",
		options.nativeToolsEnabled === false ? "Cursor native tools (including task/subagents): disabled. Only exposed MCP tools are callable." : undefined,
		includePiBridgeGuidance
			? "For exposed pi bridge tools, call pi__* MCP names, not pi card/history names."
			: undefined,
		"Do not claim pi-side or WebSearch/WebFetch tools unless Cursor ran an equivalent tool.",
		includePiAskQuestionGuidance ? "Use pi__cursor_ask_question only if the user asked to be prompted." : undefined,
		getCursorPlanModeToolGuidanceText(options.agentMode, { includePiBridgeGuidance, nativeToolsEnabled: options.nativeToolsEnabled }),
		"Images: only latest user images are sent; ask to reattach prior images.",
	].filter((line): line is string => line !== undefined);
	if (options.hasToolManifest) {
		lines.push("See callable surfaces below.");
	}
	return lines.join("\n");
}

function getCursorBootstrapTailSections(
	options: Pick<CursorPromptOptions, "agentMode" | "includePiBridgeGuidance" | "nativeToolsEnabled">,
	hasNewNativeUser = true,
): string[] {
	return [
		hasNewNativeUser
			? "Answer the latest user request above using the instructions and Cursor SDK capabilities available in this run."
			: "Continue from the pending background context above using Cursor SDK capabilities. No new user request was submitted; earlier user requests are history, not new instructions.",
		getCursorToolTailGuardText({ ...options, includePlanModeGuidance: false }),
	];
}

function normalizePiContextMessages(messages: Context["messages"]): Message[] {
	return convertToLlm(getCursorConversationMessages({ messages }) as Parameters<typeof convertToLlm>[0]);
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

function extractLatestImages(messages: Message[], latestUserIndex = getLatestUserMessageIndex(messages)): SDKImage[] {
	const message = messages[latestUserIndex];
	if (!message || message.role !== "user" || typeof message.content === "string") return [];
	return message.content.flatMap((block) =>
		isImageBlock(block) && block.data && block.mimeType ? [{ data: block.data, mimeType: block.mimeType }] : []);
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

/**
 * Replay bodies are capped on bootstrap only. An incremental send carries the
 * unsynced tail verbatim, and a summary prompt is the summarization request
 * itself, so neither truncates.
 */
function formatToolCall(toolCall: ToolCall, capToolBodies: boolean): string {
	const args = JSON.stringify(toolCall.arguments) ?? "";
	const body = capToolBodies ? capToolCallBody(toolCall.name, args) : args;
	return `Historical tool request (${getCursorReplayPromptLabel(toolCall.name)}, call ${toolCall.id}): ${body}`;
}

function sanitizeSystemPromptForCursor(systemPrompt: string): string {
	let sanitized = systemPrompt;
	// Pi wraps its built-in tool catalog and rules in XML sections.
	sanitized = sanitized.replace(
		/<tools>\n[\s\S]*?\n\nAdditional tools may be available\.\n<\/tools>/g,
		"Pi tool catalog omitted: Cursor can call only Cursor SDK tools exposed in this run.",
	);
	sanitized = sanitized.replace(
		/<rules>\n[\s\S]*?\n<\/rules>\n\n(?=<docs>\nPi documentation )/g,
		"<rules>\n- Be concise in your responses.\n- Show file paths clearly when working with files.\n</rules>\n\n",
	);
	// Keep the Agent Skills catalog. Cursor-specific skill activation wording is normalized
	// by cursor-skill-tool.ts before this prompt reaches the Cursor SDK provider.
	sanitized = sanitized.replace(/\n+Semantic code intelligence priority:[\s\S]*$/g, "");
	return sanitized.trim();
}

function formatMessage(msg: Message, capToolBodies = false): string | undefined {
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
					textParts.push(formatToolCall(block, capToolBodies));
				}
				// Omit thinking content from transcript
			}
			return textParts.length > 0 ? `Assistant: ${textParts.join("\n")}` : undefined;
		}
		case "toolResult": {
			const text = formatContentBlocks(msg.content);
			const body = capToolBodies ? capHistoricalToolBody(text, CURSOR_HISTORICAL_TOOL_BODY_MAX_CHARS) : text;
			const label = msg.isError ? "Historical tool error" : "Historical tool result";
			return `${label} (${getCursorReplayPromptLabel(msg.toolName)}, call ${msg.toolCallId}): ${body}`;
		}
	}
}

function getLatestUserMessageIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

export function getCursorPendingInput(messages: Message[], nativeSourceRoles: readonly string[]) {
	const start = messages.findLastIndex((message) => message.role === "assistant") + 1;
	const latestUserIndex = nativeSourceRoles.findLastIndex((role, index) => index >= start && role === "user");
	return { start, latestUserIndex };
}

function formatPromptMessage(
	message: Message,
	index: number,
	nativeSourceRoles?: readonly string[],
	capToolBodies = false,
): string | undefined {
	if (message.role === "user" && nativeSourceRoles && nativeSourceRoles[index] !== "user") {
		const text = formatContentBlocks(message.content);
		return text ? `Background context: ${text}` : undefined;
	}
	return formatMessage(message, capToolBodies);
}

function getSectionCost(section: string): number {
	return section.length + SECTION_SEPARATOR.length;
}

function applyPromptBudget(
	sectionsBeforeMessages: string[],
	messageSections: Array<{ index: number; text: string }>,
	sectionsAfterMessages: string[],
	requiredMessageIndexes: readonly number[],
	options: CursorPromptOptions,
): string[] {
	const maxInputTokens = options.maxInputTokens;
	if (maxInputTokens === undefined || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
		return [...sectionsBeforeMessages, ...messageSections.map((section) => section.text), ...sectionsAfterMessages];
	}

	const charsPerToken = options.charsPerToken ?? CURSOR_APPROX_CHARS_PER_TOKEN;
	const maxChars = Math.max(1, Math.floor(maxInputTokens * charsPerToken));
	const requiredMessageSections = messageSections.filter((section) => requiredMessageIndexes.includes(section.index));
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
		default:
			// System messages are handled by serializeRawPiMessageForFingerprint.
			throw new Error("Unsupported Pi message role in Cursor context fingerprint.");
	}
}

function serializeRawPiMessageForFingerprint(message: Context["messages"][number], index: number): string {
	const role = (message as { role?: string }).role;
	switch (role) {
		case "system": {
			const entry = message as {
				content: unknown; sections?: unknown; toolsAdded?: unknown; toolsRemoved?: unknown;
			};
			return hashCursorContextValue(JSON.stringify({
				role, content: entry.content, sections: entry.sections,
				toolsAdded: entry.toolsAdded, toolsRemoved: entry.toolsRemoved,
			}));
		}
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
		systemHash: hashCursorContextValue(JSON.stringify(resolveCursorPiContext(context))),
		messageHashes: context.messages.map((message, index) => serializeRawPiMessageForFingerprint(message, index)),
	};
	return JSON.stringify(payload);
}

/**
 * Context-only check for standalone boolean/fingerprint snapshots, independent of pooled-agent send state.
 * planCursorSessionSend() owns pooled-agent state narrowing; standalone snapshots may be unbootstrapped.
 */
export function shouldBootstrapCursorContext(
	sendState: { bootstrapped: boolean; contextFingerprint: string },
	context: Context,
	nativeSourceRoles?: readonly string[],
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
	const appended = normalizePiContextMessages(context.messages.slice(previous.messageHashes.length));
	if (nativeSourceRoles) {
		const messages = normalizePiContextMessages(context.messages);
		const offset = messages.length - appended.length;
		// Native summaries invalidate the pool; other pending input travels together.
		if (nativeSourceRoles.slice(offset).some((role) => role === "branchSummary" || role === "compactionSummary")) return true;
		const { start } = getCursorPendingInput(messages, nativeSourceRoles);
		return appended.some((message, index) => message.role === "user" && offset + index < start);
	}
	// Without native origin, an incremental prompt carries only the final user.
	const appendedUsers = appended.filter((message) => message.role === "user");
	return appended.length > 0 && (appendedUsers.length !== 1 || appended.at(-1)?.role !== "user");
}

/** @deprecated Use planCursorSessionSend() for send mode and shouldBootstrapCursorContext() for context-only checks. */
export function shouldBootstrapCursorSend(
	sendState: { bootstrapped: boolean; contextFingerprint: string },
	context: Context,
): boolean {
	return shouldBootstrapCursorContext(sendState, context);
}

export function buildCursorIncrementalPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	// Incremental sends omit Pi system instructions and the full tool boundary; the session agent retains both from bootstrap.
	const messages = normalizePiContextMessages(context.messages);
	const pending = options.nativeSourceRoles && getCursorPendingInput(messages, options.nativeSourceRoles);
	const latestUserMessageIndex = pending ? pending.latestUserIndex : getLatestUserMessageIndex(messages);
	const latestUserMessage = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex] : undefined;
	const latestUserText = latestUserMessage ? formatMessage(latestUserMessage) : undefined;
	const sectionsBeforeMessages = [
		"Continue the conversation using Cursor SDK capabilities only. Do not list, promise, or call pi-only tools from earlier context as if they were available.",
	];
	const latestUserMessageSections = pending
		? messages.flatMap((message, index) => {
			const text = index >= pending.start ? formatPromptMessage(message, index, options.nativeSourceRoles, false) : undefined;
			return text ? [{ index, text }] : [];
		})
		: latestUserText && latestUserMessageIndex >= 0 ? [{ index: latestUserMessageIndex, text: latestUserText }] : [];
	const images = extractLatestImages(messages, latestUserMessageIndex);
	const imageTokenReserve = images.length * (options.imageTokenEstimate ?? 0);
	const budgetOptions =
		options.maxInputTokens === undefined
			? options
			: { ...options, maxInputTokens: Math.max(1, options.maxInputTokens - imageTokenReserve) };
	const parts = applyPromptBudget(
		sectionsBeforeMessages,
		latestUserMessageSections,
		[getCursorToolTailGuardText(options)],
		latestUserMessageSections.map((section) => section.index),
		budgetOptions,
	);
	return { text: parts.join(SECTION_SEPARATOR), images };
}

/** Native compaction/tree instructions are already a complete summarization request. */
export function buildCursorSummaryPrompt(context: Context): CursorPrompt {
	const { systemPrompt } = resolveCursorPiContext(context);
	// A summary request must see the untruncated transcript it is asked to summarize.
	const sections = normalizePiContextMessages(context.messages).map((message) => formatMessage(message)).filter((text): text is string => text !== undefined);
	if (systemPrompt) sections.unshift(`System instructions from pi:\n${systemPrompt}`);
	return { text: sections.join(SECTION_SEPARATOR), images: [] };
}

export function buildCursorPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	const sectionsBeforeMessages: string[] = [getCursorToolBoundaryText({
		agentMode: options.agentMode,
		hasToolManifest: Boolean(options.toolManifest),
		includePiBridgeGuidance: options.includePiBridgeGuidance,
		nativeToolsEnabled: options.nativeToolsEnabled,
		includePiAskQuestionGuidance: options.includePiAskQuestionGuidance,
	})];
	if (options.toolManifest) {
		sectionsBeforeMessages.push(options.toolManifest);
	}

	const { systemPrompt } = resolveCursorPiContext(context);
	if (systemPrompt) {
		sectionsBeforeMessages.push(`System instructions from pi:\n${sanitizeSystemPromptForCursor(systemPrompt)}`);
	}

	const messages = normalizePiContextMessages(context.messages);
	const messageSections = messages
		.map((msg, index) => {
			const text = formatPromptMessage(msg, index, options.nativeSourceRoles, true);
			return text ? { index, text } : undefined;
		})
		.filter((section): section is { index: number; text: string } => section !== undefined);
	const pending = options.nativeSourceRoles && getCursorPendingInput(messages, options.nativeSourceRoles);
	const sectionsAfterMessages = getCursorBootstrapTailSections(options, !pending || pending.latestUserIndex >= 0);
	const images = extractLatestImages(messages, pending ? pending.latestUserIndex : getLatestUserMessageIndex(messages));
	const imageTokenReserve = images.length * (options.imageTokenEstimate ?? 0);
	const budgetOptions =
		options.maxInputTokens === undefined
			? options
			: { ...options, maxInputTokens: Math.max(1, options.maxInputTokens - imageTokenReserve) };
	const parts = applyPromptBudget(
		sectionsBeforeMessages,
		messageSections,
		sectionsAfterMessages,
		pending ? messageSections.filter((section) => section.index >= pending.start).map((section) => section.index)
			: [getLatestUserMessageIndex(messages)],
		budgetOptions,
	);
	const text = parts.join(SECTION_SEPARATOR);

	return { text, images };
}
