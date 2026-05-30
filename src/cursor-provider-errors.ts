import type { RunResult } from "@cursor/sdk";
import { asRecord } from "./cursor-record-utils.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";

export const MISSING_CURSOR_API_KEY_MESSAGE =
	"Cursor SDK runs require a Cursor SDK API key. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.";
const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed. The Cursor SDK API key may be missing, invalid, or unauthorized. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed because the Cursor SDK API key may be invalid or unauthorized. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const NETWORK_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request timed out during network I/O. Check your connection and retry; if this keeps happening, try again later or verify Cursor service availability.";

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
	return /\b(unauthenticated|unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function getErrorStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function getErrorStack(error: unknown, record: Record<string, unknown> | undefined): string {
	return error instanceof Error ? error.stack ?? "" : getErrorStringField(record, "stack") ?? "";
}

function isConnectError(error: unknown, record: Record<string, unknown> | undefined): boolean {
	const name = error instanceof Error ? error.name : getErrorStringField(record, "name");
	return name === "ConnectError";
}

function isUnauthenticatedConnectCode(code: unknown): boolean {
	return code === 16 || (typeof code === "string" && /^(?:16|unauthenticated)$/i.test(code));
}

function isCursorExtensionConnectStack(stack: string): boolean {
	return stack.includes("@connectrpc/connect-node") && /(?:^|[\\/])pi-cursor-sdk(?:[\\/]|$)/.test(stack);
}

function getCursorConnectSource(error: unknown, record: Record<string, unknown> | undefined): CursorConnectErrorSource {
	const stack = getErrorStack(error, record);
	if (stack.includes("@cursor/sdk")) return "cursor-sdk-stack";
	if (isCursorExtensionConnectStack(stack)) return "cursor-extension-connect-stack";
	const details = Array.isArray(record?.details) ? record.details : [];
	const hasCursorBackendDetails = details.some((detail) => {
		const type = getErrorStringField(asRecord(detail), "type");
		return typeof type === "string" && type.startsWith("aiserver.");
	});
	return hasCursorBackendDetails ? "cursor-backend-details" : "generic-connect";
}

export type CursorConnectErrorSource =
	| "cursor-sdk-stack"
	| "cursor-extension-connect-stack"
	| "cursor-backend-details"
	| "generic-connect";

export type CursorConnectErrorClassification =
	| { kind: "abort"; source: "cursor-sdk-stack" }
	| { kind: "unauthenticated"; source: CursorConnectErrorSource }
	| { kind: "network"; source: CursorConnectErrorSource };

export function classifyCursorConnectError(error: unknown): CursorConnectErrorClassification | undefined {
	const record = asRecord(error);
	if (!isConnectError(error, record)) return undefined;

	const message = error instanceof Error ? error.message : getErrorStringField(record, "message") ?? "";
	const rawMessage = getErrorStringField(record, "rawMessage") ?? message;
	const code = record?.code;
	const cause = asRecord(record?.cause);
	const causeName = getErrorStringField(cause, "name");
	const stack = getErrorStack(error, record);

	if (
		(code === 1 || code === "canceled") &&
		Boolean(rawMessage && /(?:operation was aborted|canceled)/i.test(rawMessage)) &&
		(causeName === "AbortError" || /AbortError/.test(stack)) &&
		stack.includes("@cursor/sdk") &&
		stack.includes("@connectrpc/connect-node")
	) {
		return { kind: "abort", source: "cursor-sdk-stack" };
	}

	if (isUnauthenticatedConnectCode(code) || isLikelyAuthError(`${message}\n${rawMessage}`)) {
		return { kind: "unauthenticated", source: getCursorConnectSource(error, record) };
	}

	const causeCode = getErrorStringField(cause, "code");
	const causeSyscall = getErrorStringField(cause, "syscall");
	if (isLikelyNetworkTimeout(`${message}\n${rawMessage}\n${causeCode ?? ""}\n${causeSyscall ?? ""}`)) {
		return { kind: "network", source: getCursorConnectSource(error, record) };
	}

	return undefined;
}

export function isCursorSdkAbortConnectError(error: unknown): boolean {
	return classifyCursorConnectError(error)?.kind === "abort";
}

export function isUnauthenticatedConnectError(error: unknown): boolean {
	return classifyCursorConnectError(error)?.kind === "unauthenticated";
}

function isLikelyNetworkTimeout(message: string): boolean {
	return (
		/\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)\b/i.test(message) ||
		/\bConnectError\b.*\b(unavailable|deadline|timeout|timed out)\b/i.test(message) ||
		/\bread ETIMEDOUT\b/i.test(message)
	);
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
	if (isUnauthenticatedConnectError(error) || isLikelyAuthError(scrubbed)) return AUTH_CURSOR_SDK_ERROR_MESSAGE;
	if (isGenericErrorMessage(scrubbed)) return GENERIC_CURSOR_SDK_ERROR_MESSAGE;
	if (isLikelyNetworkTimeout(scrubbed)) return NETWORK_CURSOR_SDK_ERROR_MESSAGE;
	return scrubbed || GENERIC_CURSOR_SDK_ERROR_MESSAGE;
}
