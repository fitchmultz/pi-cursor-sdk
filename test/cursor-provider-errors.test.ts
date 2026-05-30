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

describe("cursor-provider-errors", () => {
	it("builds run metadata when SDK result text is the generic failure string", () => {
		const detail = formatCursorSdkRunFailureDetail({
			id: "run-abc123456789",
			status: "error",
			result: "Cursor SDK run failed",
			model: { id: "composer-2.5" },
			durationMs: 1200,
		});

		expect(detail).toContain("model composer-2.5");
		expect(detail).toContain("run run-abc1…");
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

	it("maps connect-layer network timeouts to actionable retry guidance", () => {
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).toContain(
			"timed out during network I/O",
		);
		expect(sanitizeCursorProviderError("ConnectError: read ETIMEDOUT", "test-key")).toContain("Check your connection and retry");
		expect(sanitizeCursorProviderError(new Error("ConnectError: [unavailable] read ETIMEDOUT"), "test-key")).not.toContain(
			"ETIMEDOUT",
		);
	});

	it("classifies Cursor SDK network ConnectErrors without leaking raw network codes", () => {
		const error = makeCursorSdkNetworkConnectError();
		const classification = classifyCursorConnectError(error);
		const message = sanitizeCursorProviderError(error, "test-key");

		expect(classification).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(message).toContain("timed out during network I/O");
		expect(message).toContain("Check your connection and retry");
		expect(message).not.toContain("ECONNRESET");
	});

	it("recognizes extension-local connect-node network stacks as Cursor provenance", () => {
		expect(classifyCursorConnectError(makeCursorExtensionNetworkConnectError())).toEqual({
			kind: "network",
			source: "cursor-extension-connect-stack",
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
