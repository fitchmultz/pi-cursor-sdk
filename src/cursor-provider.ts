import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, createAgentPlatform } from "@cursor/sdk";
import type { InteractionUpdate, SDKAgent, SettingSource } from "@cursor/sdk";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { buildCursorPrompt, type CursorPrompt } from "./context.js";
import {
	getRegisteredCursorPiToolBridge,
	type CursorPiBridgeToolRequest,
	type CursorPiToolBridgeRun,
} from "./cursor-pi-tool-bridge.js";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, getCursorCreatePlanText, mergeCursorToolCalls } from "./cursor-tool-transcript.js";
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
const cursorSdkOutputSuppression = new AsyncLocalStorage<boolean>();

type CursorLiveQueuedEvent =
	| { type: "thinking-delta"; text: string }
	| { type: "thinking-completed" }
	| { type: "text-delta"; text: string }
	| { type: "tool"; tool: CursorNativeToolDisplayItem }
	| { type: "bridge-tool"; request: CursorPiBridgeToolRequest };

interface CursorLiveRun {
	id: string;
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	promptInputTokens: number;
	promptInputTokensReported: boolean;
	pendingEvents: CursorLiveQueuedEvent[];
	textDeltas: string[];
	emittedText: string;
	recordedToolDisplayIds: string[];
	finalText?: string;
	done: boolean;
	cancelled: boolean;
	disposed: boolean;
	errorMessage?: string;
	idleDisposeTimer?: ReturnType<typeof setTimeout>;
	waiters: Set<() => void>;
}

interface CursorLiveTurnState {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	thinkingContentIndex: number;
	textContentIndex: number;
}

let cursorNativeReplayCounter = 0;
let cursorNativeReplayIdleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
const pendingCursorLiveRuns = new Map<string, CursorLiveRun>();

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
	if (!raw) return ["all"];
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

function isCursorSdkOutputSuppressed(): boolean {
	return cursorSdkOutputSuppression.getStore() === true;
}

function suppressCursorSdkOutput<T>(operation: () => Promise<T>): Promise<T> {
	return cursorSdkOutputSuppression.run(true, operation);
}

const CURSOR_SDK_STARTUP_NOISE_PATTERNS = [
	"managed_skills.",
	"CursorPluginsAgentSkillsService load completed",
	"LocalCursorRulesService load completed",
	"AgentSkillsCursorRulesService load completed",
];

function isCursorSdkStartupNoise(text: string): boolean {
	return CURSOR_SDK_STARTUP_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
}

function createFilteredProcessWrite<TWrite extends typeof process.stdout.write>(write: TWrite, stream: NodeJS.WriteStream): TWrite {
	return ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (isCursorSdkOutputSuppressed() || isCursorSdkStartupNoise(text)) {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}
		return write.call(stream, chunk as string, encodingOrCallback as BufferEncoding, callback);
	}) as TWrite;
}

function createFilteredConsoleMethod<TMethod extends typeof console.log>(method: TMethod): TMethod {
	return ((...args: Parameters<TMethod>): void => {
		const text = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
		if (isCursorSdkOutputSuppressed() || isCursorSdkStartupNoise(text)) return;
		method(...args);
	}) as TMethod;
}

function installCursorSdkOutputFilter(): () => void {
	const stdoutWrite = process.stdout.write;
	const stderrWrite = process.stderr.write;
	const consoleLog = console.log;
	const consoleInfo = console.info;
	const consoleWarn = console.warn;
	const consoleError = console.error;
	const consoleDebug = console.debug;
	process.stdout.write = createFilteredProcessWrite(stdoutWrite, process.stdout);
	process.stderr.write = createFilteredProcessWrite(stderrWrite, process.stderr) as typeof process.stderr.write;
	console.log = createFilteredConsoleMethod(consoleLog);
	console.info = createFilteredConsoleMethod(consoleInfo);
	console.warn = createFilteredConsoleMethod(consoleWarn);
	console.error = createFilteredConsoleMethod(consoleError);
	console.debug = createFilteredConsoleMethod(consoleDebug);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
		console.log = consoleLog;
		console.info = consoleInfo;
		console.warn = consoleWarn;
		console.error = consoleError;
		console.debug = consoleDebug;
	};
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
	if (typeof data.toolName === "string") return data.toolName;
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

interface CursorShellOutputDelta {
	stream: "stdout" | "stderr";
	data: string;
}

interface CursorShellOutputDeltas {
	stdout: string[];
	stderr: string[];
}

function isCursorShellToolCall(toolCall: unknown): boolean {
	const normalizedName = getCursorToolName(toolCall).replace(/\s+/g, " ").trim().toLowerCase();
	return normalizedName === "shell" || normalizedName === "run_terminal_cmd" || normalizedName === "terminal" || normalizedName === "bash";
}

function getCursorShellOutputDelta(update: InteractionUpdate): CursorShellOutputDelta | undefined {
	if (update.type !== "shell-output-delta") return undefined;
	const event = getObjectField(update, "event");
	const eventCase = getObjectField(event, "case");
	if (eventCase !== "stdout" && eventCase !== "stderr") return undefined;
	const value = getObjectField(event, "value");
	const data = getObjectField(value, "data");
	if (typeof data !== "string" || data.length === 0) return undefined;
	return { stream: eventCase, data };
}

function mergeShellOutputDeltasIntoCursorToolCall(toolCall: unknown, deltas: CursorShellOutputDeltas | undefined): unknown {
	if (!deltas) return toolCall;
	const stdout = deltas.stdout.join("");
	const stderr = deltas.stderr.join("");
	if (!hasUsableText(stdout) && !hasUsableText(stderr)) return toolCall;

	const toolRecord = toolCall && typeof toolCall === "object" && !Array.isArray(toolCall) ? (toolCall as Record<string, unknown>) : undefined;
	const result = getObjectField(toolRecord, "result");
	const resultRecord = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
	if (!toolRecord || !resultRecord || resultRecord.status !== "success") return toolCall;

	const value = getObjectField(resultRecord, "value");
	const valueRecord = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	const completedStdout = getObjectField(valueRecord, "stdout");
	const completedStderr = getObjectField(valueRecord, "stderr");
	if (hasUsableText(typeof completedStdout === "string" ? completedStdout : undefined)) return toolCall;
	if (hasUsableText(typeof completedStderr === "string" ? completedStderr : undefined)) return toolCall;

	return {
		...toolRecord,
		result: {
			...resultRecord,
			value: {
				...(valueRecord ?? {}),
				stdout,
				stderr,
			},
		},
	};
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

function getPendingCursorLiveRun(context: Context): CursorLiveRun | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "toolResult") break;
		const replayId = getCursorNativeReplayIdFromToolCallId(message.toolCallId);
		if (replayId) {
			const replayRun = pendingCursorLiveRuns.get(replayId);
			if (replayRun) return replayRun;
		}
		for (const run of pendingCursorLiveRuns.values()) {
			if (run.bridgeRun?.hasPendingPiToolCallId(message.toolCallId)) return run;
		}
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

function notifyCursorNativeRun(run: CursorLiveRun): void {
	for (const waiter of run.waiters) waiter();
	run.waiters.clear();
}

function queueCursorNativeEvent(run: CursorLiveRun, event: CursorLiveQueuedEvent): void {
	run.pendingEvents.push(event);
	notifyCursorNativeRun(run);
}

function clearCursorNativeRunIdleDispose(run: CursorLiveRun): void {
	if (!run.idleDisposeTimer) return;
	clearTimeout(run.idleDisposeTimer);
	run.idleDisposeTimer = undefined;
}

function scheduleCursorNativeRunIdleDispose(run: CursorLiveRun): void {
	if (run.disposed) return;
	clearCursorNativeRunIdleDispose(run);
	run.idleDisposeTimer = setTimeout(() => {
		void disposeCursorNativeRun(run);
	}, cursorNativeReplayIdleDisposeMs);
	run.idleDisposeTimer.unref?.();
}

function isCursorNativeRunReady(run: CursorLiveRun): boolean {
	return run.pendingEvents.length > 0 || run.done || run.cancelled || run.errorMessage !== undefined;
}

async function waitForCursorNativeRunProgress(run: CursorLiveRun, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new CursorAbortError();
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
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function settleCursorLiveToolBatch(run: CursorLiveRun): Promise<void> {
	const eventType = run.pendingEvents[0]?.type;
	if (eventType !== "tool" && eventType !== "bridge-tool") return;
	await new Promise((resolve) => setTimeout(resolve, 75));
}

function closeCursorNativeThinkingBlock(turn: CursorLiveTurnState): void {
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

function closeCursorNativeTextBlock(turn: CursorLiveTurnState): string {
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

function closeCursorNativeTurnBlocks(turn: CursorLiveTurnState): string {
	closeCursorNativeThinkingBlock(turn);
	return closeCursorNativeTextBlock(turn);
}

function emitCursorNativeThinkingDelta(turn: CursorLiveTurnState, delta: string): void {
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

function emitCursorNativeTextDelta(turn: CursorLiveTurnState, delta: string): void {
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

function emitCursorLiveQueuedEvent(
	turn: CursorLiveTurnState,
	event: Exclude<CursorLiveQueuedEvent, { type: "tool" } | { type: "bridge-tool" }>,
	run?: CursorLiveRun,
): void {
	if (event.type === "thinking-delta") {
		emitCursorNativeThinkingDelta(turn, event.text);
	} else if (event.type === "thinking-completed") {
		closeCursorNativeThinkingBlock(turn);
	} else if (event.type === "text-delta") {
		if (run) run.emittedText += event.text;
		emitCursorNativeTextDelta(turn, event.text);
	}
}

function collectCursorNativeToolBatch(run: CursorLiveRun): CursorNativeToolDisplayItem[] {
	const tools: CursorNativeToolDisplayItem[] = [];
	while (run.pendingEvents[0]?.type === "tool") {
		const event = run.pendingEvents.shift();
		if (event?.type === "tool") tools.push(event.tool);
	}
	return tools;
}

function collectCursorBridgeToolBatch(run: CursorLiveRun): CursorPiBridgeToolRequest[] {
	const requests: CursorPiBridgeToolRequest[] = [];
	while (run.pendingEvents[0]?.type === "bridge-tool") {
		const event = run.pendingEvents.shift();
		if (event?.type === "bridge-tool") requests.push(event.request);
	}
	return requests;
}

function trimAlreadyEmittedCursorText(text: string, emittedText: string): string {
	if (!text || !emittedText) return text;
	if (text === emittedText) return "";
	if (text.startsWith(emittedText)) return text.slice(emittedText.length);
	if (emittedText.endsWith(text)) return "";
	if (text.trim() === emittedText.trim()) return "";
	if (emittedText.trim().endsWith(text.trim())) return "";
	return text;
}

function selectCursorFinalText(
	resultText: unknown,
	textDeltas: readonly string[],
	emittedText: string,
	fallbackText?: string,
): string {
	const candidates = [typeof resultText === "string" ? resultText : undefined, fallbackText, textDeltas.join("")];
	for (const candidate of candidates) {
		if (!hasUsableText(candidate)) continue;
		const trimmedCandidate = trimAlreadyEmittedCursorText(candidate, emittedText);
		if (hasUsableText(trimmedCandidate)) return trimmedCandidate;
	}
	return "";
}

function takeCursorNativePromptInputTokens(run: CursorLiveRun): number {
	// Native replay can split one Cursor run into multiple pi turns; count prompt input once.
	if (run.promptInputTokensReported) return 0;
	run.promptInputTokensReported = true;
	return run.promptInputTokens;
}

function emitCursorNativeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: CursorLiveRun,
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

function emitCursorBridgeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: CursorLiveRun,
	requests: CursorPiBridgeToolRequest[],
	outputText: string,
): void {
	for (const request of requests) {
		const contentIndex = partial.content.length;
		partial.content.push({
			type: "toolCall",
			id: request.piToolCallId,
			name: request.piToolName,
			arguments: request.args,
		});
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(request.args), partial });
		const block = partial.content[contentIndex];
		if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
	}
	setApproximateUsage(partial, takeCursorNativePromptInputTokens(run), outputText);
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	scheduleCursorNativeRunIdleDispose(run);
}

async function disposeCursorNativeRun(run: CursorLiveRun): Promise<void> {
	if (run.disposed) return;
	run.disposed = true;
	pendingCursorLiveRuns.delete(run.id);
	clearCursorNativeRunIdleDispose(run);
	run.bridgeRun?.cancel("Cursor live run disposed");
	for (const toolDisplayId of run.recordedToolDisplayIds) deleteCursorNativeToolDisplay(toolDisplayId);
	run.recordedToolDisplayIds = [];
	run.waiters.clear();
	try {
		await run.bridgeRun?.dispose();
	} catch {
		// bridge disposal failure should not mask the provider result
	}
	try {
		await run.agent[Symbol.asyncDispose]();
	} catch {
		// disposal failure should not mask the provider result
	}
}

async function emitCursorNativeRunNextTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: CursorLiveRun,
	signal?: AbortSignal,
): Promise<void> {
	const turn: CursorLiveTurnState = {
		stream,
		partial,
		thinkingContentIndex: -1,
		textContentIndex: -1,
	};

	while (true) {
		while (run.pendingEvents.length > 0) {
			const event = run.pendingEvents[0];
			if (event.type === "tool") {
				await settleCursorLiveToolBatch(run);
				if (signal?.aborted) throw new CursorAbortError();
				const outputText = closeCursorNativeTurnBlocks(turn);
				const tools = collectCursorNativeToolBatch(run);
				emitCursorNativeToolUseTurn(stream, partial, run, tools, outputText);
				return;
			}
			if (event.type === "bridge-tool") {
				await settleCursorLiveToolBatch(run);
				if (signal?.aborted) throw new CursorAbortError();
				const outputText = closeCursorNativeTurnBlocks(turn);
				const requests = collectCursorBridgeToolBatch(run);
				emitCursorBridgeToolUseTurn(stream, partial, run, requests, outputText);
				return;
			}
			run.pendingEvents.shift();
			emitCursorLiveQueuedEvent(turn, event, run);
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
			const finalText = trimAlreadyEmittedCursorText(run.finalText ?? run.textDeltas.join(""), run.emittedText);
			if (finalText) {
				outputText += await emitTextDeltas(stream, partial, splitTextIntoReplayDeltas(finalText));
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

async function replayPendingCursorLiveRun(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	context: Context,
	signal?: AbortSignal,
): Promise<boolean> {
	const run = getPendingCursorLiveRun(context);
	if (!run) return false;
	clearCursorNativeRunIdleDispose(run);
	run.bridgeRun?.resolveToolResultsFromContext(context);
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
		let activeLiveRun: CursorLiveRun | undefined;
		let bridgeRun: CursorPiToolBridgeRun | undefined;
		let bridgeRunOwnedByLiveRun = false;
		let liveRunForBridgeQueue: CursorLiveRun | undefined;
		const queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[] = [];
		let resolvedApiKey: string | undefined;
		let abortSignal: AbortSignal | undefined;
		let abortListener: (() => void) | undefined;
		let restoreCursorSdkOutputFilter: (() => void) | undefined;

		try {
			const throwIfAborted = (): void => {
				if (options?.signal?.aborted) throw new CursorAbortError();
			};

			stream.push({ type: "start", partial });
			throwIfAborted();

			if (await replayPendingCursorLiveRun(stream, partial, context, options?.signal)) {
				stream.end();
				return;
			}

			const apiKey = resolveCursorApiKey(options?.apiKey);
			if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE);
			resolvedApiKey = apiKey;

			// pi-ai Context/SimpleStreamOptions do not expose ExtensionContext.cwd; bridge via session_start
			// until pi threads session cwd into streamSimple (cwd can change without a new session event).
			const cwd = getCursorSessionCwd();
			const fastEnabled = getEffectiveFastForModelId(model.id);
			const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
			const settingSources = resolveCursorSettingSources();

			const registeredBridge = getRegisteredCursorPiToolBridge();
			bridgeRun = registeredBridge
				? await registeredBridge.createRun({
						onToolRequest: (request) => {
							if (liveRunForBridgeQueue && !liveRunForBridgeQueue.disposed) {
								queueCursorNativeEvent(liveRunForBridgeQueue, { type: "bridge-tool", request });
							} else {
								queuedBridgeRequestsBeforeLiveRun.push(request);
							}
						},
					})
				: undefined;
			if (!bridgeRun?.enabled || !bridgeRun.mcpServers) {
				await bridgeRun?.dispose();
				bridgeRun = undefined;
			}

			installCursorMcpToolTimeoutOverride();
			restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
			agent = await suppressCursorSdkOutput(() =>
				Agent.create({
					apiKey,
					model: selection,
					local: settingSources ? { cwd, settingSources } : { cwd },
					...(bridgeRun?.mcpServers ? { mcpServers: bridgeRun.mcpServers } : {}),
				}),
			);
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
			const useLiveRun = useNativeToolReplay || bridgeRun !== undefined;
			const liveRun: CursorLiveRun | undefined = useLiveRun
				? {
						id: useNativeToolReplay ? nativeReplayId : bridgeRun!.id,
						agent,
						bridgeRun,
						promptInputTokens,
						promptInputTokensReported: false,
						pendingEvents: [],
						textDeltas,
						emittedText: "",
						recordedToolDisplayIds: [],
						done: false,
						cancelled: false,
						disposed: false,
						waiters: new Set(),
					}
				: undefined;
			if (liveRun) {
				pendingCursorLiveRuns.set(liveRun.id, liveRun);
				activeLiveRun = liveRun;
				liveRunForBridgeQueue = liveRun;
				bridgeRunOwnedByLiveRun = bridgeRun !== undefined;
				for (const request of queuedBridgeRequestsBeforeLiveRun.splice(0)) {
					queueCursorNativeEvent(liveRun, { type: "bridge-tool", request });
				}
			}
			const startedToolCalls = new Map<string, unknown>();
			const bridgeStartedToolCallIds = new Set<string>();
			const activeShellCallIds = new Set<string>();
			const ambiguousShellOutputCallIds = new Set<string>();
			const shellOutputDeltasByCallId = new Map<string, CursorShellOutputDeltas>();
			const completedToolIdentities = new Set<string>();
			let cursorPlanTextCandidate: string | undefined;
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

			const emitCursorToolTrace = (text: string): void => {
				const traceText = text.endsWith("\n") ? text : `${text}\n`;
				if (liveRun) {
					queueCursorNativeEvent(liveRun, { type: "thinking-delta", text: traceText });
					queueCursorNativeEvent(liveRun, { type: "thinking-completed" });
					return;
				}
				appendTraceBlock(traceText);
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

			const getStartedToolCallFingerprint = (toolCall: unknown): string => {
				return getToolFingerprint({ toolName: getCursorToolName(toolCall), args: getObjectField(toolCall, "args") });
			};

			const clearStartedToolCall = (callId: string): void => {
				startedToolCalls.delete(callId);
				bridgeStartedToolCallIds.delete(callId);
				activeShellCallIds.delete(callId);
				ambiguousShellOutputCallIds.delete(callId);
			};

			const takeBridgeStartedToolCallId = (callId: unknown): string | undefined => {
				if (typeof callId !== "string" || !bridgeStartedToolCallIds.has(callId)) return undefined;
				bridgeStartedToolCallIds.delete(callId);
				return callId;
			};

			const takeShellOutputDeltas = (callId: string): CursorShellOutputDeltas | undefined => {
				const deltas = shellOutputDeltasByCallId.get(callId);
				shellOutputDeltasByCallId.delete(callId);
				return deltas;
			};

			const appendShellOutputDelta = (delta: CursorShellOutputDelta): void => {
				if (activeShellCallIds.size !== 1) {
					for (const activeCallId of activeShellCallIds) {
						ambiguousShellOutputCallIds.add(activeCallId);
						shellOutputDeltasByCallId.delete(activeCallId);
					}
					return;
				}
				const [callId] = activeShellCallIds;
				if (!callId || ambiguousShellOutputCallIds.has(callId)) return;
				let deltas = shellOutputDeltasByCallId.get(callId);
				if (!deltas) {
					deltas = { stdout: [], stderr: [] };
					shellOutputDeltasByCallId.set(callId, deltas);
				}
				deltas[delta.stream].push(delta.data);
			};

			const removeStartedToolCallForStep = (toolCall: unknown, stepId: unknown): string | undefined => {
				if (typeof stepId === "string" && startedToolCalls.has(stepId)) {
					clearStartedToolCall(stepId);
					return stepId;
				}
				const fingerprint = getStartedToolCallFingerprint(toolCall);
				for (const [callId, startedToolCall] of startedToolCalls) {
					if (getStartedToolCallFingerprint(startedToolCall) !== fingerprint) continue;
					clearStartedToolCall(callId);
					return callId;
				}
				return undefined;
			};

			const discardIncompleteStartedToolCalls = (): void => {
				startedToolCalls.clear();
				bridgeStartedToolCallIds.clear();
				activeShellCallIds.clear();
				ambiguousShellOutputCallIds.clear();
				shellOutputDeltasByCallId.clear();
			};

			const handleCompletedToolCall = (
				toolCall: unknown,
				options: { identity?: string; source?: "started" | "fallback" } = {},
			): void => {
				const planText = getCursorCreatePlanText(toolCall);
				if (planText) cursorPlanTextCandidate = scrubSensitiveText(planText, resolvedApiKey);

				if (liveRun?.bridgeRun?.isBridgeMcpToolCall(toolCall)) {
					if (options.identity) completedToolIdentities.add(options.identity);
					return;
				}
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

				const nativeRenderable = canRenderCursorToolNatively(display.toolName);
				const route = useNativeToolReplay && nativeRenderable && liveRun ? "native_replay" : "trace";

				if (route === "native_replay" && liveRun) {
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

				emitCursorToolTrace(transcript || `Cursor tool: ${formatCursorToolName(toolCall)} completed`);
			};

			const onDelta = (args: { update: InteractionUpdate }): void => {
				const update = args.update;

				if (update.type === "text-delta") {
					textDeltas.push(update.text);
					if (liveRun) {
						queueCursorNativeEvent(liveRun, { type: "text-delta", text: update.text });
					} else {
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
					if (liveRun?.bridgeRun?.isBridgeMcpToolCall(update.toolCall)) {
						if (typeof update.callId === "string") bridgeStartedToolCallIds.add(update.callId);
					} else {
						startedToolCalls.set(update.callId, update.toolCall);
						if (isCursorShellToolCall(update.toolCall)) activeShellCallIds.add(update.callId);
					}
				} else if (update.type === "tool-call-completed") {
					const identity = typeof update.callId === "string" ? `cursor-tool:${update.callId}` : undefined;
					const bridgeStartedCallId = takeBridgeStartedToolCallId(update.callId);
					if (bridgeStartedCallId) {
						completedToolIdentities.add(`cursor-tool:${bridgeStartedCallId}`);
						return;
					}
					const mergedToolCall = mergeCursorToolCalls(startedToolCalls.get(update.callId), update.toolCall);
					clearStartedToolCall(update.callId);
					const toolCallWithShellOutput = mergeShellOutputDeltasIntoCursorToolCall(mergedToolCall, takeShellOutputDeltas(update.callId));
					handleCompletedToolCall(toolCallWithShellOutput, {
						identity,
						source: identity ? "started" : "fallback",
					});
				} else if (update.type === "shell-output-delta") {
					const delta = getCursorShellOutputDelta(update);
					if (delta) appendShellOutputDelta(delta);
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
				// token-delta, step-* are intentionally not surfaced.
			};

			const onStep = (args: { step: unknown }): void => {
				const stepType = getObjectField(args.step, "type");
				const step = getObjectField(args.step, "message") ? args.step : undefined;
				const rawStepToolCall = getObjectField(step, "message");
				if (stepType !== "toolCall") return;
				const toolCall = rawStepToolCall;
				const stepId = getObjectField(args.step, "id") ?? getObjectField(toolCall, "id") ?? getObjectField(toolCall, "callId");
				if (toolCall) {
					const bridgeStartedCallId = takeBridgeStartedToolCallId(stepId);
					if (bridgeStartedCallId) {
						completedToolIdentities.add(`cursor-tool:${bridgeStartedCallId}`);
						return;
					}
					const matchedStartedCallId = removeStartedToolCallForStep(toolCall, stepId);
					const toolCallWithShellOutput = mergeShellOutputDeltasIntoCursorToolCall(
						toolCall,
						matchedStartedCallId ? takeShellOutputDeltas(matchedStartedCallId) : undefined,
					);
					if (liveRun?.bridgeRun?.isBridgeMcpToolCall(toolCall)) {
						if (matchedStartedCallId) completedToolIdentities.add(`cursor-tool:${matchedStartedCallId}`);
						return;
					}
					const identityId = typeof stepId === "string" ? stepId : matchedStartedCallId;
					handleCompletedToolCall(toolCallWithShellOutput, {
						identity: identityId ? `cursor-tool:${identityId}` : undefined,
					});
					if (matchedStartedCallId && matchedStartedCallId !== stepId) completedToolIdentities.add(`cursor-tool:${matchedStartedCallId}`);
				}
			};

			// Handle abort signal
			let run: Awaited<ReturnType<SDKAgent["send"]>> | null = null;
			abortListener = () => {
				activeLiveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
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

			if (liveRun) {
				void run
					.wait()
					.then(async (result) => {
						if (liveRun.disposed) return;
						discardIncompleteStartedToolCalls();
						await cacheSdkContextWindow(liveRun.agent.agentId, model.id);
						if (liveRun.disposed) return;
						liveRun.cancelled = result.status === "cancelled";
						liveRun.finalText = selectCursorFinalText(result.result, liveRun.textDeltas, liveRun.emittedText, cursorPlanTextCandidate);
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
					await settleCursorLiveToolBatch(liveRun);
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
			discardIncompleteStartedToolCalls();
			await cacheSdkContextWindow(agent.agentId, model.id);

			// Close any open thinking/activity trace, then use the final run result only when
			// Cursor did not stream text deltas.
			closeTraceBlock();

			if (result.status === "cancelled") {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				const finalCursorText = selectCursorFinalText(result.result, textDeltas, textDeltas.join(""), cursorPlanTextCandidate);
				const finalText = flushText(hasUsableText(finalCursorText) ? [finalCursorText] : []);
				setApproximateUsage(partial, promptInputTokens, finalText);
				stream.push({ type: "done", reason: "stop", message: partial });
			}
		} catch (error) {
			if (activeLiveRun && !activeLiveRun.disposed) await disposeCursorNativeRun(activeLiveRun);
			if (error instanceof CursorAbortError) {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				partial.stopReason = "error";
				partial.errorMessage = sanitizeError(error, resolvedApiKey ?? options?.apiKey);
				stream.push({ type: "error", reason: "error", error: partial });
			}
		} finally {
			restoreCursorSdkOutputFilter?.();
			if (activeLiveRun?.disposed) agent = null;

			if (abortSignal && abortListener) {
				abortSignal.removeEventListener("abort", abortListener);
			}

			if (bridgeRun && !bridgeRunOwnedByLiveRun) {
				try {
					await bridgeRun.dispose();
				} catch {
					// bridge disposal failure should not mask original error
				}
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
	pendingCursorNativeRunCount: () => pendingCursorLiveRuns.size,
	setCursorNativeReplayIdleDisposeMs: (value: number) => {
		cursorNativeReplayIdleDisposeMs = value;
	},
	resetCursorNativeReplayIdleDisposeMs: () => {
		cursorNativeReplayIdleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
	},
};
