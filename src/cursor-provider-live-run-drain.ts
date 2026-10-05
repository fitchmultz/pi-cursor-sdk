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

/** Keep live-run idle dispose aligned with cursor_ask_question UI blocking (#281). */
export function syncCursorLiveRunsAskQuestionBlocked(): void {
	cursorLiveRuns.syncIdleDisposeWithAskQuestionBlocked();
}

export function createCursorNativeReplayId(): string {
	cursorNativeReplayCounter += 1;
	return `cursor-replay-${Date.now()}-${cursorNativeReplayCounter}`;
}
