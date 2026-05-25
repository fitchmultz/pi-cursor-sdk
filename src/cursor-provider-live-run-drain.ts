import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import { scheduler } from "node:timers/promises";
import {
	CursorLiveRunAbortError,
	createCursorLiveRunCoordinator,
	hasTrailingUserMessagesAfterToolResults,
	type CursorLiveQueuedEvent,
	type CursorLiveRun,
} from "./cursor-live-run-coordinator.js";
import {
	deleteCursorNativeToolDisplay,
	recordCursorNativeToolDisplay,
	type CursorNativeToolDisplayItem,
} from "./cursor-native-tool-display.js";
import { type CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge.js";
import { resetSessionCursorAgent } from "./cursor-session-agent.js";
import { applyCursorApproximateUsage } from "./cursor-usage-accounting.js";
import { CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import { hasUsableText } from "./cursor-record-utils.js";
import { formatCursorSdkAbortMessage, resolveCursorSdkAbortCause } from "./cursor-provider-errors.js";
import { formatInactiveCursorReplayTrace } from "./cursor-native-replay-trace.js";
import { partitionNativeToolsByActiveContext } from "./cursor-native-replay-routing.js";

export const DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS = 5 * 60 * 1000;
const CURSOR_NATIVE_REPLAY_TOOL_ID_PATTERN = /^(cursor-replay-\d+-\d+)-tool-\d+$/;

interface CursorLiveTurnState {
	emitter: CursorPartialContentEmitter;
	emittedText: string;
}
let cursorNativeReplayIdleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;

type CursorLiveRunDrainMode = "emit" | "chain_user_input";
type CursorLiveRunDrainOutcome = "tool_use" | "stop" | "error" | "aborted" | "chain_user_input";
type LiveRunPreSendOutcome = "stream_ended" | "continue_send";

let cursorNativeReplayCounter = 0;

export async function abandonSessionCursorAgent(scopeKey: string | undefined): Promise<void> {
	if (!scopeKey) return;
	await resetSessionCursorAgent(scopeKey);
}

export const cursorLiveRuns = createCursorLiveRunCoordinator({
	getIdleDisposeMs: () => cursorNativeReplayIdleDisposeMs,
	deleteNativeToolDisplay: deleteCursorNativeToolDisplay,
	abandonSessionAgent: (scopeKey) => abandonSessionCursorAgent(scopeKey),
});

export function createCursorNativeReplayId(): string {
	cursorNativeReplayCounter += 1;
	return `cursor-replay-${Date.now()}-${cursorNativeReplayCounter}`;
}

function getCursorNativeReplayIdFromToolCallId(toolCallId: string): string | undefined {
	return CURSOR_NATIVE_REPLAY_TOOL_ID_PATTERN.exec(toolCallId)?.[1];
}

export function getPendingCursorLiveRun(context: Context): CursorLiveRun | undefined {
	return cursorLiveRuns.getPendingFromContext(context, getCursorNativeReplayIdFromToolCallId);
}

export function getActiveCursorLiveRunForCurrentScope(): CursorLiveRun | undefined {
	return cursorLiveRuns.getActiveForScope();
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
	const emitter = new CursorPartialContentEmitter(stream, partial, -1, true);
	for (const delta of deltas) {
		emitter.appendTextDelta(delta);
		await Promise.resolve();
	}
	return emitter.closeText();
}

export async function settleCursorLiveToolBatch(run: CursorLiveRun): Promise<void> {
	const eventType = cursorLiveRuns.peekEvent(run)?.type;
	if (eventType !== "tool" && eventType !== "bridge-tool") return;
	await scheduler.wait(75);
}

function emitCursorLiveQueuedEvent(
	turn: CursorLiveTurnState,
	event: Exclude<CursorLiveQueuedEvent, { type: "tool" } | { type: "bridge-tool" }>,
	run?: CursorLiveRun,
): void {
	if (event.type === "thinking-delta") {
		turn.emitter.appendThinkingDelta(event.text);
	} else if (event.type === "thinking-completed") {
		turn.emitter.closeThinking();
	} else if (event.type === "text-delta") {
		turn.emittedText += event.text;
		if (run) run.emittedText += event.text;
		turn.emitter.appendTextDelta(event.text);
	}
}

function isCursorTextBoundary(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) return true;
	const before = text[index - 1];
	const after = text[index];
	return !/[\p{L}\p{N}_]/u.test(before) || !/[\p{L}\p{N}_]/u.test(after);
}

function trimAlreadyEmittedCursorText(text: string, emittedText: string, options?: { allowPartialPrefix?: boolean }): string {
	if (!text || !emittedText) return text;
	if (text === emittedText) return "";
	if (text.startsWith(emittedText) && (options?.allowPartialPrefix || isCursorTextBoundary(text, emittedText.length))) {
		return text.slice(emittedText.length);
	}
	if (emittedText.endsWith(text) && isCursorTextBoundary(emittedText, emittedText.length - text.length)) return "";
	const trimmedText = text.trim();
	const trimmedEmittedText = emittedText.trim();
	if (trimmedText === trimmedEmittedText) return "";
	if (trimmedText && trimmedEmittedText.endsWith(trimmedText)) {
		const suffixStart = trimmedEmittedText.length - trimmedText.length;
		if (isCursorTextBoundary(trimmedEmittedText, suffixStart)) return "";
	}
	return text;
}

function trimCurrentTurnAlreadyEmittedCursorText(text: string, currentTurnEmittedText: string, emittedText = currentTurnEmittedText): string {
	if (!currentTurnEmittedText) return trimAlreadyEmittedCursorText(text, emittedText);
	const currentTurnTrimmedText = trimAlreadyEmittedCursorText(text, currentTurnEmittedText, { allowPartialPrefix: true });
	if (currentTurnTrimmedText !== text) return currentTurnTrimmedText;
	if (emittedText.endsWith(currentTurnEmittedText)) {
		const emittedTextTrimmedText = trimAlreadyEmittedCursorText(text, emittedText, { allowPartialPrefix: true });
		if (emittedTextTrimmedText !== text) return emittedTextTrimmedText;
	}
	return trimAlreadyEmittedCursorText(text, emittedText);
}

export function selectCursorFinalText(
	resultText: unknown,
	textDeltas: readonly string[],
	emittedText: string,
	fallbackText?: string,
	options?: { allowPartialPrefix?: boolean },
): string {
	const candidates = [typeof resultText === "string" ? resultText : undefined, fallbackText, textDeltas.join("")];
	for (const candidate of candidates) {
		if (!hasUsableText(candidate)) continue;
		const trimmedCandidate = trimAlreadyEmittedCursorText(candidate, emittedText, options);
		if (hasUsableText(trimmedCandidate)) return trimmedCandidate;
	}
	return "";
}

function emitCursorNativeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	run: CursorLiveRun,
	toolResultInputTokens: number,
	tools: CursorNativeToolDisplayItem[],
): void {
	const shouldTerminate = run.done && !run.finalText?.trim() && !cursorLiveRuns.peekEvent(run);
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
	applyCursorApproximateUsage(partial, model, context, cursorLiveRuns.takeTurnInputTokens(run, toolResultInputTokens));
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	cursorLiveRuns.requestIdleDispose(run);
}

function emitInactiveCursorReplayTrace(turn: CursorLiveTurnState, tools: CursorNativeToolDisplayItem[]): void {
	if (tools.length === 0) return;
	for (const tool of tools) {
		turn.emitter.appendThinkingBlock(formatInactiveCursorReplayTrace(tool));
	}
}

function emitCursorBridgeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	run: CursorLiveRun,
	toolResultInputTokens: number,
	requests: CursorPiBridgeToolRequest[],
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
	applyCursorApproximateUsage(partial, model, context, cursorLiveRuns.takeTurnInputTokens(run, toolResultInputTokens));
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	cursorLiveRuns.requestIdleDispose(run);
}

async function emitCursorLiveRunPendingToolUseTurn(
	turn: CursorLiveTurnState,
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	run: CursorLiveRun,
	toolResultInputTokens: number,
	options: { mode: CursorLiveRunDrainMode; signal?: AbortSignal },
): Promise<"tool_use" | "handled" | undefined> {
	const eventType = cursorLiveRuns.peekEvent(run)?.type;
	if (eventType !== "tool" && eventType !== "bridge-tool") return undefined;
	await settleCursorLiveToolBatch(run);
	if (options.signal?.aborted) throw new CursorLiveRunAbortError();
	if (eventType === "tool") {
		const { active, inactive } = partitionNativeToolsByActiveContext(context, cursorLiveRuns.collectNativeToolBatch(run));
		if (options.mode === "emit") emitInactiveCursorReplayTrace(turn, inactive);
		if (active.length === 0) {
			// Inactive-only batch: trace was emitted above; do not emit toolUse.
			return "handled";
		}
		if (options.mode === "emit") turn.emitter.closeAll();
		emitCursorNativeToolUseTurn(stream, partial, model, context, run, toolResultInputTokens, active);
	} else {
		if (options.mode === "emit") turn.emitter.closeAll();
		const requests = cursorLiveRuns.collectBridgeToolBatch(run);
		emitCursorBridgeToolUseTurn(stream, partial, model, context, run, toolResultInputTokens, requests);
	}
	return "tool_use";
}

export async function drainCursorLiveRunTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	run: CursorLiveRun,
	toolResultInputTokens: number,
	options: { mode: CursorLiveRunDrainMode; signal?: AbortSignal },
): Promise<CursorLiveRunDrainOutcome> {
	const turn: CursorLiveTurnState = {
		emitter: new CursorPartialContentEmitter(stream, partial, -1, true),
		emittedText: "",
	};

	while (true) {
		if (options.mode === "chain_user_input" && cursorLiveRuns.isReady(run)) {
			await cursorLiveRuns.release(run);
			return "chain_user_input";
		}

		while (cursorLiveRuns.peekEvent(run)) {
			const toolUse = await emitCursorLiveRunPendingToolUseTurn(
				turn,
				stream,
				partial,
				model,
				context,
				run,
				toolResultInputTokens,
				options,
			);
			if (toolUse === "tool_use") return toolUse;
			if (toolUse === "handled") continue;
			const event = cursorLiveRuns.shiftEvent(run);
			if (!event || event.type === "tool" || event.type === "bridge-tool") continue;
			if (options.mode === "emit") emitCursorLiveQueuedEvent(turn, event, run);
		}

		if (run.disposed) {
			partial.stopReason = "aborted";
			partial.errorMessage = formatCursorSdkAbortMessage(
				resolveCursorSdkAbortCause({ liveRunDisposed: true }),
			);
			stream.push({ type: "error", reason: "aborted", error: partial });
			return "aborted";
		}
		if (run.cancelled) {
			partial.stopReason = "aborted";
			if (run.abortMessage) partial.errorMessage = run.abortMessage;
			stream.push({ type: "error", reason: "aborted", error: partial });
			await cursorLiveRuns.release(run);
			return "aborted";
		}
		if (run.errorMessage) {
			partial.stopReason = "error";
			partial.errorMessage = run.errorMessage;
			stream.push({ type: "error", reason: "error", error: partial });
			await cursorLiveRuns.release(run);
			return "error";
		}
		if (run.done) {
			if (options.mode === "chain_user_input") {
				await cursorLiveRuns.release(run);
				return "chain_user_input";
			}
			turn.emitter.closeAll();
			const finalText = trimCurrentTurnAlreadyEmittedCursorText(run.finalText ?? run.textDeltas.join(""), turn.emittedText, run.emittedText);
			if (finalText) {
				await emitTextDeltas(stream, partial, splitTextIntoReplayDeltas(finalText));
			}
			applyCursorApproximateUsage(partial, model, context, cursorLiveRuns.takeTurnInputTokens(run, toolResultInputTokens));
			partial.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: partial });
			await cursorLiveRuns.release(run);
			return "stop";
		}

		await cursorLiveRuns.waitForProgress(run, options.signal);
	}
}

export async function drainExistingCursorLiveRunBeforeSend(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	signal?: AbortSignal,
): Promise<LiveRunPreSendOutcome> {
	while (true) {
		const run = getPendingCursorLiveRun(context) ?? getActiveCursorLiveRunForCurrentScope();
		if (!run || run.disposed) return "continue_send";

		try {
			const outcome = await cursorLiveRuns.withRunLease(run, signal, async () => {
				if (run.disposed) return "continue_send" as const;
				const consumed = cursorLiveRuns.consumeToolResults(run, context, getCursorNativeReplayIdFromToolCallId);
				run.bridgeRun?.resolveToolResults(consumed.toolResults);
				const shouldChainUserInput = run.chainUserInputAfterCompletion || hasTrailingUserMessagesAfterToolResults(context);
				if (shouldChainUserInput) run.chainUserInputAfterCompletion = true;
				while (!cursorLiveRuns.isReady(run)) {
					await cursorLiveRuns.waitForProgress(run, signal);
				}
				if (run.disposed) return "continue_send" as const;
				const drainOutcome = await drainCursorLiveRunTurn(stream, partial, model, context, run, consumed.toolResultInputTokens, {
					mode: shouldChainUserInput ? "chain_user_input" : "emit",
					signal,
				});
				return drainOutcome === "chain_user_input" ? "continue_send" : "stream_ended";
			});
			if (outcome === "continue_send" && !run.disposed && cursorLiveRuns.getActiveForScope(run.sessionAgentScopeKey) === run) {
				continue;
			}
			return outcome;
		} catch (error) {
			if (error instanceof CursorLiveRunAbortError) await cursorLiveRuns.release(run);
			throw error;
		}
	}
}

export function setCursorNativeReplayIdleDisposeMs(value: number): void {
	cursorNativeReplayIdleDisposeMs = value;
}

export function resetCursorNativeReplayIdleDisposeMs(): void {
	cursorNativeReplayIdleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
}

export async function releaseAllPendingCursorLiveRunsForTests(): Promise<void> {
	while (cursorLiveRuns.count() > 0) {
		const run = cursorLiveRuns.getActiveForScope();
		if (!run) break;
		const before = cursorLiveRuns.count();
		await cursorLiveRuns.release(run);
		if (cursorLiveRuns.count() >= before) break;
	}
}

export { hasTrailingUserMessagesAfterToolResults };
