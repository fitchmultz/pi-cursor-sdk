import type { RunError, RunResult } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
import { asRecord } from "./cursor-record-utils.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";

export const MISSING_CURSOR_API_KEY_MESSAGE =
	"Cursor SDK runs require a Cursor SDK API key. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.";
const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed. The Cursor SDK API key may be missing, invalid, or unauthorized. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed because the Cursor SDK API key may be invalid or unauthorized. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor Cloud Agents request failed because Cloud API authentication rejected the API key. Use a user API key from Cursor Dashboard -> API Keys or a service account API key from Team settings; Team Admin API keys are not supported as Cursor Cloud Agents credentials. Configure the key with /login -> Use an API key -> Cursor, CURSOR_API_KEY, or --api-key, then retry.";
// Keep "Network error" aligned with pi's agent-level retry classifier.
const NETWORK_CURSOR_SDK_ERROR_MESSAGE =
	"Network error: Cursor SDK request failed during network or service I/O. Check your connection; pi will retry automatically when auto-retry is enabled.";

// Keep this phrase aligned with pi's agent-level retry classifier (`provider.?returned.?error`).
const RETRYABLE_CURSOR_RUN_FAILURE_PREFIX = "Provider returned error: Cursor SDK run failed";

export type CursorSdkRunFailureSource = Pick<RunResult, "id" | "requestId" | "status" | "durationMs" | "model" | "result" | "error">;

function isGenericErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === "error" || normalized === "unknown error";
}

function isGenericCursorRunFailureMessage(message: string): boolean {
	return /^cursor sdk run failed\.?$/i.test(message.trim());
}

function isKnownGenericRunFailureText(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || isGenericCursorRunFailureMessage(message) || isGenericErrorMessage(normalized);
}

function isLikelyAuthError(message: string): boolean {
	return /\b(unauthenticated|unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function getErrorStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function getErrorName(error: unknown, record: Record<string, unknown> | undefined): string | undefined {
	return error instanceof Error ? error.name : getErrorStringField(record, "name");
}

function scrubHttpsHelpUrl(helpUrl: string | undefined, apiKey: string | undefined): string | undefined {
	if (!helpUrl) return undefined;
	try {
		const url = new URL(helpUrl);
		if (url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.pathname = url.pathname
			.split("/")
			.map((segment) => {
				const decoded = decodeURIComponent(segment);
				const scrubbed = scrubSensitiveText(decoded, apiKey);
				return scrubbed === decoded ? segment : encodeURIComponent(scrubbed);
			})
			.join("/");
		const scrubbedParams = new URLSearchParams();
		for (const [name, value] of url.searchParams) {
			const scrubbedName = scrubSensitiveText(name, apiKey);
			const scrubbedPair = scrubSensitiveText(`${name}=${value}`, apiKey);
			scrubbedParams.append(scrubbedName, scrubbedPair === `${name}=${value}` ? value : "[redacted]");
		}
		url.search = scrubbedParams.toString();
		if (url.hash) {
			const decoded = decodeURIComponent(url.hash.slice(1));
			const scrubbed = scrubSensitiveText(decoded, apiKey);
			if (scrubbed !== decoded) url.hash = encodeURIComponent(scrubbed);
		}
		return scrubSensitiveText(url.href, apiKey).trim() || undefined;
	} catch {
		return undefined;
	}
}

function formatIntegrationNotConnectedError(
	error: unknown,
	record: Record<string, unknown> | undefined,
	scrubbedMessage: string,
	apiKey: string | undefined,
): string | undefined {
	if (getErrorName(error, record) !== "IntegrationNotConnectedError") return undefined;
	const provider = scrubSensitiveText(getErrorStringField(record, "provider") ?? "", apiKey).trim();
	if (!provider) return undefined;
	const message = scrubbedMessage || "Cursor Cloud integration is not connected.";
	const punctuation = /[.!?]$/.test(message) ? "" : ".";
	const helpUrl = scrubHttpsHelpUrl(getErrorStringField(record, "helpUrl"), apiKey);
	return `${message}${punctuation} Connect the ${provider} integration${helpUrl ? `: ${helpUrl}` : "."}`;
}

function getErrorStack(error: unknown, record: Record<string, unknown> | undefined): string {
	return error instanceof Error ? error.stack ?? "" : getErrorStringField(record, "stack") ?? "";
}

const CONNECT_ERROR_EVIDENCE_KEYS = ["name", "message", "rawMessage", "code", "syscall"] as const;

function getErrorEvidenceField(
	value: unknown,
	record: Record<string, unknown> | undefined,
	key: (typeof CONNECT_ERROR_EVIDENCE_KEYS)[number],
): string | undefined {
	if (value instanceof Error && (key === "name" || key === "message")) return value[key] || undefined;
	const field = record?.[key];
	if (typeof field === "string") return field;
	if (typeof field === "number") return String(field);
	return undefined;
}

function collectConnectErrorEvidence(error: unknown, record: Record<string, unknown> | undefined): string {
	const evidence: string[] = [];
	let value = error;
	let currentRecord = record;
	for (let depth = 0; depth < 3 && currentRecord; depth += 1) {
		for (const key of CONNECT_ERROR_EVIDENCE_KEYS) {
			const field = getErrorEvidenceField(value, currentRecord, key)?.trim();
			if (field) evidence.push(field);
		}
		value = currentRecord.cause;
		currentRecord = asRecord(value);
	}
	return evidence.join("\n");
}

function collectConnectErrorStacks(error: unknown, record: Record<string, unknown> | undefined): string {
	const stacks: string[] = [];
	let value = error;
	let currentRecord = record;
	for (let depth = 0; depth < 3 && currentRecord; depth += 1) {
		const stack = getErrorStack(value, currentRecord).trim();
		if (stack) stacks.push(stack);
		value = currentRecord.cause;
		currentRecord = asRecord(value);
	}
	return stacks.join("\n");
}

function isConnectError(error: unknown, record: Record<string, unknown> | undefined): boolean {
	const name = error instanceof Error ? error.name : getErrorStringField(record, "name");
	return name === "ConnectError";
}

function isUnauthenticatedConnectCode(code: unknown): boolean {
	return code === 16 || (typeof code === "string" && /^(?:16|unauthenticated)$/i.test(code));
}

function isUnavailableConnectCode(code: unknown): boolean {
	return code === 14 || (typeof code === "string" && /^(?:14|unavailable)$/i.test(code));
}

function isCursorSdkStallAbortNetworkError(code: unknown, evidence: string, stackEvidence: string): boolean {
	return (
		(code === 2 || (typeof code === "string" && /^(?:2|unknown)$/i.test(code))) &&
		/(?:operation was aborted|canceled)/i.test(evidence) &&
		/(?:AbortError|operation was aborted)/i.test(`${evidence}\n${stackEvidence}`) &&
		stackEvidence.includes("@cursor/sdk") &&
		stackEvidence.includes("@connectrpc/connect-node") &&
		/\b(?:onStall|reportStall|StallDetected)\b/i.test(stackEvidence)
	);
}

/**
 * @cursor/sdk@1.0.27 throws internal RetriableError (name/kind "RetriableError") with message
 * "Connection stalled" or "Connection stalled repeatedly" after fetchWithRetry exhausts stalls.
 * The ConnectError is only the cause; the top-level error is not a ConnectError.
 */
export function isCursorSdkConnectionStalledError(error: unknown): boolean {
	const record = asRecord(error);
	if (!record) return false;
	const name = getErrorName(error, record) ?? getErrorStringField(record, "kind");
	if (name !== "RetriableError") return false;
	const message = (error instanceof Error ? error.message : getErrorStringField(record, "message") ?? "").trim();
	if (!/^Connection stalled(?: repeatedly)?$/i.test(message)) return false;
	const stack = getErrorStack(error, record);
	return /(?:^|[\\/])node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(stack) || stack.includes("@cursor/sdk");
}

function isCursorExtensionConnectStack(stack: string): boolean {
	// pi runs Cursor SDK in Node, where the SDK dynamically imports connect-node.
	// connect-web is the SDK's Bun/Deno path and is intentionally not classified for supported pi runs.
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
	if (hasCursorBackendDetails) return "cursor-backend-details";
	return stack.includes("@connectrpc/connect-node") ? "connect-node-stack" : "generic-connect";
}

export type CursorConnectErrorSource =
	| "cursor-sdk-stack"
	| "cursor-extension-connect-stack"
	| "cursor-backend-details"
	| "connect-node-stack"
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
	const evidence = collectConnectErrorEvidence(error, record);
	const stackEvidence = collectConnectErrorStacks(error, record);

	if (
		(code === 1 || code === "canceled") &&
		Boolean(rawMessage && /(?:operation was aborted|canceled)/i.test(rawMessage)) &&
		(causeName === "AbortError" || /AbortError/.test(stack)) &&
		stack.includes("@cursor/sdk") &&
		stack.includes("@connectrpc/connect-node")
	) {
		return { kind: "abort", source: "cursor-sdk-stack" };
	}

	if (isCursorSdkStallAbortNetworkError(code, evidence, stackEvidence)) {
		return { kind: "network", source: getCursorConnectSource(error, record) };
	}

	if (isUnauthenticatedConnectCode(code) || isLikelyAuthError(evidence)) {
		return { kind: "unauthenticated", source: getCursorConnectSource(error, record) };
	}

	if (isUnavailableConnectCode(code)) {
		return { kind: "network", source: getCursorConnectSource(error, record) };
	}

	if (isLikelyNetworkTimeout(evidence)) {
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
		/\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|NGHTTP2_ENHANCE_YOUR_CALM|ERR_HTTP2_STREAM_ERROR|ERR_HTTP2_SESSION_ERROR)\b/i.test(
			message,
		) ||
		/\bConnectError\b.*\b(unavailable|deadline|timeout|timed out)\b/i.test(message) ||
		/\b(?:stream|session) closed with error code\b/i.test(message) ||
		/\bread ETIMEDOUT\b/i.test(message)
	);
}

function shortRunId(runId: string): string {
	const trimmed = runId.trim();
	if (trimmed.length <= 12) return trimmed;
	return `${trimmed.slice(0, 8)}…`;
}

function runErrorCode(error: RunError | undefined): string | undefined {
	return error?.code?.trim() || undefined;
}

function nonGenericRunErrorMessage(error: RunError | undefined): string | undefined {
	const message = error?.message?.trim();
	return message && !isKnownGenericRunFailureText(message) ? message : undefined;
}

function withRunErrorCode(message: string, code: string | undefined): string {
	return code ? `${message} (code: ${code})` : message;
}

export function formatCursorSdkRunFailureDetail(
	result: CursorSdkRunFailureSource,
	runResult?: string,
	runError?: RunError,
): string {
	const errorCode = runErrorCode(result.error) ?? runErrorCode(runError);
	const fromWaitError = nonGenericRunErrorMessage(result.error);
	if (fromWaitError) return withRunErrorCode(fromWaitError, errorCode);

	const fromWait = result.result?.trim();
	if (fromWait && !isKnownGenericRunFailureText(fromWait)) {
		return withRunErrorCode(fromWait, errorCode);
	}

	const fromRunError = nonGenericRunErrorMessage(runError);
	if (fromRunError) return withRunErrorCode(fromRunError, errorCode);

	const fromRun = runResult?.trim();
	if (fromRun && !isKnownGenericRunFailureText(fromRun)) {
		return withRunErrorCode(fromRun, errorCode);
	}

	const parts = [RETRYABLE_CURSOR_RUN_FAILURE_PREFIX];
	if (errorCode) parts.push(`code ${errorCode}`);
	if (result.model?.id) parts.push(`model ${result.model.id}`);
	parts.push(`run ${shortRunId(result.id)}`);
	if (result.requestId) parts.push(`request ${shortRunId(result.requestId)}`);
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

export function sanitizeCursorProviderError(
	error: unknown,
	apiKey?: string,
	runtimeTarget?: CursorRuntime,
): string {
	const record = asRecord(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message === MISSING_CURSOR_API_KEY_MESSAGE) return MISSING_CURSOR_API_KEY_MESSAGE;
	const scrubbed = scrubSensitiveText(message, apiKey).trim();
	const integrationMessage = runtimeTarget === "cloud"
		? formatIntegrationNotConnectedError(error, record, scrubbed, apiKey)
		: undefined;
	if (integrationMessage) return integrationMessage;
	const connectClassification = classifyCursorConnectError(error);
	if (
		(runtimeTarget === "cloud" && getErrorName(error, record) === "AuthenticationError") ||
		connectClassification?.kind === "unauthenticated" ||
		isLikelyAuthError(scrubbed)
	) {
		return runtimeTarget === "cloud" ? CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE : AUTH_CURSOR_SDK_ERROR_MESSAGE;
	}
	if (connectClassification?.kind === "network" || isCursorSdkConnectionStalledError(error) || isLikelyNetworkTimeout(scrubbed)) return NETWORK_CURSOR_SDK_ERROR_MESSAGE;
	if (isGenericCursorRunFailureMessage(scrubbed)) return RETRYABLE_CURSOR_RUN_FAILURE_PREFIX;
	if (isGenericErrorMessage(scrubbed)) return GENERIC_CURSOR_SDK_ERROR_MESSAGE;
	return scrubbed || GENERIC_CURSOR_SDK_ERROR_MESSAGE;
}
