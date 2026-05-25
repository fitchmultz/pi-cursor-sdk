import { describe, expect, it } from "vitest";
import {
	formatCursorSdkAbortMessage,
	formatCursorSdkRunFailureDetail,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "../src/cursor-provider-errors.js";

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
