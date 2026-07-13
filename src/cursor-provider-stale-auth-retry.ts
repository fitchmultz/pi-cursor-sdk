import {
	isRetryableStaleCursorSessionAuthError,
	shouldRetryStaleCursorSessionAuth,
	STALE_CURSOR_SESSION_AUTH_ERROR_MESSAGE,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import type { SessionCursorAgentLease } from "./cursor-session-agent.js";
import type { CursorProviderTurnPrepareResult } from "./cursor-provider-turn-types.js";

export class CursorStaleSessionAuthRetryError extends Error {
	readonly causeError: unknown;

	constructor(causeError: unknown) {
		super("Cursor stale session auth retry");
		this.name = "CursorStaleSessionAuthRetryError";
		this.causeError = causeError;
	}
}

export function liveRunHasAssistantProgress(run: CursorLiveRun): boolean {
	return (
		run.textDeltas.length > 0 ||
		run.emittedText.length > 0 ||
		run.pendingEvents.length > 0 ||
		run.recordedToolDisplayIds.length > 0 ||
		Boolean(run.finalText)
	);
}

export function shouldRetryPreparedStaleSessionAuth(options: {
	error: unknown;
	prepared: CursorProviderTurnPrepareResult | undefined;
	alreadyRetried: boolean;
	signalAborted?: boolean;
}): boolean {
	const lease = options.prepared?.sessionAgentLease;
	return shouldRetryStaleCursorSessionAuth({
		error: options.error,
		reusedPooledAgent: lease?.created === false,
		alreadyRetried: options.alreadyRetried,
		runtimeTarget: options.prepared?.runtimeTarget === "cloud" ? "cloud" : "local",
		signalAborted: options.signalAborted,
	});
}

export function shouldMarkLiveRunStaleAuthRetry(options: {
	error: unknown;
	lease: SessionCursorAgentLease | undefined;
	liveRun: CursorLiveRun;
	alreadyRetried: boolean;
	signalAborted?: boolean;
}): boolean {
	if (liveRunHasAssistantProgress(options.liveRun)) return false;
	return shouldRetryStaleCursorSessionAuth({
		error: options.error,
		reusedPooledAgent: options.lease?.created === false,
		alreadyRetried: options.alreadyRetried,
		runtimeTarget: "local",
		signalAborted: options.signalAborted,
	});
}

export function formatExhaustedStaleSessionAuthError(error: unknown, apiKey?: string): string {
	if (isRetryableStaleCursorSessionAuthError(error)) {
		return sanitizeCursorProviderError(error, apiKey, { staleSessionAuthExhausted: true });
	}
	return sanitizeCursorProviderError(error, apiKey);
}

export { isRetryableStaleCursorSessionAuthError, STALE_CURSOR_SESSION_AUTH_ERROR_MESSAGE };
