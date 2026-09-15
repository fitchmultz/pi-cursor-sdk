import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_PROVIDER } from "./cursor-model.js";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
} from "./cursor-provider-errors.js";

/**
 * After Cursor SDK auth failures or stale-connection aborts (common when a
 * question sat unanswered and the backend timed out), reload the extension
 * runtime and continue the turn.
 *
 * Built-in `/reload` cannot be triggered via `sendUserMessage` — that string is
 * sent to the model. Register `/cursor-sdk-recover` and invoke it with
 * `expandPromptTemplates: true` once idle.
 *
 * Late ask-question answers are re-delivered when something emits
 * `pi-cursor-sdk:ask-question:answered` (see the ask-question timeout PR).
 */
export const CURSOR_SDK_RECOVER_COMMAND = "cursor-sdk-recover";
export const CURSOR_SDK_RECOVER_SLASH = `/${CURSOR_SDK_RECOVER_COMMAND}`;
export const CURSOR_SDK_RECOVER_COOLDOWN_MS = 60_000;
export const CURSOR_SDK_RECOVER_ENTRY_TYPE = "pi-cursor-sdk:auto-recover";
export const CURSOR_SDK_RECOVER_CONTINUE_PROMPT = "continue";
/** Backup dispatch delay after message_end if agent_settled was already missed. */
export const CURSOR_SDK_RECOVER_DISPATCH_DELAY_MS = 50;

/** Same channel as cursor-question-tool's ANSWERED emit (owned by that module / #255). */
const CURSOR_ASK_QUESTION_ANSWERED_EVENT = "pi-cursor-sdk:ask-question:answered";

type CursorAskQuestionAnsweredEventPayload = {
	toolCallId?: string;
	summary?: string;
	cancelled?: boolean;
};

const AUTH_FAILURE_MESSAGES = new Set([
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
]);

export type CursorSdkRecoverReason = "auth" | "abort";

export type CursorSdkRecoverEntryData = {
	reason: CursorSdkRecoverReason;
	/** When true, session_start(reason=reload) should kick off a continue turn. */
	continue: boolean;
	atMs: number;
	answerSummary?: string;
};

export function isCursorAuthFailureErrorMessage(errorMessage: string | undefined): boolean {
	const message = errorMessage?.trim();
	if (!message) return false;
	if (AUTH_FAILURE_MESSAGES.has(message)) return true;
	return (
		/Cursor SDK API key may be invalid or unauthorized/i.test(message) ||
		/Cursor SDK runs require a Cursor SDK API key/i.test(message) ||
		/Cloud API authentication rejected the API key/i.test(message)
	);
}

/** Stale SDK aborts after idle questions. Ignore intentional user cancels. */
export function isCursorRecoverableAbortErrorMessage(errorMessage: string | undefined): boolean {
	const message = errorMessage?.trim();
	if (!message) return false;
	if (/^Cancelled:\s*prompt interrupted\.?$/i.test(message)) return false;
	if (/^Cancelled:\s*Cursor SDK run was cancelled\.?$/i.test(message)) return false;
	return (
		/\bThis operation was aborted\b/i.test(message) ||
		/\bThe operation was aborted\b/i.test(message) ||
		(/\[canceled\]/i.test(message) && /operation was aborted/i.test(message)) ||
		(/\[aborted\]/i.test(message) && /operation was aborted/i.test(message)) ||
		/^Cancelled:\s*Cursor SDK run aborted\.?$/i.test(message)
	);
}

export function classifyCursorRecoverableErrorMessage(
	errorMessage: string | undefined,
): CursorSdkRecoverReason | undefined {
	if (isCursorAuthFailureErrorMessage(errorMessage)) return "auth";
	if (isCursorRecoverableAbortErrorMessage(errorMessage)) return "abort";
	return undefined;
}

export function shouldQueueCursorSdkRecover(options: {
	message: AssistantMessage;
	isCursorProvider: boolean;
	lastQueuedAtMs?: number;
	nowMs: number;
	cooldownMs?: number;
}): CursorSdkRecoverReason | undefined {
	const { message, isCursorProvider, lastQueuedAtMs, nowMs } = options;
	const cooldownMs = options.cooldownMs ?? CURSOR_SDK_RECOVER_COOLDOWN_MS;
	if (!isCursorProvider || message.stopReason !== "error") return undefined;
	const reason = classifyCursorRecoverableErrorMessage(message.errorMessage);
	if (!reason) return undefined;
	if (lastQueuedAtMs !== undefined && nowMs - lastQueuedAtMs < cooldownMs) return undefined;
	return reason;
}

export function buildCursorSdkRecoverContinuePrompt(options?: { answerSummary?: string }): string {
	const answer = options?.answerSummary?.trim();
	if (!answer) return CURSOR_SDK_RECOVER_CONTINUE_PROMPT;
	return `${CURSOR_SDK_RECOVER_CONTINUE_PROMPT}\n\n${answer}`;
}

export function softenCursorRecoverableErrorMessage(
	message: AssistantMessage,
	reason: CursorSdkRecoverReason,
): AssistantMessage {
	const detail =
		reason === "auth"
			? "Cursor SDK auth failed — auto-reloading, then continuing."
			: "Cursor SDK connection aborted — auto-reloading, then continuing.";
	return {
		...message,
		errorMessage: detail,
		content: [{ type: "text", text: detail }],
	};
}

export type CursorSdkRecoverExtensionApi = Omit<
	Pick<ExtensionAPI, "on" | "sendUserMessage" | "registerCommand" | "appendEntry" | "events">,
	"sendUserMessage"
> & {
	sendUserMessage: (
		content: string,
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	) => void;
};

export type CursorSdkRecoverHandlerOptions = {
	cooldownMs?: number;
	now?: () => number;
	dispatchDelayMs?: number;
	schedule?: (fn: () => void, delayMs: number) => void;
};

type PendingRecover = {
	reason: CursorSdkRecoverReason;
	queuedAtMs: number;
	answerSummary?: string;
};

/**
 * - message_end: detect auth/abort, soften visible error, schedule recover
 * - agent_settled: primary dispatch of `/cursor-sdk-recover`
 * - message_end timer: backup if settle already fired
 * - session_start(reload): continue (with late question answer if any)
 */
export function registerCursorSdkRecover(
	pi: CursorSdkRecoverExtensionApi,
	options: CursorSdkRecoverHandlerOptions = {},
): void {
	const cooldownMs = options.cooldownMs ?? CURSOR_SDK_RECOVER_COOLDOWN_MS;
	const now = options.now ?? Date.now;
	const dispatchDelayMs = options.dispatchDelayMs ?? CURSOR_SDK_RECOVER_DISPATCH_DELAY_MS;
	const schedule = options.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
	let lastQueuedAtMs: number | undefined;
	let pending: PendingRecover | undefined;
	let recoverDispatched = false;
	let lastAnswerSummary: string | undefined;

	pi.registerCommand(CURSOR_SDK_RECOVER_COMMAND, {
		description: "Reload after a Cursor SDK auth or aborted-connection error, then continue",
		handler: async (_args, ctx) => {
			const reason = pending?.reason ?? "auth";
			const answerSummary = pending?.answerSummary ?? lastAnswerSummary;
			pending = undefined;
			recoverDispatched = false;
			pi.appendEntry<CursorSdkRecoverEntryData>(CURSOR_SDK_RECOVER_ENTRY_TYPE, {
				reason,
				continue: true,
				atMs: now(),
				...(answerSummary ? { answerSummary } : {}),
			});
			await ctx.reload();
		},
	});

	pi.events?.on?.(CURSOR_ASK_QUESTION_ANSWERED_EVENT, (payload: unknown) => {
		const answered = payload as CursorAskQuestionAnsweredEventPayload;
		if (answered?.cancelled || !answered?.summary?.trim()) return;
		lastAnswerSummary = answered.summary.trim();
		if (pending) pending = { ...pending, answerSummary: lastAnswerSummary };
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		const isCursorProvider = message.provider === CURSOR_PROVIDER || ctx.model?.provider === CURSOR_PROVIDER;
		const nowMs = now();
		const reason = shouldQueueCursorSdkRecover({
			message,
			isCursorProvider,
			lastQueuedAtMs,
			nowMs,
			cooldownMs,
		});
		if (!reason) return;

		lastQueuedAtMs = nowMs;
		pending = {
			reason,
			queuedAtMs: nowMs,
			...(lastAnswerSummary ? { answerSummary: lastAnswerSummary } : {}),
		};
		recoverDispatched = false;
		notifyRecoverQueued(ctx, reason);
		// agent_settled is primary; this timer covers settle-before-message_end races.
		schedule(() => dispatchRecoverIfNeeded(), dispatchDelayMs);
		return { message: softenCursorRecoverableErrorMessage(message, reason) };
	});

	pi.on("agent_settled", () => {
		dispatchRecoverIfNeeded();
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") return;
		const entry = findLatestPendingRecoverEntry(ctx.sessionManager.getEntries?.() ?? [], now());
		if (!entry) return;
		pi.appendEntry<CursorSdkRecoverEntryData>(CURSOR_SDK_RECOVER_ENTRY_TYPE, {
			reason: entry.reason,
			continue: false,
			atMs: now(),
		});
		const answerSummary = entry.answerSummary?.trim() || lastAnswerSummary;
		lastAnswerSummary = undefined;
		notifyRecoverContinue(ctx, entry.reason);
		const prompt = buildCursorSdkRecoverContinuePrompt({ answerSummary });
		schedule(() => pi.sendUserMessage(prompt), 0);
	});

	function dispatchRecoverIfNeeded(): void {
		if (!pending || recoverDispatched) return;
		if (now() - pending.queuedAtMs > cooldownMs) {
			pending = undefined;
			return;
		}
		recoverDispatched = true;
		pi.sendUserMessage(CURSOR_SDK_RECOVER_SLASH, { expandPromptTemplates: true });
	}
}

function findLatestPendingRecoverEntry(
	entries: Array<{ type?: string; customType?: string; data?: unknown }>,
	nowMs: number,
): CursorSdkRecoverEntryData | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== CURSOR_SDK_RECOVER_ENTRY_TYPE) continue;
		const data = entry.data as CursorSdkRecoverEntryData | undefined;
		if (!data || typeof data.atMs !== "number") continue;
		if (!data.continue) return undefined;
		if (nowMs - data.atMs > CURSOR_SDK_RECOVER_COOLDOWN_MS) return undefined;
		return data;
	}
	return undefined;
}

function notifyRecoverQueued(ctx: Pick<ExtensionContext, "hasUI" | "ui">, reason: CursorSdkRecoverReason): void {
	if (!ctx.hasUI) return;
	const detail =
		reason === "auth"
			? "Cursor auth failed — reloading to re-read credentials"
			: "Cursor connection aborted — reloading (common after a long-idle question)";
	ctx.ui.notify(`${detail}, then continuing.`, "warning");
}

function notifyRecoverContinue(ctx: Pick<ExtensionContext, "hasUI" | "ui">, reason: CursorSdkRecoverReason): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`Cursor SDK recovered after ${reason} — continuing.`, "info");
}
