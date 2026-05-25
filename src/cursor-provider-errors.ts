import type { RunResult } from "@cursor/sdk";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";

export const MISSING_CURSOR_API_KEY_MESSAGE =
	"Cursor SDK runs require a Cursor API key. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.";
const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed. The API key may be missing, invalid, or unauthorized. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed because the API key may be invalid or unauthorized. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";

const GENERIC_CURSOR_RUN_FAILURE_TEXT = "cursor sdk run failed";

export type CursorSdkRunFailureSource = Pick<RunResult, "id" | "status" | "durationMs" | "model" | "result">;

function isGenericErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === "error" || normalized === "unknown error";
}

function isKnownGenericRunFailureText(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === GENERIC_CURSOR_RUN_FAILURE_TEXT || isGenericErrorMessage(normalized);
}

function isLikelyAuthError(message: string): boolean {
	return /\b(unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function shortRunId(runId: string): string {
	const trimmed = runId.trim();
	if (trimmed.length <= 12) return trimmed;
	return `${trimmed.slice(0, 8)}…`;
}

export function formatCursorSdkRunFailureDetail(result: CursorSdkRunFailureSource, runResult?: string): string {
	const fromWait = result.result?.trim();
	if (fromWait && !isKnownGenericRunFailureText(fromWait)) {
		return fromWait;
	}
	const fromRun = runResult?.trim();
	if (fromRun && !isKnownGenericRunFailureText(fromRun)) {
		return fromRun;
	}

	const parts = ["Cursor SDK run failed"];
	if (result.model?.id) parts.push(`model ${result.model.id}`);
	parts.push(`run ${shortRunId(result.id)}`);
	if (typeof result.durationMs === "number") parts.push(`${result.durationMs}ms`);
	return parts.join(" · ");
}

export type CursorSdkAbortCause = "user_interrupt" | "sdk_cancelled" | "live_run_disposed" | "unknown";

export function formatCursorSdkAbortMessage(cause: CursorSdkAbortCause): string {
	switch (cause) {
		case "user_interrupt":
			return "Cancelled: prompt interrupted.";
		case "sdk_cancelled":
			return "Cancelled: Cursor SDK run was cancelled.";
		case "live_run_disposed":
			return "Cancelled: Cursor SDK live run ended before completion.";
		case "unknown":
			return "Cancelled: Cursor SDK run aborted.";
	}
}

export function resolveCursorSdkAbortCause(options: {
	signalAborted?: boolean;
	sdkStatusCancelled?: boolean;
	liveRunDisposed?: boolean;
}): CursorSdkAbortCause {
	if (options.signalAborted) return "user_interrupt";
	if (options.sdkStatusCancelled) return "sdk_cancelled";
	if (options.liveRunDisposed) return "live_run_disposed";
	return "unknown";
}

export function sanitizeCursorProviderError(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message === MISSING_CURSOR_API_KEY_MESSAGE) return MISSING_CURSOR_API_KEY_MESSAGE;
	const scrubbed = scrubSensitiveText(message, apiKey).trim();
	if (isGenericErrorMessage(scrubbed)) return GENERIC_CURSOR_SDK_ERROR_MESSAGE;
	if (isLikelyAuthError(scrubbed)) return AUTH_CURSOR_SDK_ERROR_MESSAGE;
	return scrubbed || GENERIC_CURSOR_SDK_ERROR_MESSAGE;
}
