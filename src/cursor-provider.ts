import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Agent, createAgentPlatform } from "@cursor/sdk";
import type { InteractionUpdate, SDKAgent, SettingSource } from "@cursor/sdk";
import { buildCursorPrompt, type CursorPrompt } from "./context.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, mergeCursorToolCalls } from "./cursor-tool-transcript.js";
import {
	canRenderCursorToolNatively,
	isCursorNativeToolDisplayRuntimeEnabled,
	deleteCursorNativeToolDisplay,
	recordCursorNativeToolDisplay,
	type CursorNativeToolDisplayItem,
} from "./cursor-native-tool-display.js";

function makeInitialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

class CursorAbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "CursorAbortError";
	}
}

const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
const MISSING_API_KEY_MESSAGE =
	"Cursor SDK runs require a Cursor API key. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.";
const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed. The API key may be missing, invalid, or unauthorized. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed because the API key may be invalid or unauthorized. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const APPROX_CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;
const CURSOR_ACTIVITY_TRACE_MAX_CHARS = 50000;
const DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS = 5 * 60 * 1000;
const CURSOR_NATIVE_REPLAY_TOOL_ID_PATTERN = /^(cursor-replay-\d+-\d+)-tool-\d+$/;
const CURSOR_SETTING_SOURCES_ENV = "PI_CURSOR_SETTING_SOURCES";

type CursorNativeQueuedEvent =
	| { type: "thinking-delta"; text: string }
	| { type: "thinking-completed" }
	| { type: "text-delta"; text: string }
	| { type: "tool"; tool: CursorNativeToolDisplayItem };

interface CursorNativeLiveRun {
	id: string;
	agent: SDKAgent;
	promptInputTokens: number;
	promptInputTokensReported: boolean;
	pendingEvents: CursorNativeQueuedEvent[];
	textDeltas: string[];
	recordedToolDisplayIds: string[];
	finalText?: string;
	done: boolean;
	cancelled: boolean;
	disposed: boolean;
	errorMessage?: string;
	idleDisposeTimer?: ReturnType<typeof setTimeout>;
	waiters: Set<() => void>;
}

interface CursorNativeTurnState {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	thinkingContentIndex: number;
	textContentIndex: number;
}

let cursorNativeReplayCounter = 0;
let cursorNativeReplayIdleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
const pendingCursorNativeRuns = new Map<string, CursorNativeLiveRun>();

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubSensitiveText(text: string, apiKey?: string): string {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) {
		scrubbed = scrubbed.replace(new RegExp(escapeRegExp(trimmedKey), "g"), "[redacted]");
	}
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
			"$1[redacted]",
		);
}

function isGenericErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === "error" || normalized === "unknown error";
}

function isLikelyAuthError(message: string): boolean {
	return /\b(unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (trimmed === CURSOR_API_KEY_ENV_VAR) return process.env.CURSOR_API_KEY?.trim();
	return trimmed;
}

function resolveCursorSettingSources(): SettingSource[] | undefined {
	const raw = process.env[CURSOR_SETTING_SOURCES_ENV]?.trim();
	if (!raw) return undefined;
	const normalized = raw.toLowerCase();
	if (["0", "false", "off", "none", "omit", "disabled"].includes(normalized)) return undefined;
	if (["1", "true", "on", "all"].includes(normalized)) return ["all"];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry): entry is SettingSource => Boolean(entry));
}

function sanitizeError(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message === MISSING_API_KEY_MESSAGE) return MISSING_API_KEY_MESSAGE;
	const scrubbed = scrubSensitiveText(message, apiKey).trim();
	if (isGenericErrorMessage(scrubbed)) return GENERIC_CURSOR_SDK_ERROR_MESSAGE;
	if (isLikelyAuthError(scrubbed)) return AUTH_CURSOR_SDK_ERROR_MESSAGE;
	return scrubbed || GENERIC_CURSOR_SDK_ERROR_MESSAGE;
}

function getObjectField(value: unknown, field: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[field];
}

function getCursorToolName(toolCall: unknown): string {
	if (!toolCall || typeof toolCall !== "object") return "unknown";
	const data = toolCall as Record<string, unknown>;
	if (typeof data.name === "string") return data.name;
	if (typeof data.type === "string") return data.type;
	return "unknown";
}

async function cacheSdkContextWindow(agentId: string, modelId: string): Promise<void> {
	try {
		const platform = await createAgentPlatform();
		const checkpoint = await platform.checkpointStore.loadLatest(agentId);
		const contextWindow = getCheckpointContextWindow(checkpoint);
		if (contextWindow) saveCachedContextWindow(modelId, contextWindow);
	} catch {
		// Context-window cache failures must not affect response streaming.
	}
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function estimatePromptInputTokens(prompt: CursorPrompt): number {
	return estimateTextTokens(prompt.text) + prompt.images.length * IMAGE_TOKEN_ESTIMATE;
}

function getPromptInputTokenBudget(model: Model<Api>): number {
	const outputReserveTokens = Math.min(model.maxTokens, Math.max(1, Math.floor(model.contextWindow * 0.2)));
	return Math.max(1, model.contextWindow - outputReserveTokens);
}

function setApproximateUsage(partial: AssistantMessage, promptInputTokens: number, outputText: string): void {
	partial.usage.input = promptInputTokens;
	partial.usage.output = estimateTextTokens(outputText);
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	partial.usage.totalTokens = partial.usage.input + partial.usage.output;
}

function sanitizeSingleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateSingleLine(value: string, maxLength = 240): string {
	const sanitized = sanitizeSingleLine(value);
	return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength - 1)}…` : sanitized;
}

function formatCursorToolName(toolCall: unknown): string {
	return truncateSingleLine(getCursorToolName(toolCall), 80) || "unknown";
}

function hasUsableText(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function scrubDisplayValue(value: unknown, apiKey?: string): unknown {
	if (typeof value === "string") return scrubSensitiveText(value, apiKey);
	if (Array.isArray(value)) return value.map((entry) => scrubDisplayValue(entry, apiKey));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDisplayValue(entry, apiKey)]));
	}
	return value;
}

function createCursorNativeReplayId(): string {
	cursorNativeReplayCounter += 1;
	return `cursor-replay-${Date.now()}-${cursorNativeReplayCounter}`;
}

function getCursorNativeReplayIdFromToolCallId(toolCallId: string): string | undefined {
	return CURSOR_NATIVE_REPLAY_TOOL_ID_PATTERN.exec(toolCallId)?.[1];
}

function getPendingCursorNativeReplayId(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "toolResult") break;
		const replayId = getCursorNativeReplayIdFromToolCallId(message.toolCallId);
		if (replayId && pendingCursorNativeRuns.has(replayId)) return replayId;
	}
	return undefined;
}

function splitTextIntoReplayDeltas(text: string): string[] {
	const deltas: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= 96) {
			deltas.push(remaining);
			break;
		}
		const boundary = Math.max(48, remaining.lastIndexOf(" ", 96));
		deltas.push(remaining.slice(0, boundary));
		remaining = remaining.slice(boundary);
	}
	return deltas;
}

async function emitTextDeltas(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	deltas: string[],
): Promise<string> {
	if (deltas.length === 0) return "";
	const contentIndex = partial.content.length;
	partial.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex, partial });
	const block = partial.content[contentIndex];
	if (block.type !== "text") return "";
	for (const delta of deltas) {
		block.text += delta;
		stream.push({ type: "text_delta", contentIndex, delta, partial });
		await Promise.resolve();
	}
	stream.push({ type: "text_end", contentIndex, content: block.text, partial });
	return block.text;
}

function notifyCursorNativeRun(run: CursorNativeLiveRun): void {
	for (const waiter of run.waiters) waiter();
	run.waiters.clear();
}

function queueCursorNativeEvent(run: CursorNativeLiveRun, event: CursorNativeQueuedEvent): void {
	run.pendingEvents.push(event);
	notifyCursorNativeRun(run);
}

function clearCursorNativeRunIdleDispose(run: CursorNativeLiveRun): void {
	if (!run.idleDisposeTimer) return;
	clearTimeout(run.idleDisposeTimer);
	run.idleDisposeTimer = undefined;
}

function scheduleCursorNativeRunIdleDispose(run: CursorNativeLiveRun): void {
	if (run.disposed) return;
	clearCursorNativeRunIdleDispose(run);
	run.idleDisposeTimer = setTimeout(() => {
		void disposeCursorNativeRun(run);
	}, cursorNativeReplayIdleDisposeMs);
	run.idleDisposeTimer.unref?.();
}

function isCursorNativeRunReady(run: CursorNativeLiveRun): boolean {
	return run.pendingEvents.length > 0 || run.done || run.cancelled || run.errorMessage !== undefined;
}

async function waitForCursorNativeRunProgress(run: CursorNativeLiveRun, signal?: AbortSignal): Promise<void> {
	if (isCursorNativeRunReady(run)) return;
	await new Promise<void>((resolve, reject) => {
		let waiter: (() => void) | undefined;
		const cleanup = (): void => {
			if (waiter) run.waiters.delete(waiter);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			cleanup();
			reject(new CursorAbortError());
		};
		waiter = (): void => {
			cleanup();
			resolve();
		};
		run.waiters.add(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function settleCursorNativeToolBatch(run: CursorNativeLiveRun): Promise<void> {
	if (run.pendingEvents[0]?.type !== "tool") return;
	await new Promise((resolve) => setTimeout(resolve, 75));
}

function closeCursorNativeThinkingBlock(turn: CursorNativeTurnState): void {
	if (turn.thinkingContentIndex < 0) return;
	const block = turn.partial.content[turn.thinkingContentIndex];
	if (block.type === "thinking") {
		turn.stream.push({
			type: "thinking_end",
			contentIndex: turn.thinkingContentIndex,
			content: block.thinking,
			partial: turn.partial,
		});
	}
	turn.thinkingContentIndex = -1;
}

function closeCursorNativeTextBlock(turn: CursorNativeTurnState): string {
	if (turn.textContentIndex < 0) return "";
	const contentIndex = turn.textContentIndex;
	const block = turn.partial.content[contentIndex];
	turn.textContentIndex = -1;
	if (block.type !== "text") return "";
	turn.stream.push({
		type: "text_end",
		contentIndex,
		content: block.text,
		partial: turn.partial,
	});
	return block.text;
}

function closeCursorNativeTurnBlocks(turn: CursorNativeTurnState): string {
	closeCursorNativeThinkingBlock(turn);
	return closeCursorNativeTextBlock(turn);
}

function emitCursorNativeThinkingDelta(turn: CursorNativeTurnState, delta: string): void {
	closeCursorNativeTextBlock(turn);
	if (turn.thinkingContentIndex < 0) {
		turn.thinkingContentIndex = turn.partial.content.length;
		turn.partial.content.push({ type: "thinking", thinking: "" });
		turn.stream.push({ type: "thinking_start", contentIndex: turn.thinkingContentIndex, partial: turn.partial });
	}
	const block = turn.partial.content[turn.thinkingContentIndex];
	if (block.type !== "thinking") return;
	block.thinking += delta;
	turn.stream.push({ type: "thinking_delta", contentIndex: turn.thinkingContentIndex, delta, partial: turn.partial });
}

function emitCursorNativeTextDelta(turn: CursorNativeTurnState, delta: string): void {
	closeCursorNativeThinkingBlock(turn);
	if (turn.textContentIndex < 0) {
		turn.textContentIndex = turn.partial.content.length;
		turn.partial.content.push({ type: "text", text: "" });
		turn.stream.push({ type: "text_start", contentIndex: turn.textContentIndex, partial: turn.partial });
	}
	const block = turn.partial.content[turn.textContentIndex];
	if (block.type !== "text") return;
	block.text += delta;
	turn.stream.push({ type: "text_delta", contentIndex: turn.textContentIndex, delta, partial: turn.partial });
}

function emitCursorNativeQueuedEvent(
	turn: CursorNativeTurnState,
	event: Exclude<CursorNativeQueuedEvent, { type: "tool" }>,
): void {
	if (event.type === "thinking-delta") {
		emitCursorNativeThinkingDelta(turn, event.text);
	} else if (event.type === "thinking-completed") {
		closeCursorNativeThinkingBlock(turn);
	} else if (event.type === "text-delta") {
		emitCursorNativeTextDelta(turn, event.text);
	}
}

function collectCursorNativeToolBatch(run: CursorNativeLiveRun): CursorNativeToolDisplayItem[] {
	const tools: CursorNativeToolDisplayItem[] = [];
	while (run.pendingEvents[0]?.type === "tool") {
		const event = run.pendingEvents.shift();
		if (event?.type === "tool") tools.push(event.tool);
	}
	return tools;
}

function takeCursorNativePromptInputTokens(run: CursorNativeLiveRun): number {
	// Native replay can split one Cursor run into multiple pi turns; count prompt input once.
	if (run.promptInputTokensReported) return 0;
	run.promptInputTokensReported = true;
	return run.promptInputTokens;
}

function emitCursorNativeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: CursorNativeLiveRun,
	tools: CursorNativeToolDisplayItem[],
	outputText: string,
): void {
	const shouldTerminate = run.done && !run.finalText?.trim() && run.pendingEvents.length === 0;
	for (const tool of tools) {
		const contentIndex = partial.content.length;
		partial.content.push({
			type: "toolCall",
			id: tool.id,
			name: tool.toolName,
			arguments: tool.args,
		});
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(tool.args), partial });
		const block = partial.content[contentIndex];
		if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		if (recordCursorNativeToolDisplay({ ...tool, terminate: shouldTerminate })) {
			run.recordedToolDisplayIds.push(tool.id);
		}
	}
	setApproximateUsage(partial, takeCursorNativePromptInputTokens(run), outputText);
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	scheduleCursorNativeRunIdleDispose(run);
}

async function disposeCursorNativeRun(run: CursorNativeLiveRun): Promise<void> {
	if (run.disposed) return;
	run.disposed = true;
	pendingCursorNativeRuns.delete(run.id);
	clearCursorNativeRunIdleDispose(run);
	for (const toolDisplayId of run.recordedToolDisplayIds) deleteCursorNativeToolDisplay(toolDisplayId);
	run.recordedToolDisplayIds = [];
	run.waiters.clear();
	try {
		await run.agent[Symbol.asyncDispose]();
	} catch {
		// disposal failure should not mask the provider result
	}
}

async function emitCursorNativeRunNextTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: CursorNativeLiveRun,
	signal?: AbortSignal,
): Promise<void> {
	const turn: CursorNativeTurnState = {
		stream,
		partial,
		thinkingContentIndex: -1,
		textContentIndex: -1,
	};

	while (true) {
		while (run.pendingEvents.length > 0) {
			const event = run.pendingEvents[0];
			if (event.type === "tool") {
				await settleCursorNativeToolBatch(run);
				const outputText = closeCursorNativeTurnBlocks(turn);
				const tools = collectCursorNativeToolBatch(run);
				emitCursorNativeToolUseTurn(stream, partial, run, tools, outputText);
				return;
			}
			run.pendingEvents.shift();
			emitCursorNativeQueuedEvent(turn, event);
		}

		if (run.cancelled) {
			partial.stopReason = "aborted";
			stream.push({ type: "error", reason: "aborted", error: partial });
			await disposeCursorNativeRun(run);
			return;
		}
		if (run.errorMessage) {
			partial.stopReason = "error";
			partial.errorMessage = run.errorMessage;
			stream.push({ type: "error", reason: "error", error: partial });
			await disposeCursorNativeRun(run);
			return;
		}
		if (run.done) {
			let outputText = closeCursorNativeTurnBlocks(turn);
			if (!outputText) {
				outputText += await emitTextDeltas(stream, partial, splitTextIntoReplayDeltas(run.finalText ?? run.textDeltas.join("")));
			}
			setApproximateUsage(partial, takeCursorNativePromptInputTokens(run), outputText);
			partial.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: partial });
			await disposeCursorNativeRun(run);
			return;
		}

		await waitForCursorNativeRunProgress(run, signal);
	}
}

async function replayPendingCursorNativeRun(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	context: Context,
	signal?: AbortSignal,
): Promise<boolean> {
	const replayId = getPendingCursorNativeReplayId(context);
	if (!replayId) return false;
	const run = pendingCursorNativeRuns.get(replayId);
	if (!run) return false;
	clearCursorNativeRunIdleDispose(run);
	try {
		await emitCursorNativeRunNextTurn(stream, partial, run, signal);
	} catch (error) {
		if (error instanceof CursorAbortError) await disposeCursorNativeRun(run);
		throw error;
	}
	return true;
}

export function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const partial = makeInitialMessage(model);
		let agent: SDKAgent | null = null;
		let activeNativeRun: CursorNativeLiveRun | undefined;
		let resolvedApiKey: string | undefined;
		let abortSignal: AbortSignal | undefined;
		let abortListener: (() => void) | undefined;

		try {
			const throwIfAborted = (): void => {
				if (options?.signal?.aborted) throw new CursorAbortError();
			};

			stream.push({ type: "start", partial });
			throwIfAborted();

			if (await replayPendingCursorNativeRun(stream, partial, context, options?.signal)) {
				stream.end();
				return;
			}

			const apiKey = resolveCursorApiKey(options?.apiKey);
			if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE);
			resolvedApiKey = apiKey;

			// pi-ai Context/SimpleStreamOptions do not currently expose ExtensionContext.cwd;
			// provider calls use the process cwd until pi exposes a session cwd to streamSimple.
			const cwd = process.cwd();
			const fastEnabled = getEffectiveFastForModelId(model.id);
			const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
			const settingSources = resolveCursorSettingSources();

			agent = await Agent.create({
				apiKey,
				model: selection,
				local: settingSources ? { cwd, settingSources } : { cwd },
			});
			throwIfAborted();

			const prompt = buildCursorPrompt(context, {
				maxInputTokens: getPromptInputTokenBudget(model),
				charsPerToken: APPROX_CHARS_PER_TOKEN,
				imageTokenEstimate: IMAGE_TOKEN_ESTIMATE,
			});
			const promptInputTokens = estimatePromptInputTokens(prompt);
			let thinkingContentIndex = -1;
			let activityTraceChars = 0;
			let activityTraceTruncated = false;
			let nativeToolDisplayCounter = 0;
			let textContentIndex = -1;
			const useNativeToolReplay = isCursorNativeToolDisplayRuntimeEnabled();
			const nativeReplayId = createCursorNativeReplayId();
			const textDeltas: string[] = [];
			let nativeToolReplayStarted = false;
			const liveRun: CursorNativeLiveRun | undefined = useNativeToolReplay
				? {
						id: nativeReplayId,
						agent,
						promptInputTokens,
						promptInputTokensReported: false,
						pendingEvents: [],
						textDeltas,
						recordedToolDisplayIds: [],
						done: false,
						cancelled: false,
						disposed: false,
						waiters: new Set(),
					}
				: undefined;
			if (liveRun) {
				pendingCursorNativeRuns.set(liveRun.id, liveRun);
				activeNativeRun = liveRun;
			}
			const startedToolCalls = new Map<string, unknown>();
			const completedToolIdentities = new Set<string>();
			const completedStartedToolFingerprints = new Set<string>();
			const completedFallbackToolFingerprints = new Set<string>();

			const appendLiveTextDelta = (text: string): void => {
				if (textContentIndex < 0) {
					textContentIndex = partial.content.length;
					partial.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: textContentIndex, partial });
				}
				const block = partial.content[textContentIndex];
				if (block.type !== "text") return;
				block.text += text;
				stream.push({
					type: "text_delta",
					contentIndex: textContentIndex,
					delta: text,
					partial,
				});
			};

			const appendTraceDelta = (text: string): void => {
				if (activityTraceTruncated) return;

				let delta = text;
				if (activityTraceChars + delta.length > CURSOR_ACTIVITY_TRACE_MAX_CHARS) {
					const remainingChars = Math.max(CURSOR_ACTIVITY_TRACE_MAX_CHARS - activityTraceChars, 0);
					delta = `${delta.slice(0, remainingChars)}\n[Cursor activity trace truncated]\n`;
					activityTraceTruncated = true;
				}
				if (!delta) return;

				if (thinkingContentIndex < 0) {
					thinkingContentIndex = partial.content.length;
					partial.content.push({ type: "thinking", thinking: "" });
					stream.push({ type: "thinking_start", contentIndex: thinkingContentIndex, partial });
				}
				const block = partial.content[thinkingContentIndex];
				if (block.type === "thinking") {
					block.thinking += delta;
					activityTraceChars += delta.length;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingContentIndex,
						delta,
						partial,
					});
				}
			};

			const appendTraceLine = (text: string): void => {
				appendTraceDelta(`${text}\n`);
			};

			const appendTraceBlock = (text: string): void => {
				closeTraceBlock();
				appendTraceDelta(text.endsWith("\n") ? text : `${text}\n`);
				closeTraceBlock();
			};

			const closeTraceBlock = (): void => {
				if (thinkingContentIndex < 0) return;
				const block = partial.content[thinkingContentIndex];
				if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingContentIndex,
						content: block.thinking,
						partial,
					});
				}
				thinkingContentIndex = -1;
			};

			const flushText = (deltas: string[]): string => {
				for (const delta of deltas) appendLiveTextDelta(delta);
				if (textContentIndex < 0) return "";
				const block = partial.content[textContentIndex];
				if (block.type !== "text") return "";
				stream.push({
					type: "text_end",
					contentIndex: textContentIndex,
					content: block.text,
					partial,
				});
				return block.text;
			};

			const getToolFingerprint = (value: unknown): string => {
				try {
					return JSON.stringify(value);
				} catch {
					return String(value);
				}
			};

			const handleCompletedToolCall = (
				toolCall: unknown,
				options: { identity?: string; source?: "started" | "fallback" } = {},
			): void => {
				const transcript = scrubSensitiveText(formatCursorToolTranscript(toolCall, { cwd }), resolvedApiKey);
				const display = buildCursorPiToolDisplay(toolCall, { cwd });
				const fingerprint = getToolFingerprint({ toolName: display.toolName, args: display.args, result: display.result });
				if (options.identity && completedToolIdentities.has(options.identity)) return;
				if (options.source === "started") {
					if (completedFallbackToolFingerprints.has(fingerprint)) return;
				} else if (completedStartedToolFingerprints.has(fingerprint) || completedFallbackToolFingerprints.has(fingerprint)) {
					return;
				}
				if (options.identity) completedToolIdentities.add(options.identity);
				if (options.source === "started") {
					completedStartedToolFingerprints.add(fingerprint);
				} else {
					completedFallbackToolFingerprints.add(fingerprint);
				}

				if (useNativeToolReplay && canRenderCursorToolNatively(display.toolName) && liveRun) {
					nativeToolReplayStarted = true;
					const id = `${nativeReplayId}-tool-${++nativeToolDisplayCounter}`;
					queueCursorNativeEvent(liveRun, {
						type: "tool",
						tool: {
							...display,
							id,
							args: scrubDisplayValue(display.args, resolvedApiKey) as Record<string, unknown>,
							result: scrubDisplayValue(display.result, resolvedApiKey) as typeof display.result,
						},
					});
					return;
				}

				appendTraceBlock(transcript || `Cursor tool: ${formatCursorToolName(toolCall)} completed`);
			};

			const onDelta = (args: { update: InteractionUpdate }): void => {
				const update = args.update;

				if (update.type === "text-delta") {
					textDeltas.push(update.text);
					if (liveRun) {
						queueCursorNativeEvent(liveRun, { type: "text-delta", text: update.text });
					} else if (!useNativeToolReplay) {
						appendLiveTextDelta(update.text);
					}
				} else if (update.type === "thinking-delta") {
					if (liveRun) {
						queueCursorNativeEvent(liveRun, { type: "thinking-delta", text: update.text });
					} else {
						appendTraceDelta(update.text);
					}
				} else if (update.type === "thinking-completed") {
					if (liveRun) {
						queueCursorNativeEvent(liveRun, { type: "thinking-completed" });
					} else {
						closeTraceBlock();
					}
				} else if (update.type === "tool-call-started") {
					startedToolCalls.set(update.callId, update.toolCall);
				} else if (update.type === "tool-call-completed") {
					const mergedToolCall = mergeCursorToolCalls(startedToolCalls.get(update.callId), update.toolCall);
					startedToolCalls.delete(update.callId);
					const identity = typeof update.callId === "string" ? `cursor-tool:${update.callId}` : undefined;
					handleCompletedToolCall(mergedToolCall, {
						identity,
						source: identity ? "started" : "fallback",
					});
				} else if (update.type === "summary") {
					const summary = `Cursor summary: ${truncateSingleLine(update.summary)}\n`;
					if (liveRun) {
						queueCursorNativeEvent(liveRun, { type: "thinking-delta", text: summary });
					} else {
						appendTraceDelta(summary);
					}
				}
				// Cursor turn-ended usage is intentionally not copied into pi usage: the SDK reports
				// cumulative internal agent/tool/cache tokens, not the replayable pi prompt context.
				// partial-tool-call, summary-started, summary-completed, turn-ended,
				// shell-output-delta, token-delta, step-* are intentionally not surfaced.
			};

			const onStep = (args: { step: unknown }): void => {
				const step = getObjectField(args.step, "message") ? args.step : undefined;
				if (getObjectField(args.step, "type") !== "toolCall") return;
				const toolCall = getObjectField(step, "message");
				const stepId = getObjectField(args.step, "id") ?? getObjectField(toolCall, "id") ?? getObjectField(toolCall, "callId");
				if (toolCall) {
					handleCompletedToolCall(toolCall, {
						identity: typeof stepId === "string" ? `cursor-tool:${stepId}` : undefined,
					});
				}
			};

			// Handle abort signal
			let run: Awaited<ReturnType<SDKAgent["send"]>> | null = null;
			abortListener = () => {
				if (run) {
					run.cancel().catch(() => {});
				}
			};
			abortSignal = options?.signal;
			abortSignal?.addEventListener("abort", abortListener, { once: true });

			throwIfAborted();
			run = await agent.send(
				{ text: prompt.text, images: prompt.images.length > 0 ? prompt.images : undefined },
				{ onDelta, onStep },
			);
			if (options?.signal?.aborted) {
				await run.cancel().catch(() => {});
				throw new CursorAbortError();
			}

			if (useNativeToolReplay && liveRun) {
				void run
					.wait()
					.then(async (result) => {
						if (liveRun.disposed) return;
						await cacheSdkContextWindow(liveRun.agent.agentId, model.id);
						if (liveRun.disposed) return;
						liveRun.cancelled = result.status === "cancelled";
						liveRun.finalText = hasUsableText(result.result) ? result.result : liveRun.textDeltas.join("");
						liveRun.done = true;
						notifyCursorNativeRun(liveRun);
						scheduleCursorNativeRunIdleDispose(liveRun);
					})
					.catch((error: unknown) => {
						if (liveRun.disposed) return;
						liveRun.errorMessage = sanitizeError(error, resolvedApiKey ?? options?.apiKey);
						notifyCursorNativeRun(liveRun);
						scheduleCursorNativeRunIdleDispose(liveRun);
					});

				try {
					await waitForCursorNativeRunProgress(liveRun, options?.signal);
					await settleCursorNativeToolBatch(liveRun);
					closeTraceBlock();
					await emitCursorNativeRunNextTurn(stream, partial, liveRun, options?.signal);
				} catch (error) {
					if (error instanceof CursorAbortError) await disposeCursorNativeRun(liveRun);
					throw error;
				}
				agent = null;
				return;
			}

			const result = await run.wait();
			await cacheSdkContextWindow(agent.agentId, model.id);

			// Close any open thinking/activity trace, then use the final run result only when
			// Cursor did not stream text deltas.
			closeTraceBlock();

			if (result.status === "cancelled") {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				const finalText = flushText(textDeltas.length === 0 && hasUsableText(result.result) ? [result.result] : []);
				setApproximateUsage(partial, promptInputTokens, finalText);
				stream.push({ type: "done", reason: "stop", message: partial });
			}
		} catch (error) {
			if (error instanceof CursorAbortError) {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				partial.stopReason = "error";
				partial.errorMessage = sanitizeError(error, resolvedApiKey ?? options?.apiKey);
				stream.push({ type: "error", reason: "error", error: partial });
			}
		} finally {
			if (activeNativeRun?.disposed) agent = null;

			if (abortSignal && abortListener) {
				abortSignal.removeEventListener("abort", abortListener);
			}

			if (agent) {
				try {
					await agent[Symbol.asyncDispose]();
				} catch {
					// disposal failure should not mask original error
				}
				agent = null;
			}
		}

		stream.end();
	})();

	return stream;
}

export const __testUtils = {
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	pendingCursorNativeRunCount: () => pendingCursorNativeRuns.size,
	setCursorNativeReplayIdleDisposeMs: (value: number) => {
		cursorNativeReplayIdleDisposeMs = value;
	},
	resetCursorNativeReplayIdleDisposeMs: () => {
		cursorNativeReplayIdleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
	},
};
