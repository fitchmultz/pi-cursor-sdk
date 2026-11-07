import { describe, expect, it } from "vitest";
import { CursorToolCompletionLedger, getToolFingerprint } from "../src/cursor-provider-turn-tool-ledger.js";

describe("CursorToolCompletionLedger", () => {
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

	// Legacy alias inputs exercise the unknown-tool boundary, not observed SDK callbacks.
	it("keeps ambiguous identical legacy shell starts unless a completion supplies an exact ID", () => {
		const ledger = new CursorToolCompletionLedger();
		const shell = { name: "shell", args: { command: "echo repeated" } };
		ledger.registerStartedToolCall("shell-a", shell);
		ledger.registerStartedToolCall("shell-b", shell);
		expect(ledger.removeStartedToolCallForStep({ ...shell, name: "bash" }, "other-id")).toBeUndefined();
		expect([...ledger.startedToolCallEntries()]).toHaveLength(2);
		expect(ledger.removeStartedToolCallForStep({ ...shell, name: "bash" }, "shell-b")).toBe("shell-b");
		expect(ledger.hasStartedToolCall("shell-a")).toBe(true);
	});

	it("does not reconcile legacy shell aliases with different arguments or bridge tool names", () => {
		const ledger = new CursorToolCompletionLedger();
		ledger.registerStartedToolCall("shell-a", { name: "shell", args: { command: "echo one" } });
		expect(ledger.removeStartedToolCallForStep({ name: "bash", args: { command: "echo two" } }, "other")).toBeUndefined();
		expect(ledger.removeStartedToolCallForStep({ name: "pi__bash", args: { command: "echo one" } }, "other")).toBeUndefined();
		expect(ledger.hasStartedToolCall("shell-a")).toBe(true);
	});
});
