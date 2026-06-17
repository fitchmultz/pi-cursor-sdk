import { describe, expect, it } from "vitest";
import {
	classifyCursorConnectError,
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

function makeCursorSdkHttp2EnhanceYourCalmError(): Error & { rawMessage: string; code: number; cause: unknown } {
	const error = new Error("[unknown] [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM") as Error & {
		rawMessage: string;
		code: number;
		cause: unknown;
	};
	error.name = "ConnectError";
	error.rawMessage = "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM";
	error.code = 2;
	error.cause = Object.assign(new Error("Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), {
		name: "ConnectError",
		rawMessage: "Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
		code: 13,
		cause: Object.assign(new Error("Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), { code: "ERR_HTTP2_STREAM_ERROR" }),
	});
	error.stack =
		"ConnectError: [unknown] [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM\n" +
		"    at file:///Users/example/.pi/agent/npm/node_modules/@cursor/sdk/dist/esm/index.js:1:1125976";
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

	it("falls back to run.result when wait result text is generic", () => {
		const detail = formatCursorSdkRunFailureDetail(
			{ id: "run-2", status: "error", result: "Cursor SDK run failed" },
			"ConnectError: read ETIMEDOUT",
		);

		expect(detail).toBe("ConnectError: read ETIMEDOUT");
	});

	it("scrubs secrets and maps generic startup errors to actionable auth guidance", () => {
		expect(sanitizeCursorProviderError(new Error("Error"), "test-key")).toContain("Cursor SDK request failed");
		expect(sanitizeCursorProviderError(new Error("Unauthorized Bearer secret-key"), "secret-key")).toContain(
			"invalid or unauthorized",
		);
		expect(sanitizeCursorProviderError(new Error("Bearer secret-key"), "secret-key")).not.toContain("secret-key");
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

	it("maps Cursor SDK unauthenticated ConnectError to actionable auth guidance", () => {
		const error = makeUnauthenticatedConnectError();
		const message = sanitizeCursorProviderError(error, "secret-key");

		expect(isUnauthenticatedConnectError(error)).toBe(true);
		expect(message).toContain("invalid or unauthorized");
		expect(message).toContain("/login");
		expect(message).toContain("CURSOR_API_KEY");
		expect(message).not.toContain("secret-key");
		expect(message).not.toContain("Bearer");
	});

	it("maps connect-layer network failures to actionable retry guidance", () => {
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).toContain(
			"Network error",
		);
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).toContain(
			"failed during network or service I/O",
		);
		expect(sanitizeCursorProviderError("ConnectError: read ETIMEDOUT", "test-key")).toContain("pi will retry automatically");
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
		expect(message).toContain("pi will retry automatically");
		expect(message).not.toContain("ECONNRESET");
	});

	it("classifies HTTP/2 ENHANCE_YOUR_CALM stream resets as retryable network errors", () => {
		const error = makeCursorSdkHttp2EnhanceYourCalmError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(message).toContain("Network error");
		expect(message).toContain("pi will retry automatically");
		expect(message).not.toContain("ENHANCE_YOUR_CALM");
	});

	it("classifies Cursor backend unavailable ConnectErrors by code and details", () => {
		const error = makeCursorBackendUnavailableConnectError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-backend-details" });
		expect(message).toContain("Network error");
		expect(message).toContain("failed during network or service I/O");
		expect(message).toContain("pi will retry automatically");
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
