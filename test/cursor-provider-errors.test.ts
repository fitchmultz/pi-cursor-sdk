import { AuthenticationError, IntegrationNotConnectedError } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
	classifyCursorConnectError,
	isCursorSdkConnectionStalledError,
	formatCursorSdkAbortMessage,
	formatCursorSdkRunFailureDetail,
	isUnauthenticatedConnectError,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "../src/cursor-provider-errors.js";

function makeUnauthenticatedConnectError(): Error & { rawMessage: string; code: number; metadata: Headers } {
	const error = new Error("[unauthenticated] Error") as Error & { rawMessage: string; code: number; metadata: Headers };
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 16;
	error.metadata = new Headers({ authorization: "Bearer secret-key" });
	return error;
}

function makeCursorSdkNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = new Error("[aborted] read ECONNRESET") as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
	};
	error.name = "ConnectError";
	error.rawMessage = "read ECONNRESET";
	error.code = 10;
	error.cause = Object.assign(new Error("read ECONNRESET"), {
		code: "ECONNRESET",
		syscall: "read",
	});
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorSdkHttp2EnhanceYourCalmConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: Error & { rawMessage: string; code: string };
} {
	const error = new Error("[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM") as Error & {
		rawMessage: string;
		code: number;
		cause: Error & { rawMessage: string; code: string };
	};
	error.name = "ConnectError";
	error.rawMessage = "Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM";
	error.code = 2;
	error.cause = Object.assign(new Error("stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), {
		rawMessage: "stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
		code: "ERR_HTTP2_STREAM_ERROR",
	});
	error.stack =
		"ConnectError: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:71:20\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorSdkStallAbortWrapperConnectError(): Error & { rawMessage: string; code: number; cause: Error } {
	const cause = Object.assign(new Error("[canceled] This operation was aborted"), {
		name: "ConnectError",
		rawMessage: "This operation was aborted",
		code: 1,
		cause: new DOMException("This operation was aborted", "AbortError"),
	});
	cause.stack =
		"ConnectError: [canceled] This operation was aborted\n" +
		"    at ConnectError.from (file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:69:24)\n" +
		"    at connectErrorFromNodeReason (file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-error.js:52:29)\n" +
		"    at Object.reject (file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63)\n" +
		"    at AbortSignal.r (file:///repo/node_modules/@cursor/sdk/dist/esm/996.js:1:5705)\n" +
		"    at Y.onStall (file:///repo/node_modules/@cursor/sdk/dist/esm/357.js:1:75246)";
	const error = new Error("[unknown] [canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: Error;
	};
	error.name = "ConnectError";
	error.rawMessage = "[canceled] This operation was aborted";
	error.code = 2;
	error.cause = cause;
	error.stack =
		"ConnectError: [unknown] [canceled] This operation was aborted\n" +
		"    at a.from (file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1125976)\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/996.js:1:5832";
	return error;
}

function makeCursorSdkConnectionStalledRetriableError(
	message: "Connection stalled" | "Connection stalled repeatedly" = "Connection stalled repeatedly",
): Error & { kind: string; cause: Error } {
	const cause = new Error("[unknown] operation was aborted") as Error & { name: string; code: number };
	cause.name = "ConnectError";
	cause.code = 2;
	cause.stack =
		"ConnectError: [unknown] operation was aborted\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	const error = new Error(message) as Error & { kind: string; cause: Error };
	error.name = "RetriableError";
	error.kind = "RetriableError";
	error.cause = cause;
	error.stack =
		`RetriableError: ${message}\n` +
		"    at fe (file:///repo/node_modules/@cursor/sdk/dist/esm/357.js:1:62073)\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1125976";
	return error;
}

function makeCursorExtensionNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///C:/Users/example/.pi/agent/git/github.com/fitchmultz/pi-cursor-sdk/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeGenericConnectNodeNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:71:20\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-error.js:52:29\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeProvenanceFreeNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/some-other-connect-client/index.js:10:1";
	return error;
}

function makeCursorBackendUnavailableConnectError(): Error & {
	rawMessage: string;
	code: number;
	details: Array<{ type: string }>;
} {
	const error = new Error("[unavailable] Error") as Error & {
		rawMessage: string;
		code: number;
		details: Array<{ type: string }>;
	};
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 14;
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	error.stack =
		"ConnectError: [unavailable] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	return error;
}

describe("cursor-provider-errors", () => {
	it("preserves structured loader details and causes without blaming the key or leaking headers", () => {
		const error = {
			name: "ResolveMessage", code: "ERR_MODULE_NOT_FOUND",
			message: "Cannot find module '@cursor/sdk/auth' from '/extension/dist/cursor-sdk-runtime.js'",
			cause: { name: "SyntaxError", message: "The requested module '@bufbuild/protobuf' does not provide an export named 'protoBase64' Bearer secret-key" },
			headers: { authorization: "never-print-this-header" },
		};
		const message = sanitizeCursorProviderError(error, "secret-key", "local");
		expect(message).toContain("ResolveMessage");
		expect(message).toContain("ERR_MODULE_NOT_FOUND");
		expect(message).toContain(error.message);
		expect(message).toContain("SyntaxError");
		expect(message).toContain("protoBase64");
		expect(message).not.toMatch(/API key|\/login|secret-key|never-print-this-header/);
	});

	it("keeps loader causes ahead of generic authentication wrappers", () => {
		const message = sanitizeCursorProviderError(new Error("Authentication error", {
			cause: { name: "ResolveMessage", code: "MODULE_NOT_FOUND", message: "Cannot find module '@cursor/sdk'" },
		}), undefined, "local");
		expect(message).toContain("MODULE_NOT_FOUND");
		expect(message).toContain("Cannot find module");
		expect(message).not.toMatch(/API key|\/login/);
	});

	it("bounds cyclic error causes and scrubs before truncating", () => {
		const error = { name: "ResolveMessage", code: "ERR_MODULE_NOT_FOUND", message: `Cannot find module ${"x".repeat(1900)} Bearer secret-key`, cause: {} };
		error.cause = error;
		const message = sanitizeCursorProviderError(error, "secret-key");
		expect(message).toContain("ERR_MODULE_NOT_FOUND");
		expect(message.length).toBeLessThanOrEqual(6000);
		expect(message).not.toContain("secret-key");
	});

	it("does not diagnose an unknown failure or idle session authentication as a bad API key", () => {
		const detail = "Authentication error If you are logged in, try logging out and back in.";
		const message = sanitizeCursorProviderError(new Error(detail), "valid-key", "local");
		expect(message).toContain(detail);
		expect(message).not.toMatch(/API key|\/login|recreat|expired/i);
		expect(sanitizeCursorProviderError({})).not.toMatch(/API key|\/login/);
	});

	it.each(["Invalid API key", "API key revoked", "Revoked API key"])("retains actionable guidance for %s", (message) => {
		expect(sanitizeCursorProviderError({ name: "Error", message }, "secret-key", "local")).toContain("/login");
	});

	it("builds run metadata when SDK result text is the generic failure string", () => {
		const detail = formatCursorSdkRunFailureDetail({
			id: "run-abc123456789",
			requestId: "6e0d261c-86a2-4383-89f0-9162c1c10662",
			status: "error",
			result: "Cursor SDK run failed",
			model: { id: "composer-2.5" },
			durationMs: 1200,
		});

		expect(detail).toContain("Provider returned error");
		expect(detail).toContain("model composer-2.5");
		expect(detail).toContain("run run-abc1…");
		expect(detail).toContain("request 6e0d261c…");
		expect(detail).toContain("1200ms");
		expect(detail).not.toBe("Cursor SDK run failed");
	});

	it("prefers non-generic SDK result text", () => {
		const detail = formatCursorSdkRunFailureDetail({
			id: "run-1",
			status: "error",
			result: "MCP tool call timed out after 60s",
		});

		expect(detail).toBe("MCP tool call timed out after 60s");
	});

	it("preserves RunError terminal details and code", () => {
		const detail = formatCursorSdkRunFailureDetail({
			id: "run-error",
			status: "error",
			result: "Cursor SDK run failed",
			error: { message: "Backend rejected the run", code: "backend_rejected" },
		});

		expect(detail).toBe("Backend rejected the run (code: backend_rejected)");
	});

	it("uses run.error fallback when wait result text is generic", () => {
		const detail = formatCursorSdkRunFailureDetail(
			{ id: "run-error-fallback", status: "error", result: "Cursor SDK run failed" },
			undefined,
			{ message: "Run handle failure", code: "run_handle_error" },
		);

		expect(detail).toBe("Run handle failure (code: run_handle_error)");
	});

	it("falls back to run.result when wait result text is generic", () => {
		const detail = formatCursorSdkRunFailureDetail(
			{ id: "run-2", status: "error", result: "Cursor SDK run failed" },
			"ConnectError: read ETIMEDOUT",
		);

		expect(detail).toBe("ConnectError: read ETIMEDOUT");
	});

	it("scrubs secrets and maps explicit invalid keys to actionable auth guidance", () => {
		expect(sanitizeCursorProviderError(new Error("Error"), "test-key")).toContain("Cursor SDK request failed");
		expect(sanitizeCursorProviderError(new Error("Invalid API key Bearer secret-key"), "secret-key")).toContain(
			"invalid or unauthorized",
		);
		expect(sanitizeCursorProviderError(new Error("Bearer secret-key"), "secret-key")).not.toContain("secret-key");
	});

	it("uses the installed AuthenticationError class only for cloud guidance", () => {
		const error = new AuthenticationError("Invalid User API Key at https://alice:pw@api.cursor.com");
		const localMessage = "Cursor SDK request failed because the Cursor SDK API key may be invalid or unauthorized. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
		const cloudMessage =
			"Cursor Cloud Agents request failed because Cloud API authentication rejected the API key. Use a user API key from Cursor Dashboard -> API Keys or a service account API key from Team settings; Team Admin API keys are not supported as Cursor Cloud Agents credentials. Configure the key with /login -> Use an API key -> Cursor, CURSOR_API_KEY, or --api-key, then retry.";

		expect(sanitizeCursorProviderError(error, "secret-key")).toBe(localMessage);
		expect(sanitizeCursorProviderError(error, "secret-key", "local")).toBe(localMessage);
		expect(sanitizeCursorProviderError(error, "secret-key", "cloud")).toBe(cloudMessage);
		expect(cloudMessage).not.toMatch(/secret-key|alice|pw/);
	});

	it("preserves scrubbed installed IntegrationNotConnectedError remediation", () => {
		const error = new IntegrationNotConnectedError(
			"[integration_not_connected] GitHub integration requires Bearer secret-key.",
			{
				helpUrl: "https://alice:pw@cursor.com/settings/integrations?token=help-secret",
				provider: "github",
			},
		);
		const message = sanitizeCursorProviderError(error, "secret-key", "cloud");

		expect(message).toBe(
			"[integration_not_connected] GitHub integration requires Bearer [redacted]. Connect the github integration: https://cursor.com/settings/integrations?token=[redacted]",
		);
		expect(message).not.toMatch(/secret-key|help-secret|alice|pw@|Bearer secret-key/);
	});

	it.each([
		"https://cursor.com/settings/integrations/secret%2Fkey",
		"https://cursor.com/settings/integrations?next=secret%2Fkey",
		"https://cursor.com/settings/integrations#secret%2Fkey",
	])("scrubs an encoded API key from IntegrationNotConnectedError help URL %s", (helpUrl) => {
		const error = new IntegrationNotConnectedError("Connect the integration.", {
			helpUrl,
			provider: "github",
		});
		const message = sanitizeCursorProviderError(error, "secret/key", "cloud");

		expect(message).toContain("https://cursor.com/settings/integrations");
		expect(message).not.toMatch(/secret(?:%2F|\/)key/i);
	});

	it.each([
		"http://cursor.com/settings/integrations?token=secret-key",
		"javascript:alert('secret-key')",
		"not a URL with secret-key",
	])("omits non-HTTPS IntegrationNotConnectedError help URL %s", (helpUrl) => {
		const error = new IntegrationNotConnectedError("Connect the integration.", {
			helpUrl,
			provider: "github",
		});
		const message = sanitizeCursorProviderError(error, "secret-key", "cloud");

		expect(message).toBe("Connect the integration. Connect the github integration.");
		expect(message).not.toContain("secret-key");
	});

	it("preserves scrubbed run failure metadata in provider errors", () => {
		const detail = formatCursorSdkRunFailureDetail({ id: "run-3", status: "error" });
		const message = sanitizeCursorProviderError(detail, "test-key");

		expect(message).toContain("Provider returned error");
		expect(message).toContain("run run-3");
		expect(message).toContain("Cursor SDK run failed");
	});

	it("scrubs bridge endpoint material from non-generic SDK run failure detail", () => {
		const endpointToken = "secret-endpoint-token-provider";
		const sdkDetail = formatCursorSdkRunFailureDetail({
			id: "run-bridge-leak",
			status: "error",
			result: `MCP request failed for http://127.0.0.1:4321/cursor-pi-tool-bridge/${endpointToken}/mcp`,
		});
		const message = sanitizeCursorProviderError(sdkDetail, "test-key");

		expect(message).toContain("MCP request failed for [redacted-bridge-endpoint]");
		expect(message).not.toContain(endpointToken);
		expect(message).not.toContain("127.0.0.1");
		expect(message).not.toContain("/cursor-pi-tool-bridge/");
	});

	it("preserves unauthenticated ConnectError without diagnosing a rejected API key", () => {
		const error = makeUnauthenticatedConnectError();
		const message = sanitizeCursorProviderError(error, "secret-key");

		expect(isUnauthenticatedConnectError(error)).toBe(true);
		expect(message).toContain("Cursor SDK authentication failed");
		expect(message).toContain("ConnectError");
		expect(message).toContain("code: 16");
		expect(message).not.toMatch(/API key|\/login/);
		expect(message).not.toContain("secret-key");
		expect(message).not.toContain("Bearer");
	});

	it("maps connect-layer network failures to pi's retryable Network error classifier", () => {
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).toContain(
			"Network error",
		);
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).toContain(
			"failed during network or service I/O",
		);
		expect(sanitizeCursorProviderError("ConnectError: read ETIMEDOUT", "test-key")).toContain("Network error");
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).not.toContain(
			"ETIMEDOUT",
		);
	});

	it("classifies Cursor SDK network ConnectErrors without leaking raw network codes", () => {
		const error = makeCursorSdkNetworkConnectError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(message).toContain("Network error");
		expect(message).toContain("failed during network or service I/O");
		expect(message).not.toContain("ECONNRESET");
	});

	it("classifies Cursor SDK HTTP/2 stream backpressure ConnectErrors as retryable network failures", () => {
		const error = makeCursorSdkHttp2EnhanceYourCalmConnectError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(message).toContain("Network error");
		expect(message).not.toContain("NGHTTP2_ENHANCE_YOUR_CALM");
	});

	it("classifies Cursor SDK stall abort wrappers as retryable network failures", () => {
		const error = makeCursorSdkStallAbortWrapperConnectError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(message).toContain("Network error");
		expect(message).not.toContain("operation was aborted");
	});

	it.each([
		"Connection stalled repeatedly",
		"Connection stalled",
	] as const)("recognizes installed Cursor SDK RetriableError %s as retryable network failure", (stalledMessage) => {
		const error = makeCursorSdkConnectionStalledRetriableError(stalledMessage);
		expect(classifyCursorConnectError(error)).toBeUndefined();
		expect(isCursorSdkConnectionStalledError(error)).toBe(true);
		const message = sanitizeCursorProviderError(error, "test-key");
		expect(message).toContain("Network error");
		expect(message).not.toMatch(/stalled(?: repeatedly)?/i);
	});

	it("classifies Cursor backend unavailable ConnectErrors by code and details", () => {
		const error = makeCursorBackendUnavailableConnectError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-backend-details" });
		expect(message).toContain("Network error");
		expect(message).toContain("failed during network or service I/O");
		expect(message).not.toContain("[unavailable] Error");
	});

	it("recognizes extension-local connect-node network stacks as Cursor provenance", () => {
		expect(classifyCursorConnectError(makeCursorExtensionNetworkConnectError())).toEqual({
			kind: "network",
			source: "cursor-extension-connect-stack",
		});
	});

	it("classifies connect-node-only ECONNRESET stacks separately from provenance-free generic network errors", () => {
		expect(classifyCursorConnectError(makeGenericConnectNodeNetworkConnectError())).toEqual({
			kind: "network",
			source: "connect-node-stack",
		});
		expect(classifyCursorConnectError(makeProvenanceFreeNetworkConnectError())).toEqual({
			kind: "network",
			source: "generic-connect",
		});
	});

	it("formats abort causes deterministically", () => {
		expect(formatCursorSdkAbortMessage(resolveCursorSdkAbortCause({ signalAborted: true }))).toBe(
			"Cancelled: prompt interrupted.",
		);
		expect(formatCursorSdkAbortMessage(resolveCursorSdkAbortCause({ sdkStatusCancelled: true }))).toBe(
			"Cancelled: Cursor SDK run was cancelled.",
		);
		expect(formatCursorSdkAbortMessage(resolveCursorSdkAbortCause({ liveRunDisposed: true }))).toBe(
			"Cancelled: Cursor SDK live run ended before completion.",
		);
	});
});
