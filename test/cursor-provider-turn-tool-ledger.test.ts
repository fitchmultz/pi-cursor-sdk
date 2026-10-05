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

	it("keeps ambiguous identical shell starts unless a completion supplies an exact ID", () => {
		const ledger = new CursorToolCompletionLedger();
		const shell = { name: "shell", args: { command: "echo repeated" } };
		ledger.registerStartedToolCall("shell-a", shell);
		ledger.registerStartedToolCall("shell-b", shell);
		expect(ledger.removeStartedToolCallForStep({ ...shell, name: "bash" }, "other-id")).toBeUndefined();
		expect([...ledger.startedToolCallEntries()]).toHaveLength(2);
		expect(ledger.removeStartedToolCallForStep({ ...shell, name: "bash" }, "shell-b")).toBe("shell-b");
		expect(ledger.hasStartedToolCall("shell-a")).toBe(true);
	});

	it("does not reconcile shell aliases with different arguments or bridge tool names", () => {
		const ledger = new CursorToolCompletionLedger();
		ledger.registerStartedToolCall("shell-a", { name: "shell", args: { command: "echo one" } });
		expect(ledger.removeStartedToolCallForStep({ name: "bash", args: { command: "echo two" } }, "other")).toBeUndefined();
		expect(ledger.removeStartedToolCallForStep({ name: "pi__bash", args: { command: "echo one" } }, "other")).toBeUndefined();
		expect(ledger.hasStartedToolCall("shell-a")).toBe(true);
	});

	it("tracks bridge-started call ids separately from normal starts", () => {
		const ledger = new CursorToolCompletionLedger();
		ledger.markBridgeStarted("bridge-1");
		expect(ledger.takeBridgeStartedCallId("bridge-1")).toBe("bridge-1");
		expect(ledger.takeBridgeStartedCallId("bridge-1")).toBeUndefined();
	});
});
