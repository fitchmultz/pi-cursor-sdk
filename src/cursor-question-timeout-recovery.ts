import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_PROVIDER } from "./cursor-model.js";
import { isCursorPiBridgeToolCallId } from "./cursor-pi-tool-bridge-constants.js";
import { getRegisteredCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import {
	CURSOR_ASK_QUESTION_ANSWERED_EVENT,
	CURSOR_ASK_QUESTION_BLOCKED_EVENT,
	type CursorAskQuestionAnsweredEventPayload,
	type CursorAskQuestionBlockedEventPayload,
} from "./cursor-question-tool.js";

export const CURSOR_ASK_QUESTION_CONTINUE_PROMPT = "continue";
export const CURSOR_ASK_QUESTION_TIMEOUT_RECOVERY_COOLDOWN_MS = 15_000;

export function isCursorAskQuestionTimeoutErrorMessage(errorMessage: string | undefined): boolean {
	const message = errorMessage?.trim();
	if (!message) return false;
	return (
		/\bMCP tool call timed out\b/i.test(message) ||
		/\bRequest timed out\b/i.test(message) ||
		/\bCallTool timed out\b/i.test(message) ||
		/\bpi bridge CallTool timed out\b/i.test(message)
	);
}

export function shouldQueueCursorAskQuestionContinue(options: {
	message: AssistantMessage;
	isCursorProvider: boolean;
	questionActive: boolean;
	lastQueuedAtMs?: number;
	nowMs: number;
	cooldownMs?: number;
}): boolean {
	const { message, isCursorProvider, questionActive, lastQueuedAtMs, nowMs } = options;
	const cooldownMs = options.cooldownMs ?? CURSOR_ASK_QUESTION_TIMEOUT_RECOVERY_COOLDOWN_MS;
	if (!isCursorProvider || message.stopReason !== "error") return false;
	if (questionActive) return false;
	if (!isCursorAskQuestionTimeoutErrorMessage(message.errorMessage)) return false;
	if (lastQueuedAtMs !== undefined && nowMs - lastQueuedAtMs < cooldownMs) return false;
	return true;
}

export type CursorAskQuestionTimeoutRecoveryApi = Pick<ExtensionAPI, "on" | "events" | "sendUserMessage">;

/**
 * Late `cursor_ask_question` answers: if the bridge CallTool is already gone,
 * deliver the answer as a follow-up. If Cursor timed out after the question UI
 * closed (no answer to deliver), queue a bare `continue` so the turn can resume
 * without `/reload` — intentional for abandoned/expired question UIs.
 */
export function registerCursorAskQuestionTimeoutRecovery(
	pi: CursorAskQuestionTimeoutRecoveryApi,
	options: { cooldownMs?: number; now?: () => number } = {},
): void {
	const cooldownMs = options.cooldownMs ?? CURSOR_ASK_QUESTION_TIMEOUT_RECOVERY_COOLDOWN_MS;
	const now = options.now ?? Date.now;
	let questionActive = false;
	let lastContinueQueuedAtMs: number | undefined;

	pi.events.on(CURSOR_ASK_QUESTION_BLOCKED_EVENT, (payload: unknown) => {
		questionActive = (payload as CursorAskQuestionBlockedEventPayload).active === true;
	});

	pi.events.on(CURSOR_ASK_QUESTION_ANSWERED_EVENT, (payload: unknown) => {
		const answered = payload as CursorAskQuestionAnsweredEventPayload;
		if (answered.cancelled || !answered.summary.trim()) return;
		if (!isCursorPiBridgeToolCallId(answered.toolCallId)) return;
		const bridge = getRegisteredCursorPiToolBridge();
		if (bridge?.hasPendingPiToolCallId(answered.toolCallId)) return;
		pi.sendUserMessage(answered.summary, { deliverAs: "followUp" });
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const isCursorProvider = message.provider === CURSOR_PROVIDER || ctx.model?.provider === CURSOR_PROVIDER;
		const nowMs = now();
		if (
			!shouldQueueCursorAskQuestionContinue({
				message,
				isCursorProvider,
				questionActive,
				lastQueuedAtMs: lastContinueQueuedAtMs,
				nowMs,
				cooldownMs,
			})
		) {
			return;
		}
		lastContinueQueuedAtMs = nowMs;
		notifyContinueQueued(ctx);
		pi.sendUserMessage(CURSOR_ASK_QUESTION_CONTINUE_PROMPT, { deliverAs: "followUp" });
	});
}

function notifyContinueQueued(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		"Cursor timed out waiting for the question — continuing without /reload.",
		"warning",
	);
}
