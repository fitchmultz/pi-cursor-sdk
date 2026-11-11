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
	type CursorLiveRunOutcome,
} from "./cursor-live-run-coordinator.js";
import {
	deleteCursorNativeToolDisplay,
	recordCursorNativeToolDisplay,
	type CursorNativeToolDisplayItem,
} from "./cursor-native-tool-display-state.js";
import { type CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge.js";
import { resetSessionCursorAgent } from "./cursor-session-agent.js";
import { applyCursorUsage } from "./cursor-usage-accounting.js";
import { CURSOR_TEXT_MESSAGE_SEPARATOR, CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import { emitDisplayOnlyTraceBlock } from "./cursor-display-only-trace.js";
import { trimCurrentTurnAlreadyEmittedCursorText } from "./cursor-run-final-text.js";
import { formatCursorSdkAbortMessage, resolveCursorSdkAbortCause } from "./cursor-provider-errors.js";
import { formatInactiveCursorReplayTrace } from "./cursor-native-replay-trace.js";
import { partitionNativeToolsByActiveContext } from "./cursor-native-replay-routing.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";

const DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS = 5 * 60 * 1000;
function parseCursorNativeReplayIdleDisposeMs(raw: string | undefined): number {
	if (!raw || /[^0-9]/.test(raw)) return DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
	const value = Number(raw);
	return value >= 1 && value <= 2147483647 ? value : DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
}
const CURSOR_NATIVE_REPLAY_TOOL_ID_PATTERN = /^(cursor-replay-\d+-\d+)-tool-\d+$/;

interface CursorLiveTurnState {
	emitter: CursorPartialContentEmitter;
	emittedText: string;
}
let cursorNativeReplayIdleDisposeMsOverride: number | undefined;

type CursorLiveRunDrainMode = "emit" | "chain_user_input";
type CursorLiveRunDrainOutcome = "tool_use" | "stop" | "error" | "aborted" | "chain_user_input";
type LiveRunPreSendOutcome = "stream_ended" | "continue_send";

let cursorNativeReplayCounter = 0;

export async function abandonSessionCursorAgent(scopeKey: string | undefined): Promise<void> {
	if (!scopeKey) return;
	await resetSessionCursorAgent(scopeKey);
}

export const cursorLiveRuns = createCursorLiveRunCoordinator({
	getIdleDisposeMs: () => cursorNativeReplayIdleDisposeMsOverride ?? parseCursorNativeReplayIdleDisposeMs(process.env.PI_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS),
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

function getPendingCursorLiveRun(context: Context, scopeKey: string): CursorLiveRun | undefined {
	return cursorLiveRuns.getPendingFromContext(context, getCursorNativeReplayIdFromToolCallId, scopeKey);
}

export function getActiveCursorLiveRunForCurrentScope(scopeKey?: string): CursorLiveRun | undefined {
	return cursorLiveRuns.getActiveForScope(scopeKey);
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
	emitter: CursorPartialContentEmitter,
	deltas: string[],
): Promise<string> {
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

async function waitForCursorLiveSdkTurnEnded(run: CursorLiveRun, signal?: AbortSignal): Promise<boolean> {
	const deadline = Date.now() + 125;
	while (!cursorLiveRuns.hasSdkTurnEnded(run) && run.outcome.kind === "running" && run.resources.kind === "open") {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		await scheduler.wait(Math.min(25, remainingMs));
		if (signal?.aborted) throw new CursorLiveRunAbortError();
	}
	return cursorLiveRuns.hasSdkTurnEnded(run);
}

export function flushPendingCursorLiveRunTraceEventsToStream(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: CursorLiveRun,
	options?: { includeTracesBehindQueuedTools?: boolean; emitter?: CursorPartialContentEmitter },
): void {
	if (run.resources.kind !== "open") return;
	const turn: CursorLiveTurnState = {
		emitter: options?.emitter ?? new CursorPartialContentEmitter(stream, partial, -1, true),
		emittedText: "",
	};
	while (true) {
		const event = cursorLiveRuns.peekEvent(run);
		if (!event || event.type === "tool" || event.type === "bridge-tool") break;
		cursorLiveRuns.shiftEvent(run);
		emitCursorLiveQueuedEvent(turn, event, run);
	}
	if (options?.includeTracesBehindQueuedTools && run.pendingEvents.length > 0) {
		const preserved: CursorLiveQueuedEvent[] = [];
		for (const event of run.pendingEvents) {
			if (event.type === "tool" || event.type === "bridge-tool") {
				preserved.push(event);
				continue;
			}
			emitCursorLiveQueuedEvent(turn, event, run);
		}
		run.pendingEvents = preserved;
	}
	turn.emitter.closeAll();
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
	} else if (event.type === "text-completed") {
		turn.emitter.completeTextMessage();
		// Logical separators also keep suffix/prefix dedup aware of SDK messages,
		// including boundaries queued across Pi tool-use turns.
		if (turn.emittedText) turn.emittedText += CURSOR_TEXT_MESSAGE_SEPARATOR;
		if (run?.emittedText) run.emittedText += CURSOR_TEXT_MESSAGE_SEPARATOR;
	} else if (event.type === "text-delta") {
		turn.emittedText += event.text;
		if (run) run.emittedText += event.text;
		turn.emitter.appendTextDelta(event.text);
	}
}

/** Replayed tools end Pi's loop once the SDK has settled with no final text left to emit. */
function isSettledWithoutFinalText(outcome: CursorLiveRunOutcome): boolean {
	switch (outcome.kind) {
		case "running":
			return false;
		case "finished":
			return !outcome.finalText.trim();
		case "cancelled":
		case "error":
			return true;
	}
}

function emitCursorNativeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	run: CursorLiveRun,
	toolResultInputTokens: number,
	tools: CursorNativeToolDisplayItem[],
	occupancyFloor: number | undefined,
	debugRecorder?: CursorSdkEventDebugRecorder,
): void {
	const shouldTerminate = isSettledWithoutFinalText(run.outcome) && !cursorLiveRuns.peekEvent(run);
	for (const tool of tools) {
		const contentIndex = partial.content.length;
		// Pi persists JSON arguments: keep the completed call identical to its wire delta.
		const serializedArgs = JSON.stringify(tool.args);
		partial.content.push({
			type: "toolCall",
			id: tool.id,
			name: tool.toolName,
			arguments: JSON.parse(serializedArgs),
		});
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({ type: "toolcall_delta", contentIndex, delta: serializedArgs, partial });
		const block = partial.content[contentIndex];
		if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		if (recordCursorNativeToolDisplay({ ...tool, terminate: shouldTerminate }, run.nativeDisplay)) {
			run.recordedToolDisplayIds.push(tool.id);
			debugRecorder?.recordDrainEvent("native_tool_display_recorded", {
				toolId: tool.id,
				toolName: tool.toolName,
				terminate: shouldTerminate,
			});
		}
	}
	applyCursorUsage(partial, model, context, cursorLiveRuns.takeTurnInputTokens(run, toolResultInputTokens), {
		runtime: "local",
		turn: cursorLiveRuns.takeSdkTurnUsage(run),
		occupancyFloor,
	});
	// Terminating replay results end Pi's loop, so this can be the run's last delivery. A replay that fails
	// instead continues to a stop delivery, which publishes again and supersedes this entry.
	if (shouldTerminate) run.resumePublication?.publish();
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	cursorLiveRuns.requestIdleDispose(run);
}

function emitInactiveCursorReplayTrace(
	turn: CursorLiveTurnState,
	tools: CursorNativeToolDisplayItem[],
	debugRecorder?: CursorSdkEventDebugRecorder,
): void {
	if (tools.length === 0) return;
	for (const tool of tools) {
		const traceText = formatInactiveCursorReplayTrace(tool);
		debugRecorder?.recordDrainEvent("inactive_replay_trace", {
			toolId: tool.id,
			toolName: tool.toolName,
			traceText,
		});
		turn.emitter.appendThinkingBlock(traceText);
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
	occupancyFloor: number | undefined,
): void {
	for (const request of requests) {
		const contentIndex = partial.content.length;
		const serializedArgs = JSON.stringify(request.args);
		partial.content.push({
			type: "toolCall",
			id: request.piToolCallId,
			name: request.piToolName,
			arguments: JSON.parse(serializedArgs),
		});
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({ type: "toolcall_delta", contentIndex, delta: serializedArgs, partial });
		const block = partial.content[contentIndex];
		if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
	}
	applyCursorUsage(partial, model, context, cursorLiveRuns.takeTurnInputTokens(run, toolResultInputTokens), {
		runtime: "local",
		turn: cursorLiveRuns.takeSdkTurnUsage(run),
		occupancyFloor,
	});
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
	options: { mode: CursorLiveRunDrainMode; signal?: AbortSignal; debugRecorder?: CursorSdkEventDebugRecorder; occupancyFloor?: number },
): Promise<"tool_use" | "handled" | undefined> {
	const debugRecorder = options.debugRecorder ?? run.debugRecorder;
	const eventType = cursorLiveRuns.peekEvent(run)?.type;
	if (eventType !== "tool" && eventType !== "bridge-tool") return undefined;
	await settleCursorLiveToolBatch(run);
	const sdkTurnEnded = await waitForCursorLiveSdkTurnEnded(run, options.signal);
	if (options.signal?.aborted) throw new CursorLiveRunAbortError();
	if (eventType === "tool") {
		const { active, inactive } = partitionNativeToolsByActiveContext(context, cursorLiveRuns.collectNativeToolBatch(run));
		if (options.mode === "emit") emitInactiveCursorReplayTrace(turn, inactive, debugRecorder);
		if (active.length === 0) {
			// Inactive-only batch: trace was emitted above; do not emit toolUse.
			return "handled";
		}
		if (!sdkTurnEnded) cursorLiveRuns.ignoreFutureSdkTurnUsage(run);
		if (options.mode === "emit") turn.emitter.closeAll();
		emitCursorNativeToolUseTurn(stream, partial, model, context, run, toolResultInputTokens, active, options.occupancyFloor, debugRecorder);
	} else {
		const requests = cursorLiveRuns.collectBridgeToolBatch(run);
		if (requests.length === 0) return "handled";
		if (!sdkTurnEnded) cursorLiveRuns.ignoreFutureSdkTurnUsage(run);
		if (options.mode === "emit") turn.emitter.closeAll();
		emitCursorBridgeToolUseTurn(stream, partial, model, context, run, toolResultInputTokens, requests, options.occupancyFloor);
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
	options: { mode: CursorLiveRunDrainMode; signal?: AbortSignal; debugRecorder?: CursorSdkEventDebugRecorder; emitter?: CursorPartialContentEmitter; occupancyFloor?: number },
): Promise<CursorLiveRunDrainOutcome> {
	const debugRecorder = options.debugRecorder ?? run.debugRecorder;
	debugRecorder?.recordDrainEvent("turn_start", {
		mode: options.mode,
		runId: run.id,
		pendingEventCount: run.pendingEvents.length,
		sdkOutcome: run.outcome.kind,
	});
	let outcome: CursorLiveRunDrainOutcome | undefined;
	let outcomeDetails: Record<string, unknown> = {};
	const turn: CursorLiveTurnState = {
		emitter: options.emitter ?? new CursorPartialContentEmitter(stream, partial, -1, true),
		emittedText: "",
	};

	try {
		while (true) {
			if (options.mode === "chain_user_input" && cursorLiveRuns.isReady(run)) {
				await cursorLiveRuns.release(run);
				outcome = "chain_user_input";
				return outcome;
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
				if (toolUse === "tool_use") {
					outcome = "tool_use";
					return outcome;
				}
				if (toolUse === "handled") continue;
				const event = cursorLiveRuns.shiftEvent(run);
				if (!event || event.type === "tool" || event.type === "bridge-tool") continue;
				if (options.mode === "emit") emitCursorLiveQueuedEvent(turn, event, run);
			}

			if (run.resources.kind !== "open") {
				partial.stopReason = "aborted";
				partial.errorMessage = formatCursorSdkAbortMessage(
					resolveCursorSdkAbortCause({ liveRunDisposed: true }),
				);
				stream.push({ type: "error", reason: "aborted", error: partial });
				outcome = "aborted";
				outcomeDetails = { reason: "disposed" };
				return outcome;
			}
			const sdkOutcome = run.outcome;
			switch (sdkOutcome.kind) {
				case "running":
					await cursorLiveRuns.waitForProgress(run, options.signal);
					continue;
				case "cancelled":
					partial.stopReason = "aborted";
					partial.errorMessage = sdkOutcome.abortMessage;
					stream.push({ type: "error", reason: "aborted", error: partial });
					await cursorLiveRuns.release(run);
					outcome = "aborted";
					outcomeDetails = { reason: "cancelled" };
					return outcome;
				case "error":
					partial.stopReason = "error";
					partial.errorMessage = sdkOutcome.errorMessage;
					stream.push({ type: "error", reason: "error", error: partial });
					await cursorLiveRuns.release(run);
					outcome = "error";
					return outcome;
				case "finished": {
					if (options.mode === "chain_user_input") {
						await cursorLiveRuns.release(run);
						outcome = "chain_user_input";
						outcomeDetails = { reason: "run_done" };
						return outcome;
					}
					turn.emitter.closeAll();
					const finalText = trimCurrentTurnAlreadyEmittedCursorText(sdkOutcome.finalText, turn.emittedText, run.emittedText);
					if (finalText) {
						await emitTextDeltas(turn.emitter, splitTextIntoReplayDeltas(finalText));
					}
					applyCursorUsage(partial, model, context, cursorLiveRuns.takeTurnInputTokens(run, toolResultInputTokens), {
						runtime: "local",
						turn: cursorLiveRuns.takeSdkTurnUsage(run),
						occupancyFloor: options.occupancyFloor,
					});
					if (run.resumeNotice) {
						emitDisplayOnlyTraceBlock(stream, partial, run.resumeNotice);
						run.resumeNotice = undefined;
					}
					run.resumePublication?.publish();
					partial.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: partial });
					await cursorLiveRuns.release(run);
					outcome = "stop";
					outcomeDetails = { finalTextLength: finalText.length };
					return outcome;
				}
				default: {
					const _exhaustive: never = sdkOutcome;
					return _exhaustive;
				}
			}
		}
	} catch (error) {
		if (!outcome) {
			if (error instanceof CursorLiveRunAbortError) {
				outcome = "aborted";
				outcomeDetails = { reason: "signal_aborted" };
			} else {
				outcome = "error";
				outcomeDetails = {
					reason: "drain_error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
			}
		}
		throw error;
	} finally {
		debugRecorder?.recordDrainEvent("turn_end", {
			outcome: outcome ?? "error",
			runId: run.id,
			pendingEventCount: run.pendingEvents.length,
			sdkOutcome: run.outcome.kind,
			...outcomeDetails,
		});
	}
}

export async function drainExistingCursorLiveRunBeforeSend(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	signal: AbortSignal | undefined,
	turnDebugRecorder: CursorSdkEventDebugRecorder | undefined,
	scopeKey: string,
	occupancyFloor?: number,
	nativeToolsEnabled = true,
): Promise<LiveRunPreSendOutcome> {
	turnDebugRecorder?.recordDrainEvent("pre_send_start", {});
	while (true) {
		const run = getPendingCursorLiveRun(context, scopeKey) ?? getActiveCursorLiveRunForCurrentScope(scopeKey);
		if (!run) {
			turnDebugRecorder?.recordDrainEvent("pre_send_end", { outcome: "continue_send", reason: "no_pending_run" });
			return "continue_send";
		}

		try {
			const outcome = await cursorLiveRuns.withRunLease(run, signal, async () => {
				if (run.resources.kind !== "open") return "continue_send" as const;
				// Check under the drain lease, before consuming/delivering Pi results:
				// resolving a bridge waiter can resume the SDK's old tool surface.
				if ((run.nativeToolsEnabled !== false) !== nativeToolsEnabled) {
					throw new Error("Cursor native tool policy changed while a local run is pending; restore the prior policy to finish it or run /cursor-abort before retrying. Already-executed work is not undone.");
				}
				const consumed = cursorLiveRuns.consumeToolResults(run, context, getCursorNativeReplayIdFromToolCallId);
				await run.bridgeRun?.resolveToolResults(consumed.toolResults);
				const shouldChainUserInput = run.chainUserInputAfterCompletion || hasTrailingUserMessagesAfterToolResults(context);
				if (shouldChainUserInput) run.chainUserInputAfterCompletion = true;
				while (!cursorLiveRuns.isReady(run)) {
					await cursorLiveRuns.waitForProgress(run, signal);
				}
				if (run.resources.kind !== "open") return "continue_send" as const;
				const drainOutcome = await drainCursorLiveRunTurn(stream, partial, model, context, run, consumed.toolResultInputTokens, {
					mode: shouldChainUserInput ? "chain_user_input" : "emit",
					signal,
					debugRecorder: turnDebugRecorder,
					occupancyFloor,
				});
				const mapped = drainOutcome === "chain_user_input" ? "continue_send" : "stream_ended";
				turnDebugRecorder?.recordDrainEvent("pre_send_iteration", {
					runId: run.id,
					drainOutcome,
					outcome: mapped,
					shouldChainUserInput,
				});
				return mapped;
			});
			if (outcome === "continue_send" && cursorLiveRuns.getActiveForScope(run.sessionAgentScopeKey) === run) {
				continue;
			}
			turnDebugRecorder?.recordDrainEvent("pre_send_end", { outcome, runId: run.id });
			return outcome;
		} catch (error) {
			turnDebugRecorder?.recordDrainEvent("pre_send_end", {
				outcome: error instanceof CursorLiveRunAbortError ? "aborted" : "error",
				runId: run.id,
				reason: error instanceof CursorLiveRunAbortError ? "signal_aborted" : "drain_error",
			});
			if (error instanceof CursorLiveRunAbortError) await cursorLiveRuns.release(run);
			throw error;
		}
	}
}

export function setCursorNativeReplayIdleDisposeMs(value: number): void {
	cursorNativeReplayIdleDisposeMsOverride = value;
}

export function resetCursorNativeReplayIdleDisposeMs(): void {
	cursorNativeReplayIdleDisposeMsOverride = undefined;
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
