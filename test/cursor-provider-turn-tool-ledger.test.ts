import { describe, expect, it } from "vitest";
import { CursorToolCompletionLedger, getToolFingerprint } from "../src/cursor-provider-turn-tool-ledger.js";

describe("CursorToolCompletionLedger", () => {
	it("suppresses duplicate completions by identity", () => {
		const ledger = new CursorToolCompletionLedger();
		const fingerprint = getToolFingerprint({ toolName: "read", args: { path: "a.ts" }, result: {} });

		ledger.recordCompletedTool({ identity: "cursor-tool:call-1", source: "started", fingerprint });
		expect(
			ledger.shouldSkipDuplicateCompletion({
				identity: "cursor-tool:call-1",
				source: "started",
				fingerprint,
			}),
		).toBe("identity-already-completed");
	});

	it("suppresses started completions when fallback fingerprint already completed", () => {
		const ledger = new CursorToolCompletionLedger();
		const fingerprint = getToolFingerprint({ toolName: "grep", args: { pattern: "x" }, result: {} });

		ledger.recordCompletedTool({ source: "fallback", fingerprint });
		expect(
			ledger.shouldSkipDuplicateCompletion({
				identity: "cursor-tool:call-2",
				source: "started",
				fingerprint,
			}),
		).toBe("fallback-fingerprint-already-completed");
	});

	it("matches started tool calls by fingerprint for step completions", () => {
		const ledger = new CursorToolCompletionLedger();
		const toolCall = { toolName: "shell", args: { command: "echo hi" } };
		ledger.registerStartedToolCall("call-a", toolCall);

		expect(ledger.removeStartedToolCallForStep(toolCall, "other-id")).toBe("call-a");
		expect(ledger.hasStartedToolCall("call-a")).toBe(false);
	});

	it("tracks bridge-started call ids separately from normal starts", () => {
		const ledger = new CursorToolCompletionLedger();
		ledger.markBridgeStarted("bridge-1");
		expect(ledger.takeBridgeStartedCallId("bridge-1")).toBe("bridge-1");
		expect(ledger.takeBridgeStartedCallId("bridge-1")).toBeUndefined();
	});

	it("tracks completed tool names for narration cross-checks and keeps them across started-call clear", () => {
		const ledger = new CursorToolCompletionLedger();
		const fingerprint = getToolFingerprint({ toolName: "Shell", args: { command: "pwd" }, result: {} });
		ledger.recordCompletedTool({
			identity: "cursor-tool:call-9",
			source: "started",
			fingerprint,
			toolName: "Shell",
		});
		expect(ledger.completedToolCount()).toBe(1);
		expect(ledger.hasAnyCompletedTool()).toBe(true);
		expect([...ledger.getCompletedToolNames()]).toEqual(["Shell"]);
		ledger.registerStartedToolCall("pending", { toolName: "read" });
		ledger.clearStartedToolCalls();
		expect(ledger.hasStartedToolCall("pending")).toBe(false);
		expect(ledger.completedToolCount()).toBe(1);
		expect([...ledger.getCompletedToolNames()]).toEqual(["Shell"]);
		ledger.clear();
		expect(ledger.completedToolCount()).toBe(0);
		expect(ledger.hasAnyCompletedTool()).toBe(false);
	});
});
